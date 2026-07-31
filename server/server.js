const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 5055;
const ROOT = __dirname;
const WEB  = path.join(ROOT, '..');
const EMISORAS_FILE = path.join(ROOT, 'emisoras_ve.json');

const healthCache = new Map();
const HEALTH_TTL = 60000;

function checkAlive(streamUrl) {
  return new Promise((resolve) => {
    const cached = healthCache.get(streamUrl);
    if (cached && Date.now() - cached.ts < HEALTH_TTL) return resolve(cached.alive);
    let urlObj;
    try { urlObj = new URL(streamUrl); } catch { return resolve(false); }
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.get(streamUrl, { headers: { 'User-Agent': 'RadioLatam/1.0', 'Icy-MetaData': '1' }, timeout: 6000 }, (res) => {
      const ct = (res.headers['content-type'] || '').toLowerCase();
      const alive = ct.includes('audio') || ct.includes('ogg') || ct.includes('mpeg');
      res.destroy();
      healthCache.set(streamUrl, { alive, ts: Date.now() });
      resolve(alive);
    });
    req.on('error', () => { healthCache.set(streamUrl, { alive: false, ts: Date.now() }); resolve(false); });
    req.on('timeout', () => { req.destroy(); healthCache.set(streamUrl, { alive: false, ts: Date.now() }); resolve(false); });
  });
}

function fetchIcyMetadata(streamUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    let urlObj;
    try { urlObj = new URL(streamUrl); } catch { return done(null); }
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.get(streamUrl, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'RadioLatam/1.0' }, timeout: 8000 }, (res) => {
      const metaInt = parseInt(res.headers['icy-metaint'], 10);
      const icyName = res.headers['icy-name'] || '';
      const icyDesc = res.headers['icy-description'] || '';
      if (!metaInt || isNaN(metaInt)) { res.destroy(); return done({ title: '', name: icyName, description: icyDesc }); }
      let bytes = 0, collecting = false, metaLenByte = null, metaBuf = Buffer.alloc(0), metaBytesLeft = 0;
      res.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          if (!collecting && metaLenByte === null) {
            bytes++;
            if (bytes > metaInt) { metaLenByte = chunk[i]; metaBytesLeft = metaLenByte * 16; bytes = 0;
              if (metaBytesLeft === 0) { metaLenByte = null; } else { collecting = true; metaBuf = Buffer.alloc(0); } }
          } else if (collecting) {
            metaBuf = Buffer.concat([metaBuf, Buffer.from([chunk[i]])]); metaBytesLeft--;
            if (metaBytesLeft <= 0) {
              const m = metaBuf.toString('utf8').match(/StreamTitle='([^']*)'/);
              res.destroy(); return done({ title: m ? m[1].trim() : '', name: icyName, description: icyDesc });
            }
          }
        }
      });
      res.on('error', () => done({ title: '', name: icyName, description: icyDesc }));
      res.on('end', () => done({ title: '', name: icyName, description: icyDesc }));
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
  });
}

const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (u.pathname === '/api/nowplaying') {
    const stream = u.searchParams.get('url');
    if (!stream) { res.writeHead(400); return res.end('{"error":"falta url"}'); }
    const meta = await fetchIcyMetadata(stream);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(meta || { title: '', name: '', description: '' }));
  }

  if (u.pathname === '/api/emisoras-ve') {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(EMISORAS_FILE, 'utf8')); } catch {}
    const checked = await Promise.all(list.map(async (e) => ({ e, alive: await checkAlive(e.url_resolved) })));
    const alive = checked.filter((x) => x.alive).map((x) => x.e);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(alive));
  }

  let filePath = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!filePath.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Radio LATAM backend en puerto ' + PORT));
