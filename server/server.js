// server.js - Backend Radio LATAM
// Endpoints:
//   /api/stations    -> proxy a Radio-Browser (evita CORS)
//   /api/logo?url=   -> proxy de logos (evita CORS en imagenes y permite color dinamico)
//   /api/nowplaying  -> metadatos ICY (cancion sonando)
//   /api/emisoras-ve -> lista curada VE, filtrada por health check
//   /api/populares   -> top por pais combinado (LATAM)
// Sirve tambien los archivos estaticos (index.html, manifest.json)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 5055;
const ROOT = __dirname;
const WEB = path.join(ROOT, '..');
const EMISORAS_FILE = path.join(ROOT, 'emisoras_ve.json');

const UA = 'RadioLatam/1.0';

// ---------- helper: GET JSON ----------
function getJson(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': UA }, timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------- health check de streams (cache 60s) ----------
const healthCache = new Map();
const HEALTH_TTL = 60000;

function checkAlive(streamUrl) {
  return new Promise((resolve) => {
    const c = healthCache.get(streamUrl);
    if (c && Date.now() - c.ts < HEALTH_TTL) return resolve(c.alive);
    let u;
    try { u = new URL(streamUrl); } catch { return resolve(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(streamUrl, { headers: { 'User-Agent': UA, 'Icy-MetaData': '1' }, timeout: 6000 }, (res) => {
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

// ---------- metadatos ICY (cancion sonando) ----------
function fetchIcyMetadata(streamUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let u;
    try { u = new URL(streamUrl); } catch { return done(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(streamUrl, { headers: { 'Icy-MetaData': '1', 'User-Agent': UA }, timeout: 8000 }, (res) => {
      const metaInt = parseInt(res.headers['icy-metaint'], 10);
      const icyName = res.headers['icy-name'] || '';
      const icyDesc = res.headers['icy-description'] || '';
      if (!metaInt || isNaN(metaInt)) {
        res.destroy();
        return done({ title: '', name: icyName, description: icyDesc });
      }
      let bytes = 0, collecting = false, metaLen = null, buf = Buffer.alloc(0), left = 0;
      res.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          if (!collecting && metaLen === null) {
            bytes++;
            if (bytes > metaInt) {
              metaLen = chunk[i]; left = metaLen * 16; bytes = 0;
              if (left === 0) { metaLen = null; } else { collecting = true; buf = Buffer.alloc(0); }
            }
          } else if (collecting) {
            buf = Buffer.concat([buf, Buffer.from([chunk[i]])]);
            left--;
            if (left <= 0) {
              const m = buf.toString('utf8').match(/StreamTitle='([^']*)'/);
              res.destroy();
              return done({ title: m ? m[1].trim() : '', name: icyName, description: icyDesc });
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

// ---------- populares LATAM (top por pais, cache 1h) ----------
let popCache = { data: null, ts: 0 };
const POP_TTL = 3600000;
const POP_COUNTRIES = ['MX', 'CO', 'AR', 'VE', 'CL', 'PE', 'EC', 'DO', 'GT', 'PR'];

async function getPopulares() {
  if (popCache.data && Date.now() - popCache.ts < POP_TTL) return popCache.data;
  const lists = await Promise.all(POP_COUNTRIES.map((cc) =>
    getJson('https://de1.api.radio-browser.info/json/stations/search?countrycode=' + cc +
      '&order=clickcount&reverse=true&hidebroken=true&limit=3')
  ));
  const seen = new Set();
  const out = [];
  lists.forEach((l) => (l || []).forEach((s) => {
    if (s.url_resolved && !seen.has(s.stationuuid)) { seen.add(s.stationuuid); out.push(s); }
  }));
  popCache = { data: out, ts: Date.now() };
  return out;
}

// ---------- proxy de logos (cache en memoria, 200 entradas) ----------
const logoCache = new Map();
const LOGO_MAX = 200;

function proxyLogo(logoUrl, res) {
  let u;
  try { u = new URL(logoUrl); } catch { res.writeHead(400); return res.end(); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') { res.writeHead(400); return res.end(); }

  const hit = logoCache.get(logoUrl);
  if (hit) {
    res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    return res.end(hit.buf);
  }

  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.get(logoUrl, { headers: { 'User-Agent': UA }, timeout: 7000 }, (r) => {
    const ct = (r.headers['content-type'] || '').toLowerCase();
    if (r.statusCode !== 200 || !ct.startsWith('image')) { r.resume(); res.writeHead(404); return res.end(); }
    const chunks = [];
    let size = 0;
    r.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { r.destroy(); return; } // max 2MB
      chunks.push(c);
    });
    r.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) { res.writeHead(404); return res.end(); }
      if (logoCache.size >= LOGO_MAX) logoCache.delete(logoCache.keys().next().value);
      logoCache.set(logoUrl, { buf, type: ct });
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    });
    r.on('error', () => { if (!res.headersSent) { res.writeHead(404); res.end(); } });
  });
  req.on('error', () => { if (!res.headersSent) { res.writeHead(404); res.end(); } });
  req.on('timeout', () => { req.destroy(); if (!res.headersSent) { res.writeHead(404); res.end(); } });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // --- proxy Radio-Browser ---
  if (u.pathname === '/api/stations') {
    const data = await getJson('https://de1.api.radio-browser.info/json/stations/search' + (u.search || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data || []));
  }

  // --- proxy de logos ---
  if (u.pathname === '/api/logo') {
    const l = u.searchParams.get('url');
    if (!l) { res.writeHead(400); return res.end(); }
    return proxyLogo(l, res);
  }

  // --- cancion sonando ---
  if (u.pathname === '/api/nowplaying') {
    const s = u.searchParams.get('url');
    if (!s) { res.writeHead(400); return res.end('{"error":"falta url"}'); }
    const meta = await fetchIcyMetadata(s);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(meta || { title: '', name: '', description: '' }));
  }

  // --- emisoras curadas VE (solo las vivas) ---
  if (u.pathname === '/api/emisoras-ve') {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(EMISORAS_FILE, 'utf8')); } catch {}
    const checked = await Promise.all(list.map(async (e) => ({ e, alive: await checkAlive(e.url_resolved) })));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(checked.filter((x) => x.alive).map((x) => x.e)));
  }

  // --- populares LATAM ---
  if (u.pathname === '/api/populares') {
    const pop = await getPopulares();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(pop));
  }

  // --- estaticos ---
  const filePath = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!filePath.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    if (filePath.endsWith('.html')) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Radio LATAM backend en puerto ' + PORT));
