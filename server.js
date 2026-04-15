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

      const proc = spawn('node', ['price-match.js', ...args], {
        cwd: __dirname,
        env: { ...process.env },
      });

      proc.stdout.on('data', d => { currentRun.logs += d.toString(); });
      proc.stderr.on('data', d => { currentRun.logs += d.toString(); });

      proc.on('close', code => {
        currentRun.status = code === 0 ? 'success' : 'error';
        currentRun.exitCode = code;
        currentRun.completedAt = new Date().toISOString();
        console.log(`[SERVER] Run completed: ${currentRun.status}`);
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

  // Save a manual mapping
  if (url.pathname === '/api/mapping' && req.method === 'POST') {
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

        const mappingFile = path.join(__dirname, 'manual-mappings.json');
        const data = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));

        const exists = data.mappings.find(m => (m.source || 'iw') === source && (m.sku || m.iwSku) === sku);
        if (exists) {
          exists.shopifyMatch = shopifyMatch;
        } else {
          data.mappings.push({ source, sku, shopifyMatch, note: 'Added from dashboard' });
        }

        const newContent = JSON.stringify(data, null, 2);
        fs.writeFileSync(mappingFile, newContent);
        console.log(`[SERVER] Mapping saved locally: ${source}:${sku} -> "${shopifyMatch}"`);
        pendingMappingPush = true;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Push all pending mappings to GitHub (batch — won't trigger redeploy until user clicks)
  if (url.pathname === '/api/push-mappings' && req.method === 'POST') {
    const ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GITHUB_TOKEN not set' }));
      return;
    }
    if (!pendingMappingPush) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'No pending changes' }));
      return;
    }

    (async () => {
      try {
        const mappingFile = path.join(__dirname, 'manual-mappings.json');
        const newContent = fs.readFileSync(mappingFile, 'utf8');

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

        const repo = 'arcintscooters-maker/inlinex-price-match';
        const file = await ghApi('GET', `/repos/${repo}/contents/manual-mappings.json`);
        await ghApi('PUT', `/repos/${repo}/contents/manual-mappings.json`, JSON.stringify({
          message: 'Update manual mappings from dashboard [skip ci]',
          content: Buffer.from(newContent).toString('base64'),
          sha: file.sha
        }));
        pendingMappingPush = false;
        console.log('[SERVER] Mappings pushed to GitHub');

        // Also push brand-pages.json
        try {
          const bpFile = path.join(__dirname, 'brand-pages.json');
          const bpContent = fs.readFileSync(bpFile, 'utf8');
          const bpGh = await ghApi('GET', `/repos/${repo}/contents/brand-pages.json`);
          await ghApi('PUT', `/repos/${repo}/contents/brand-pages.json`, JSON.stringify({
            message: 'Update brand pages from dashboard [skip ci]',
            content: Buffer.from(bpContent).toString('base64'),
            sha: bpGh.sha
          }));
          console.log('[SERVER] Brand pages pushed to GitHub');
        } catch (e2) {
          console.log('[SERVER] Brand pages push failed:', e2.message || e2);
        }

        // Also push shipping overrides if pending
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
            console.log('[SERVER] Shipping overrides pushed to GitHub');
          } catch (e2) {
            console.log('[SERVER] Shipping push failed:', e2.message || e2);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Pushed to GitHub' }));
      } catch (e) {
        console.log('[SERVER] GitHub push failed:', e.message || e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Push failed' }));
      }
    })();
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
    req.on('end', () => {
      try {
        const { source, sku } = JSON.parse(body);
        const file = path.join(__dirname, 'manual-mappings.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        data.mappings = data.mappings.filter(m => !((m.source || 'iw') === source && (m.sku || m.iwSku) === sku));
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        pendingMappingPush = true;
        console.log(`[SERVER] Mapping deleted: ${source}:${sku}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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
        let data;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = { overrides: {} }; }
        data.overrides[productTitle] = parseFloat(shippingFee);
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        console.log(`[SERVER] Shipping override: "${productTitle}" = ${shippingFee}`);
        pendingShippingPush = true;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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
        const { usPriceList, auPriceList, idPriceList } = await shopify.getMarketPriceLists();

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

        let applied = 0;
        if (usItems.length > 0 && usPriceList) {
          await shopify.setFixedPrices(usPriceList.id, usItems);
          applied += usItems.length;
          log('SERVER', `Applied ${usItems.length} US prices`);
        }
        if (auItems.length > 0 && auPriceList) {
          await shopify.setFixedPrices(auPriceList.id, auItems);
          applied += auItems.length;
          log('SERVER', `Applied ${auItems.length} AU prices`);
        }
        if (idItems.length > 0 && idPriceList) {
          await shopify.setFixedPrices(idPriceList.id, idItems);
          applied += idItems.length;
          log('SERVER', `Applied ${idItems.length} ID prices`);
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
});
