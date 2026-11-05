const express = require('express');
const archiver = require('archiver');
const path = require('path');
const { inspectSite, encodeCfg, decodeCfg, pwaFiles, capacitorFiles, desktopFiles, appId, safeFetch } = require('./lib');

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
function limitOk(req) { const k = req.ip + ':custom'; const now = Date.now(); const arr = (hits.get(k) || []).filter((t) => now - t < 60000); if (arr.length >= 300) return false; arr.push(now); hits.set(k, arr); return true; }
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some((t) => n - t < 60000)) hits.delete(k); }, 60000).unref();

app.get('/healthz', (_, res) => res.send('ok'));

/* ---------- Custom domains: app.theirshop.com -> their app (no database) ----------
   The domain's TXT record  _site2app.<domain>  holds the app token. */
const dnsp = require('dns').promises;
const ownHost = () => {
  const s = new Set(['localhost', '127.0.0.1']);
  for (const h of [process.env.RENDER_EXTERNAL_HOSTNAME, process.env.PUBLIC_URL && new URL(process.env.PUBLIC_URL).hostname, ...(process.env.OWN_HOSTS || '').split(',')]) if (h) s.add(h.trim().toLowerCase());
  return s;
};
const OWN = ownHost();
const isOwn = (h) => OWN.has(h) || h.endsWith('.onrender.com');
const withTimeout = (p, ms = 4000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('dns timeout')), ms))]);
async function txtToken(domain) {
  try {
    const recs = await withTimeout(dnsp.resolveTxt('_site2app.' + domain));
    for (const r of recs) { const t = r.join('').trim().replace(/^site2app=/, ''); try { decodeCfg(t); return t; } catch { /* next */ } }
  } catch { /* none */ }
  return null;
}
const domCache = new Map();
async function tokenForHost(host) {
  const c = domCache.get(host);
  if (c && Date.now() - c.t < (c.token ? 300000 : 60000)) return c.token;
  const token = await txtToken(host);
  domCache.set(host, { t: Date.now(), token });
  if (domCache.size > 500) domCache.delete(domCache.keys().next().value);
  return token;
}
app.use(async (req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (!host || isOwn(host) || req.path === '/healthz') return next();
  if (!limitOk(req)) return res.status(429).send('Too many requests');
  try {
    const token = await tokenForHost(host);
    if (!token) return res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;text-align:center;padding:20vh 20px;background:#0b0b0f;color:#fff"><h2>This domain is not connected to an app yet</h2><p style="opacity:.6">Created by Ntandomods.INC</p>');
    const file = req.path === '/' ? 'index.html' : req.path.slice(1);
    return await servePwa(res, token, file);
  } catch { return res.status(500).send('Error'); }
});


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
async function servePwa(res, token, file) {
  const cfg = decodeCfg(token);
  let entry = cache.get(token);
  if (!entry) {
    entry = (await pwaFiles(cfg)).files;
    cache.set(token, entry);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  const buf = entry[file];
  if (!buf) return res.status(404).send('Not found');
  res.set('Content-Type', types[file] || types.png);
  if (file === 'sw.js') res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', file === 'sw.js' || file === 'index.html' ? 'no-cache' : 'public, max-age=3600');
  res.send(buf);
}
app.get('/p/:token', (req, res) => res.redirect(301, `/p/${req.params.token}/`));
app.get(['/p/:token/', '/p/:token/:file'], limit(120, 60000), async (req, res) => {
  try { await servePwa(res, req.params.token, req.params.file || 'index.html'); }
  catch { res.status(400).send('Invalid app link'); }
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


/* ---------- Cloud builds (real .apk / .exe / .dmg / .AppImage) ---------- */
const BUILD_REPO = process.env.BUILD_REPO || 'xofcntando/ntandomods-apk-builder';
const BUILD_TOKEN = process.env.BUILD_GITHUB_TOKEN || '';
const gh = (p, opts = {}) => fetch('https://api.github.com' + p, {
  ...opts,
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'ntandomods-app-maker', ...(BUILD_TOKEN ? { authorization: 'Bearer ' + BUILD_TOKEN } : {}), ...(opts.headers || {}) },
  signal: AbortSignal.timeout(10000),
});
const WORKFLOW = { a: 'build-apk.yml', d: 'build-desktop.yml' };
const statusCache = new Map();

app.get('/api/build/enabled', (_, res) => res.json({ enabled: !!BUILD_TOKEN }));

app.post('/api/build', limit(4, 3600000), async (req, res) => {
  if (!BUILD_TOKEN) return res.status(503).json({ error: 'Cloud builds are not enabled on this server yet.' });
  try {
    const kind = req.body && req.body.kind === 'desktop' ? 'd' : 'a';
    const cfg = decodeCfg(String((req.body && req.body.token) || ''));
    const token = encodeCfg(cfg);
    const job = kind + require('crypto').randomBytes(5).toString('hex');
    const origin = (process.env.PUBLIC_URL || `https://${req.get('host')}`).replace(/\/$/, '');
    const r = await gh(`/repos/${BUILD_REPO}/actions/workflows/${WORKFLOW[kind]}/dispatches`, {
      method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { job, origin, token } }),
    });
    if (r.status !== 204) { console.error('dispatch failed', r.status, await r.text()); return res.status(502).json({ error: 'Could not start the build. Try again in a minute.' }); }
    res.json({ job });
  } catch { res.status(400).json({ error: 'Invalid app settings' }); }
});

app.get('/api/build/:job', limit(120, 60000), async (req, res) => {
  const job = req.params.job;
  if (!/^[ad][0-9a-f]{10}$/.test(job)) return res.status(400).json({ error: 'bad job' });
  const c = statusCache.get(job);
  if (c && Date.now() - c.t < 6000) return res.json(c.v);
  try {
    const rel = await gh(`/repos/${BUILD_REPO}/releases/tags/${job}`);
    let v;
    if (rel.status === 200) {
      const j = await rel.json();
      v = { status: 'done', files: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })) };
    } else {
      const runs = await (await gh(`/repos/${BUILD_REPO}/actions/workflows/${WORKFLOW[job[0]]}/runs?event=workflow_dispatch&per_page=30`)).json();
      const run = (runs.workflow_runs || []).find((x) => x.display_title === `Build ${job}`);
      if (!run) v = { status: 'queued' };
      else if (run.status !== 'completed') v = { status: 'building' };
      else v = { status: 'failed', error: 'The build failed. You can still use the project zip.' };
    }
    statusCache.set(job, { t: Date.now(), v });
    res.json(v);
  } catch { res.status(502).json({ error: 'Could not check build status' }); }
});

/* ---------- Domain setup helpers ---------- */
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || '';
const targetHost = (req) => process.env.RENDER_EXTERNAL_HOSTNAME || (process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : req.hostname);
function cleanDomain(d) {
  d = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new Error('Enter a domain like app.yourshop.com');
  if (isOwn(d)) throw new Error('Use your own domain, not this site');
  return d;
}
app.get('/api/domain/enabled', (_, res) => res.json({ register: !!(RENDER_API_KEY && RENDER_SERVICE_ID) }));

app.get('/api/domain', limit(30, 60000), (req, res) => {
  try {
    const domain = cleanDomain(req.query.domain);
    const token = encodeCfg(decodeCfg(String(req.query.token || '')));
    const apex = domain.split('.').length <= 2;
    res.json({
      domain, apex,
      records: [
        { type: 'CNAME', name: domain, value: targetHost(req) },
        { type: 'TXT', name: '_site2app.' + domain, value: token },
      ],
      note: apex ? 'Root domains often cannot use a CNAME. Use a subdomain such as app.' + domain + ' instead.' : '',
    });
  } catch (e) { res.status(400).json({ error: e.message || 'Invalid request' }); }
});

app.get('/api/domain/check', limit(30, 60000), async (req, res) => {
  try {
    const domain = cleanDomain(req.query.domain);
    const token = encodeCfg(decodeCfg(String(req.query.token || '')));
    const found = await txtToken(domain);
    let cname = false;
    try { const c = await withTimeout(dnsp.resolveCname(domain)); cname = c.some((x) => x.replace(/\.$/, '').toLowerCase() === targetHost(req).toLowerCase()); } catch { /* none */ }
    let live = false;
    if (found) { try { const r = await safeFetch('https://' + domain + '/manifest.webmanifest', { timeout: 6000, maxBytes: 20000 }); live = r.res.ok; } catch { /* not yet */ } }
    domCache.delete(domain);
    res.json({ txt: found === token, txtOther: !!found && found !== token, cname, live });
  } catch (e) { res.status(400).json({ error: e.message || 'Invalid request' }); }
});

app.post('/api/domain/register', limit(5, 3600000), async (req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return res.status(503).json({ error: 'Automatic setup is not enabled. Add the domain in your host dashboard.' });
  try {
    const domain = cleanDomain(req.body && req.body.domain);
    const token = encodeCfg(decodeCfg(String((req.body && req.body.token) || '')));
    if ((await txtToken(domain)) !== token) return res.status(400).json({ error: 'Add the TXT record first, then try again. DNS can take a few minutes.' });
    const r = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/custom-domains`, {
      method: 'POST', headers: { authorization: 'Bearer ' + RENDER_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: domain }), signal: AbortSignal.timeout(15000),
    });
    if (r.status === 409) return res.json({ ok: true, note: 'Already added.' });
    if (!r.ok) { console.error('render domain', r.status, await r.text()); return res.status(502).json({ error: 'Could not add the domain automatically.' }); }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message || 'Invalid request' }); }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Ntandomods App Maker on :' + port));
