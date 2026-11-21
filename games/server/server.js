/* Baby Cheetah save server.
   Keeps one saved game per "family code": a progress record and one record per picture.
   No accounts and no personal details: the 12-character family code is the only key, so treat it like a password.
   Storage is plain JSON files on a disk volume (DATA_DIR). No dependencies beyond Node itself. */
const http = require('http'), fs = require('fs'), path = require('path');

const DATA = process.env.DATA_DIR || '/data';
const PORT = +(process.env.PORT || 8080);
const MAX_FAMILIES = +(process.env.MAX_FAMILIES || 200);     // new codes are refused beyond this
const MAX_ART = +(process.env.MAX_ART || 2000);              // pictures per family
const MAX_PROGRESS = 100 * 1024, MAX_PICTURE = 700 * 1024;   // bytes per request body
const CODE = /^[A-HJ-NP-Z2-9]{12}$/, ID = /^[A-Za-z0-9]{3,40}$/;

fs.mkdirSync(DATA, { recursive: true });

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  'cache-control': 'no-store',
};
const send = (res, status, body) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...cors, ...(text ? { 'content-type': 'application/json' } : {}) });
  res.end(text);
};
const readBody = (req, limit) => new Promise((ok, no) => {
  let size = 0; const parts = [];
  req.on('data', c => { size += c.length; if (size > limit) { no(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
  req.on('end', () => { try { const v = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; ok(v); } catch (e) { no(Object.assign(new Error('bad json'), { status: 400 })); } });
  req.on('error', no);
});
const writeFile = (file, obj) => { const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); };
const readFile = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };

/* a simple per-address limit: 900 requests in 5 minutes */
const hits = new Map();
setInterval(() => hits.clear(), 5 * 60 * 1000).unref();
const limited = req => { const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress || '?'; const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 900; };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://x'), parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/' || url.pathname === '/healthz') return send(res, 200, { ok: true, service: 'baby-cheetah-save' });
    if (limited(req)) return send(res, 429, { error: 'slow down' });
    if (parts[0] !== 'v1' || parts[1] !== 's' || !CODE.test(parts[2] || '')) return send(res, 404, { error: 'not found' });

    const dir = path.join(DATA, parts[2]), artDir = path.join(dir, 'art'), what = parts[3], id = parts[4];
    const exists = fs.existsSync(dir);
    const ensure = () => {
      if (exists) return true;
      if (fs.readdirSync(DATA).length >= MAX_FAMILIES) return false;
      fs.mkdirSync(artDir, { recursive: true }); return true;
    };

    if (what === 'progress' && parts.length === 4) {
      if (req.method === 'GET') { const v = exists && readFile(path.join(dir, 'progress.json')); return v ? send(res, 200, v) : send(res, 404, { error: 'no saved game' }); }
      if (req.method === 'PUT') { const body = await readBody(req, MAX_PROGRESS); if (!ensure()) return send(res, 507, { error: 'server is full' }); writeFile(path.join(dir, 'progress.json'), body); return send(res, 200, { ok: true }); }
    }
    if (what === 'art' && parts.length === 4 && req.method === 'GET') {
      if (!exists || !fs.existsSync(artDir)) return send(res, 200, []);
      return send(res, 200, fs.readdirSync(artDir).filter(f => f.endsWith('.json')).map(f => ({ id: f.slice(0, -5) })));
    }
    if (what === 'art' && parts.length === 5 && ID.test(id)) {
      const file = path.join(artDir, id + '.json');
      if (req.method === 'GET') { const v = readFile(file); return v ? send(res, 200, v) : send(res, 404, { error: 'no picture' }); }
      if (req.method === 'DELETE') { try { fs.unlinkSync(file); } catch (e) {} return send(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        const body = await readBody(req, MAX_PICTURE);
        if (typeof body.u !== 'string' || !body.u.startsWith('data:image/')) return send(res, 400, { error: 'not a picture' });
        if (!ensure()) return send(res, 507, { error: 'server is full' });
        fs.mkdirSync(artDir, { recursive: true });
        if (!fs.existsSync(file) && fs.readdirSync(artDir).length >= MAX_ART) return send(res, 507, { error: 'too many pictures' });
        writeFile(file, { u: body.u, t: +body.t || Date.now() }); return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || 500, { error: e.status ? e.message : 'server error' }); }
});
server.listen(PORT, () => console.log('Baby Cheetah save server on port ' + PORT + ', data in ' + DATA));
