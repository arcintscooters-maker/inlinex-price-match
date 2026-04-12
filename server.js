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
