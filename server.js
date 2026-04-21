/**
 * Inlinex Price Match — Web Server for Railway
 *
 * Serves the dashboard and provides API endpoints to trigger price match runs.
 * Replaces GitHub Actions — runs directly on Railway.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;

let currentRun = null; // { status, startedAt, logs, pid }
let pendingMappingPush = false;
let pendingShippingPush = false;

// --- Mapping write serialization + auto-push ---
// All writes to manual-mappings.json go through mappingWriteQueue to prevent
// concurrent writes from racing with each other. After each write we schedule
// a debounced push to GitHub so the user never has to "remember to push".
let mappingWriteQueue = Promise.resolve();
let pushDebounceTimer = null;
let pushInFlight = false;
let pushQueuedAgain = false;

function queueMappingWrite(fn) {
  mappingWriteQueue = mappingWriteQueue.then(fn, fn); // run on both success+reject
  return mappingWriteQueue;
}

// Atomic write: write to tempfile then rename. Protects against partial writes.
function writeMappingsAtomic(data) {
  const mappingFile = path.join(__dirname, 'manual-mappings.json');
  const tmp = mappingFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, mappingFile);
}

// Schedule a debounced push to GitHub. Multiple rapid saves collapse into one push.
function scheduleMappingPush(delay = 3000) {
  if (!process.env.GITHUB_TOKEN) return; // no-op if GitHub token not configured
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(async () => {
    pushDebounceTimer = null;
    if (pushInFlight) { pushQueuedAgain = true; return; }
    pushInFlight = true;
    try {
      await pushFilesToGitHub();
    } catch (e) {
      console.log('[SERVER] Auto-push failed:', e.message || e);
    } finally {
      pushInFlight = false;
      if (pushQueuedAgain) { pushQueuedAgain = false; scheduleMappingPush(500); }
    }
  }, delay);
}

// Push the current manual-mappings.json (and brand-pages + shipping if pending) to GitHub.
// Reads fresh from disk at push time so no racey in-memory snapshots.
async function pushFilesToGitHub() {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN not set');
  const repo = 'arcintscooters-maker/inlinex-price-match';
  const ghApi = (method, apiPath, body2) => new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': 'price-match', 'Authorization': `token ${ghToken}`, 'Content-Type': 'application/json' }
    };
    if (body2) opts.headers['Content-Length'] = Buffer.byteLength(body2);
    const r = require('https').request(opts, r2 => {
      let d = ''; r2.on('data', c => d += c);
      r2.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject);
    if (body2) r.write(body2);
    r.end();
  });
  // Mappings
  if (pendingMappingPush) {
    const mf = path.join(__dirname, 'manual-mappings.json');
    const mfContent = fs.readFileSync(mf, 'utf8');
    const mfGh = await ghApi('GET', `/repos/${repo}/contents/manual-mappings.json`);
    await ghApi('PUT', `/repos/${repo}/contents/manual-mappings.json`, JSON.stringify({
      message: 'Update manual mappings from dashboard [skip ci]',
      content: Buffer.from(mfContent).toString('base64'),
      sha: mfGh.sha
    }));
    pendingMappingPush = false;
    console.log('[SERVER] Auto-pushed manual-mappings.json to GitHub');
  }
  // Brand pages
  try {
    const bpFile = path.join(__dirname, 'brand-pages.json');
    const bpContent = fs.readFileSync(bpFile, 'utf8');
    const bpGh = await ghApi('GET', `/repos/${repo}/contents/brand-pages.json`);
    if (Buffer.from(bpGh.content || '', 'base64').toString('utf8') !== bpContent) {
      await ghApi('PUT', `/repos/${repo}/contents/brand-pages.json`, JSON.stringify({
        message: 'Update brand pages from dashboard [skip ci]',
        content: Buffer.from(bpContent).toString('base64'),
        sha: bpGh.sha
      }));
      console.log('[SERVER] Auto-pushed brand-pages.json to GitHub');
    }
  } catch (e) { console.log('[SERVER] Brand pages push skipped:', e.message); }
  // Shipping overrides
  if (pendingShippingPush) {
    try {
      const shipFile = path.join(__dirname, 'shipping-overrides.json');
      const shipContent = fs.readFileSync(shipFile, 'utf8');
      const shipGh = await ghApi('GET', `/repos/${repo}/contents/shipping-overrides.json`);
      await ghApi('PUT', `/repos/${repo}/contents/shipping-overrides.json`, JSON.stringify({
        message: 'Update shipping overrides from dashboard [skip ci]',
        content: Buffer.from(shipContent).toString('base64'),
        sha: shipGh.sha
      }));
      pendingShippingPush = false;
      console.log('[SERVER] Auto-pushed shipping-overrides.json to GitHub');
    } catch (e) { console.log('[SERVER] Shipping push failed:', e.message); }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- API Routes ---

  // Trigger a run
  if (url.pathname === '/api/run' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (currentRun && currentRun.status === 'running') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A run is already in progress', startedAt: currentRun.startedAt }));
        return;
      }

      let params;
      try { params = JSON.parse(body || '{}'); } catch { params = {}; }

      const args = [];
      if (params.dry_run === true || params.dry_run === 'true') args.push('--dry-run');
      if (params.brands) args.push(`--brands=${params.brands}`);
      if (params.markets) args.push(`--markets=${params.markets}`);
      if (params.source) args.push(`--source=${params.source}`);

      console.log(`[SERVER] Starting run: node price-match.js ${args.join(' ')}`);

      currentRun = {
        status: 'running',
        startedAt: new Date().toISOString(),
        logs: '',
        params,
      };

      // Snapshot manual-mappings.json mtime so we can detect if the matcher
      // rewrote it during the run (auto-rebind of rotated xtremeinn SKUs).
      const mappingFileForWatch = path.join(__dirname, 'manual-mappings.json');
      let mappingMtimeBefore = 0;
      try { mappingMtimeBefore = fs.statSync(mappingFileForWatch).mtimeMs; } catch {}

      const proc = spawn('node', ['price-match.js', ...args], {
        cwd: __dirname,
        env: { ...process.env },
      });

      proc.stdout.on('data', d => {
        const s = d.toString();
        currentRun.logs += s;
        process.stdout.write(s); // mirror to Railway container logs
      });
      proc.stderr.on('data', d => {
        const s = d.toString();
        currentRun.logs += s;
        process.stderr.write(s); // mirror to Railway container logs
      });

      proc.on('close', code => {
        currentRun.status = code === 0 ? 'success' : 'error';
        currentRun.exitCode = code;
        currentRun.completedAt = new Date().toISOString();
        console.log(`[SERVER] Run completed: ${currentRun.status}`);

        // If the matcher rebound rotated SKUs into manual-mappings.json,
        // flag push and auto-schedule so user never has to click "push".
        try {
          const mtimeAfter = fs.statSync(mappingFileForWatch).mtimeMs;
          if (mtimeAfter > mappingMtimeBefore) {
            pendingMappingPush = true;
            console.log('[SERVER] manual-mappings.json updated during run — auto-push scheduled');
            scheduleMappingPush(1000);
          }
        } catch {}
      });

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Run started', params }));
    });
    return;
  }

  // Get run status
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (currentRun) {
      const elapsed = (Date.now() - new Date(currentRun.startedAt)) / 1000;
      res.end(JSON.stringify({
        status: currentRun.status,
        startedAt: currentRun.startedAt,
        completedAt: currentRun.completedAt || null,
        elapsed: Math.round(elapsed),
        params: currentRun.params,
        logLines: currentRun.logs.split('\n').length,
      }));
    } else {
      res.end(JSON.stringify({ status: 'idle' }));
    }
    return;
  }

  // Save a manual mapping (block while a run is in progress to prevent
  // the matcher's rebind writes from racing with dashboard edits)
  if (url.pathname === '/api/mapping' && req.method === 'POST') {
    if (currentRun && currentRun.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot edit mappings while a run is in progress' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { source, sku, shopifyMatch } = JSON.parse(body);
        if (!source || !sku || !shopifyMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing source, sku, or shopifyMatch' }));
          return;
        }

        await queueMappingWrite(() => {
          const mappingFile = path.join(__dirname, 'manual-mappings.json');
          const data = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
          const exactMatch = data.mappings.find(m =>
            (m.source || 'iw') === source &&
            (m.sku || m.iwSku) === sku &&
            m.shopifyMatch === shopifyMatch
          );
          if (!exactMatch) {
            data.mappings.push({ source, sku, shopifyMatch, note: 'Added from dashboard' });
          }
          writeMappingsAtomic(data);
          console.log(`[SERVER] Mapping saved: ${source}:${sku} -> "${shopifyMatch}"`);
          pendingMappingPush = true;
        });
        scheduleMappingPush();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, autoPush: !!process.env.GITHUB_TOKEN }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Manual "Push All to GitHub" — rarely needed now that auto-push is on,
  // but kept for explicit user-triggered pushes.
  if (url.pathname === '/api/push-mappings' && req.method === 'POST') {
    if (!process.env.GITHUB_TOKEN) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GITHUB_TOKEN not set' }));
      return;
    }
    (async () => {
      try {
        // Force push even if flag isn't set (user clicked explicitly)
        pendingMappingPush = true;
        await pushFilesToGitHub();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Pushed to GitHub' }));
      } catch (e) {
        console.log('[SERVER] Manual push failed:', e.message || e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Push failed' }));
      }
    })();
    return;
  }

  // Pending-push status (dashboard uses this to show "saving..." indicator)
  if (url.pathname === '/api/push-status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pending: !!pendingMappingPush,
      inFlight: pushInFlight,
      scheduled: !!pushDebounceTimer,
      hasToken: !!process.env.GITHUB_TOKEN,
    }));
    return;
  }

  // --- Get all mappings ---
  if (url.pathname === '/api/mappings' && req.method === 'GET') {
    const file = path.join(__dirname, 'manual-mappings.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mappings: [] }));
    }
    return;
  }

  // Delete a mapping
  if (url.pathname === '/api/mapping-delete' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { source, sku, shopifyMatch } = JSON.parse(body);
        await queueMappingWrite(() => {
          const file = path.join(__dirname, 'manual-mappings.json');
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          data.mappings = data.mappings.filter(m => {
            const matchesSrc = (m.source || 'iw') === source;
            const matchesSku = (m.sku || m.iwSku) === sku;
            if (!matchesSrc || !matchesSku) return true;
            if (shopifyMatch) return m.shopifyMatch !== shopifyMatch;
            return false;
          });
          writeMappingsAtomic(data);
          pendingMappingPush = true;
          console.log(`[SERVER] Mapping deleted: ${source}:${sku}${shopifyMatch ? ' -> ' + shopifyMatch : ' (all)'}`);
        });
        scheduleMappingPush();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Shopify product titles (for remap auto-suggest) ---
  if (url.pathname === '/api/shopify-titles' && req.method === 'GET') {
    const file = path.join(__dirname, 'docs', 'shopify-titles.json');
    try {
      const content = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(content);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ products: [], message: 'No titles yet — run a dry run first' }));
    }
    return;
  }

  // --- Brand Pages ---

  if (url.pathname === '/api/brand-pages' && req.method === 'GET') {
    const file = path.join(__dirname, 'brand-pages.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ brands: {} }));
    }
    return;
  }

  if (url.pathname === '/api/brand-page' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { brand, url: pageUrl } = JSON.parse(body);
        if (!brand) { res.writeHead(400); res.end('{"error":"Missing brand"}'); return; }

        const file = path.join(__dirname, 'brand-pages.json');
        let data;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = { brands: {} }; }

        if (pageUrl) {
          data.brands[brand] = pageUrl;
          console.log(`[SERVER] Brand page: ${brand} = ${pageUrl}`);
        } else {
          delete data.brands[brand];
          console.log(`[SERVER] Brand page removed: ${brand}`);
        }

        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        pendingMappingPush = true; // piggyback on Push All

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Shipping Overrides ---

  // Get shipping overrides
  if (url.pathname === '/api/shipping-overrides' && req.method === 'GET') {
    const file = path.join(__dirname, 'shipping-overrides.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ overrides: {} }));
    }
    return;
  }

  // Save shipping override
  if (url.pathname === '/api/shipping-override' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { productTitle, shippingFee } = JSON.parse(body);
        if (!productTitle || shippingFee === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing productTitle or shippingFee' }));
          return;
        }

        const file = path.join(__dirname, 'shipping-overrides.json');
        const tmp = file + '.tmp';
        let data;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = { overrides: {} }; }
        data.overrides[productTitle] = parseFloat(shippingFee);
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, file);
        console.log(`[SERVER] Shipping override: "${productTitle}" = ${shippingFee}`);
        pendingShippingPush = true;
        scheduleMappingPush();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, autoPush: !!process.env.GITHUB_TOKEN }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Apply Selected Prices ---

  if (url.pathname === '/api/apply-selected' && req.method === 'POST') {
    if (currentRun && currentRun.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A run is in progress' }));
      return;
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { selections } = JSON.parse(body);
        if (!selections || !selections.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No selections' }));
          return;
        }

        const shopify = require('./lib/shopify');
        const { log } = require('./lib/utils');

        log('SERVER', `Applying ${selections.length} selected prices...`);
        const { usPriceList, auPriceList, idPriceList, phPriceList, jpPriceList, caPriceList } = await shopify.getMarketPriceLists();

        // Group by market
        const usItems = selections.filter(s => s.market === 'US').map(s => ({
          variantId: s.variantGid, price: s.newPrice, currency: 'USD'
        }));
        const auItems = selections.filter(s => s.market === 'AU').map(s => ({
          variantId: s.variantGid, price: s.newPrice, currency: 'AUD'
        }));
        const idItems = selections.filter(s => s.market === 'ID').map(s => ({
          variantId: s.variantGid, price: s.newPrice, currency: 'IDR'
        }));
        const phItems = selections.filter(s => s.market === 'PH').map(s => ({
          variantId: s.variantGid, price: s.newPrice, currency: 'PHP'
        }));
        const jpItems = selections.filter(s => s.market === 'JP').map(s => ({
          variantId: s.variantGid, price: s.newPrice, currency: 'JPY'
        }));
        const caItems = selections.filter(s => s.market === 'CA').map(s => ({
          variantId: s.variantGid, price: s.newPrice, currency: 'CAD'
        }));

        // Log what was dropped so "Applied 0" is never a mystery
        const known = usItems.length + auItems.length + idItems.length + phItems.length + jpItems.length + caItems.length;
        if (known < selections.length) {
          const dropped = selections.filter(s => !['US','AU','ID','PH','JP','CA'].includes(s.market));
          log('SERVER', `WARNING: dropped ${selections.length - known} selections with unknown markets: ${[...new Set(dropped.map(s => s.market))].join(', ')}`);
        }

        let applied = 0;
        if (usItems.length > 0 && usPriceList) {
          await shopify.setFixedPrices(usPriceList.id, usItems);
          applied += usItems.length;
          log('SERVER', `Applied ${usItems.length} US prices`);
        } else if (usItems.length > 0) {
          log('SERVER', `SKIPPED ${usItems.length} US prices: US price list not found in Shopify`);
        }
        if (auItems.length > 0 && auPriceList) {
          await shopify.setFixedPrices(auPriceList.id, auItems);
          applied += auItems.length;
          log('SERVER', `Applied ${auItems.length} AU prices`);
        } else if (auItems.length > 0) {
          log('SERVER', `SKIPPED ${auItems.length} AU prices: AU price list not found in Shopify`);
        }
        if (idItems.length > 0 && idPriceList) {
          await shopify.setFixedPrices(idPriceList.id, idItems);
          applied += idItems.length;
          log('SERVER', `Applied ${idItems.length} ID prices`);
        } else if (idItems.length > 0) {
          log('SERVER', `SKIPPED ${idItems.length} ID prices: ID price list not found in Shopify`);
        }
        if (phItems.length > 0 && phPriceList) {
          await shopify.setFixedPrices(phPriceList.id, phItems);
          applied += phItems.length;
          log('SERVER', `Applied ${phItems.length} PH prices`);
        } else if (phItems.length > 0) {
          log('SERVER', `SKIPPED ${phItems.length} PH prices: PH price list not found in Shopify (create a PHP price list in Shopify Markets settings)`);
        }
        if (jpItems.length > 0 && jpPriceList) {
          await shopify.setFixedPrices(jpPriceList.id, jpItems);
          applied += jpItems.length;
          log('SERVER', `Applied ${jpItems.length} JP prices`);
        } else if (jpItems.length > 0) {
          log('SERVER', `SKIPPED ${jpItems.length} JP prices: JP price list not found in Shopify (create a JPY price list in Shopify Markets settings)`);
        }
        if (caItems.length > 0 && caPriceList) {
          await shopify.setFixedPrices(caPriceList.id, caItems);
          applied += caItems.length;
          log('SERVER', `Applied ${caItems.length} CA prices`);
        } else if (caItems.length > 0) {
          log('SERVER', `SKIPPED ${caItems.length} CA prices: CA price list not found in Shopify (create a CAD price list in Shopify Markets settings)`);
        }

        // Update status.json — mark selected items as applied
        const statusFile = path.join(__dirname, 'docs', 'status.json');
        try {
          const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
          const gidSet = new Set(selections.map(s => s.variantGid));
          for (const c of status.priceChanges) {
            if (c.variantGid && gidSet.has(c.variantGid)) {
              c.applied = true;
              c.skipped = false;
            }
          }
          fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
        } catch (e) {
          console.log('[SERVER] Failed to update status.json:', e.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Preview what would be reset without deleting
  if (url.pathname.startsWith('/api/preview-reset-prices/') && req.method === 'GET') {
    const market = url.pathname.split('/').pop().toUpperCase();
    if (!['US', 'AU', 'ID', 'PH', 'JP', 'CA'].includes(market)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'market must be US, AU, ID, PH, JP, or CA' }));
      return;
    }
    (async () => {
      try {
        const shopify = require('./lib/shopify');
        const pl = await shopify.getMarketPriceLists();
        const keyMap = { US: 'usPriceList', AU: 'auPriceList', ID: 'idPriceList', PH: 'phPriceList', JP: 'jpPriceList', CA: 'caPriceList' };
        const priceList = pl[keyMap[market]];
        if (!priceList) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `${market} price list not found` }));
          return;
        }
        const fixed = await shopify.getFixedPrices(priceList.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          market,
          priceListName: priceList.name,
          fixedPriceCount: Object.keys(fixed).length,
          message: `${Object.keys(fixed).length} fixed ${market} prices currently set. If you click Reset, they will all be deleted and variants will fall back to Shopify's default ${market} pricing.`
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // Reset all fixed prices for a market (fallback to shop default)
  if (url.pathname === '/api/reset-market-prices' && req.method === 'POST') {
    if (currentRun && currentRun.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A run is in progress' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { market } = JSON.parse(body);
        if (!['US', 'AU', 'ID', 'PH', 'JP', 'CA'].includes((market || '').toUpperCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'market must be US, AU, ID, PH, JP, or CA' }));
          return;
        }
        const shopify = require('./lib/shopify');
        const pl = await shopify.getMarketPriceLists();
        const keyMap = { US: 'usPriceList', AU: 'auPriceList', ID: 'idPriceList', PH: 'phPriceList', JP: 'jpPriceList', CA: 'caPriceList' };
        const priceList = pl[keyMap[market.toUpperCase()]];
        if (!priceList) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `${market} price list not found in Shopify` }));
          return;
        }
        const fixed = await shopify.getFixedPrices(priceList.id);
        const variantIds = Object.keys(fixed);
        if (variantIds.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deleted: 0, message: 'price list was already empty' }));
          return;
        }
        const deleted = await shopify.deleteFixedPrices(priceList.id, variantIds);
        console.log(`[SERVER] Reset ${market}: deleted ${deleted.length} fixed prices`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: deleted.length }));
      } catch (e) {
        console.log('[SERVER] Reset failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Get run logs
  if (url.pathname === '/api/logs') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(currentRun ? currentRun.logs : 'No run yet');
    return;
  }

  // --- Static file serving (dashboard) ---

  let filePath;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    filePath = path.join(__dirname, 'docs', 'index.html');
  } else if (url.pathname === '/status.json') {
    filePath = path.join(__dirname, 'docs', 'status.json');
  } else {
    filePath = path.join(__dirname, 'docs', url.pathname);
  }

  // Security: prevent path traversal
  if (!filePath.startsWith(path.join(__dirname, 'docs'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[SERVER] Inlinex Price Match running on port ${PORT}`);
  // Startup env check — surface missing vars in Railway container logs instead
  // of waiting for the next run to fail cryptically.
  const required = ['SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_STORE'];
  const optional = ['GITHUB_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  const missingOptional = optional.filter(k => !process.env[k]);
  if (missing.length) console.log(`[SERVER] WARNING: missing required env vars: ${missing.join(', ')} — runs will fail`);
  if (missingOptional.length) console.log(`[SERVER] WARNING: missing optional env vars: ${missingOptional.join(', ')} — auto-push to GitHub disabled`);
  if (!missing.length && !missingOptional.length) console.log(`[SERVER] All env vars present`);
});
