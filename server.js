const express = require('express');
const archiver = require('archiver');
const path = require('path');
const { inspectSite, encodeCfg, decodeCfg, pwaFiles, capacitorFiles, desktopFiles, appId } = require('./lib');

const app = express();
app.set('strict routing', true);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

/* tiny in-memory rate limiter */
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests, slow down a little.' });
    arr.push(now);
    hits.set(k, arr);
    next();
  };
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some((t) => n - t < 60000)) hits.delete(k); }, 60000).unref();

app.get('/healthz', (_, res) => res.send('ok'));

app.get('/api/inspect', limit(20, 60000), async (req, res) => {
  try {
    res.json(await inspectSite(String(req.query.url || '')));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not reach that site' });
  }
});

/* create a token for a config */
app.post('/api/create', limit(30, 60000), (req, res) => {
  try {
    const b = req.body || {};
    const cfg = decodeCfg(encodeCfg({ u: b.url, n: b.name, c: b.color, i: b.icon, f: b.framable === false ? 0 : 1, d: b.display, o: b.orientation }));
    const token = encodeCfg(cfg);
    res.json({ token, appUrl: `/p/${token}/`, pwaZip: `/download/pwa/${token}.zip`, nativeZip: `/download/native/${token}.zip`, desktopZip: `/download/desktop/${token}.zip`, appId: appId(cfg) });
  } catch (e) {
    res.status(400).json({ error: 'Invalid settings' });
  }
});

/* hosted installable app: /p/:token/<file> */
const types = { 'index.html': 'text/html; charset=utf-8', 'manifest.webmanifest': 'application/manifest+json', 'sw.js': 'text/javascript; charset=utf-8', png: 'image/png' };
const cache = new Map();
app.get('/p/:token', (req, res) => res.redirect(301, `/p/${req.params.token}/`));
app.get(['/p/:token/', '/p/:token/:file'], limit(120, 60000), async (req, res) => {
  try {
    const cfg = decodeCfg(req.params.token);
    const file = req.params.file || 'index.html';
    let entry = cache.get(req.params.token);
    if (!entry) {
      entry = (await pwaFiles(cfg)).files;
      cache.set(req.params.token, entry);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    const buf = entry[file];
    if (!buf) return res.status(404).send('Not found');
    res.set('Content-Type', types[file] || types.png);
    if (file === 'sw.js') res.set('Service-Worker-Allowed', `/p/${req.params.token}/`);
    res.set('Cache-Control', file === 'sw.js' || file === 'index.html' ? 'no-cache' : 'public, max-age=3600');
    res.send(buf);
  } catch {
    res.status(400).send('Invalid app link');
  }
});

/* ZIP downloads */
app.get('/download/:kind/:token.zip', limit(10, 60000), async (req, res) => {
  try {
    const cfg = decodeCfg(req.params.token);
    const kind = req.params.kind;
    if (!['pwa', 'native', 'desktop'].includes(kind)) return res.status(404).end();
    const files = kind === 'pwa' ? (await pwaFiles(cfg)).files : kind === 'desktop' ? await desktopFiles(cfg) : await capacitorFiles(cfg);
    const slug = cfg.n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${slug}-${kind}.zip"` });
    const z = archiver('zip', { zlib: { level: 9 } });
    z.on('error', () => res.end());
    z.pipe(res);
    for (const [name, buf] of Object.entries(files)) z.append(buf, { name: `${slug}-${kind}/${name}` });
    await z.finalize();
  } catch {
    res.status(400).send('Invalid app link');
  }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Ntandomods App Maker on :' + port));
