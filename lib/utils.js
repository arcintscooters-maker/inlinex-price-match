const fs = require('fs');
const https = require('https');
const http = require('http');

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function saveJSON(file, data) {
  // Write to temp file then rename — atomic on most OSes, prevents
  // corruption if the process crashes mid-write.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function log(prefix, msg) {
  console.log(`[${prefix}] ${new Date().toISOString()} ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(url, headers = {}, _redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = new URL(url);

    const req = mod.get({
      hostname: options.hostname,
      path: options.pathname + options.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (_redirectsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`));
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return httpGet(redirectUrl, headers, _redirectsLeft - 1).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    const req = https.request({
      hostname: options.hostname,
      path: options.pathname + options.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.write(bodyStr);
    req.end();
  });
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Token-based similarity (better for product names)
  const tokensA = new Set(na.split(' '));
  const tokensB = new Set(nb.split(' '));
  const intersection = [...tokensA].filter(t => tokensB.has(t));
  const union = new Set([...tokensA, ...tokensB]);
  const jaccard = intersection.length / union.size;

  // Also check if one contains the other
  const containsScore = na.includes(nb) || nb.includes(na) ? 0.3 : 0;

  return Math.min(1, jaccard + containsScore);
}

module.exports = { loadJSON, saveJSON, log, sleep, httpGet, httpPost, normalize, similarity };
