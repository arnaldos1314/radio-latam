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

// ---------- Populares de LATAM (top por pais combinado, cache 1h) ----------
let popularesCache = { data: null, ts: 0 };
const POP_TTL = 3600000;
const POP_COUNTRIES = ['MX','CO','AR','VE','CL','PE','EC','DO','GT','PR'];

function httpsGetJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'RadioLatam/1.0' }, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve([]); } });
    }).on('error', () => resolve([])).on('timeout', function(){ this.destroy(); resolve([]); });
  });
}

async function getPopulares() {
  if (popularesCache.data && Date.now() - popularesCache.ts < POP_TTL) return popularesCache.data;
  const perCountry = await Promise.all(POP_COUNTRIES.map((cc) =>
    httpsGetJson('https://de1.api.radio-browser.info/json/stations/search?countrycode=' + cc + '&order=clickcount&reverse=true&hidebroken=true&limit=3')
  ));
  const seen = new Set();
  const out = [];
  perCountry.forEach((list) => {
    (list || []).forEach((s) => {
      if (s.url_resolved && !seen.has(s.stationuuid)) { seen.add(s.stationuuid); out.push(s); }
    });
  });
  popularesCache = { data: out, ts: Date.now() };
  return out;
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


  if (u.pathname === '/api/populares') {
    const pop = await getPopulares();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(pop));
  }


  // Proxy a Radio-Browser (evita CORS)
  if (u.pathname === '/api/stations') {
    const qs = u.search || '';
    const rbUrl = 'https://de1.api.radio-browser.info/json/stations/search' + qs;
    const data = await httpsGetJson(rbUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data || []));
  }

  let filePath = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!filePath.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    // No cachear HTML (para que los cambios se vean de inmediato)
    if (filePath.endsWith('.html') || u.pathname === '/') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Radio LATAM backend en puerto ' + PORT));
