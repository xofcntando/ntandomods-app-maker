const dns = require('dns').promises;
const net = require('net');
const sharp = require('sharp');

/* ---------- SSRF-safe fetching ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
  }
  return true;
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not allowed');
  return u;
}

async function safeFetch(raw, { maxBytes = 1.5e6, timeout = 8000, method = 'GET' } = {}) {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(url);
    const res = await fetch(u, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Site2AppBot/1.0)', accept: 'text/html,image/*,*/*;q=0.8' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), u).toString();
      continue;
    }
    let body = Buffer.alloc(0);
    if (method !== 'HEAD' && res.body) {
      const chunks = [];
      let size = 0;
      for await (const c of res.body) {
        size += c.length;
        if (size > maxBytes) break;
        chunks.push(c);
      }
      body = Buffer.concat(chunks);
    }
    return { res, body, finalUrl: u.toString() };
  }
  throw new Error('Too many redirects');
}

/* ---------- Site inspection ---------- */
const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? m[2] ?? m[3] ?? m[4] : null;
};
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function inspectSite(raw) {
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const { res, body, finalUrl } = await safeFetch(raw);
  const html = body.toString('utf8');
  const base = new URL(finalUrl);

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).replace(/\s+/g, ' ').slice(0, 60);
  const ogName = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]*>/i) || [])[0];
  const name = (ogName && attr(ogName, 'content') && decode(attr(ogName, 'content'))) || title || base.hostname;

  const themeTag = (html.match(/<meta[^>]+name=["']theme-color["'][^>]*>/i) || [])[0];
  let themeColor = themeTag ? attr(themeTag, 'content') : null;
  if (!/^#[0-9a-f]{3,8}$/i.test(themeColor || '')) themeColor = null;

  let best = null;
  for (const tag of html.match(/<link[^>]+>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!/icon/.test(rel) || /mask-icon/.test(rel)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    const sizes = parseInt((attr(tag, 'sizes') || '0').split('x')[0], 10) || 0;
    const score = (rel.includes('apple-touch') ? 1000 : 0) + sizes;
    if (!best || score > best.score) best = { score, href: decode(href) };
  }
  let icon = null;
  try {
    const iu = new URL(best ? best.href : '/favicon.ico', base);
    if (/^https?:$/.test(iu.protocol)) icon = iu.toString();
  } catch { /* ignore */ }

  const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
  const csp = res.headers.get('content-security-policy') || '';
  const fa = (csp.match(/frame-ancestors([^;]*)/i) || [, null])[1];
  const framable = !(xfo.includes('deny') || xfo.includes('sameorigin') || (fa !== null && !/\*/.test(fa)));

  return { url: finalUrl, name, themeColor: themeColor || '#0f172a', icon, framable, status: res.status };
}

/* ---------- Icons ---------- */
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function letterIcon(letter, bg, size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${bg}"/><text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${size * 0.5}" fill="#fff">${esc(letter)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function loadIconSource(cfg) {
  if (!cfg.i) return null;
  try {
    const { res, body } = await safeFetch(cfg.i, { maxBytes: 3e6 });
    if (!res.ok || !body.length) return null;
    return await sharp(body, { density: 300 }).png().toBuffer();
  } catch { return null; }
}

async function buildIcon(src, cfg, size, maskable) {
  const bg = cfg.c;
  const first = ([...cfg.n.trim()][0] || 'A').toUpperCase();
  if (!src) return letterIcon(first, bg, size);
  const inner = Math.round(size * (maskable ? 0.58 : 0.78));
  const glyph = await sharp(src).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: glyph, gravity: 'center' }]).png().toBuffer();
}

/* ---------- Config token ---------- */
function encodeCfg(cfg) { return Buffer.from(JSON.stringify(cfg)).toString('base64url'); }
function decodeCfg(token) {
  if (token.length > 2500) throw new Error('Token too long');
  const c = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  const url = new URL(c.u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bad URL');
  return {
    u: url.toString(),
    n: String(c.n || url.hostname).slice(0, 45),
    c: /^#[0-9a-f]{6}$/i.test(c.c) ? c.c : '#0f172a',
    i: c.i ? String(c.i).slice(0, 600) : '',
    f: c.f === 0 || c.f === false ? 0 : 1, // 1 = embed in frame, 0 = open directly
    d: ['standalone', 'fullscreen', 'minimal-ui'].includes(c.d) ? c.d : 'standalone',
    o: ['any', 'portrait', 'landscape'].includes(c.o) ? c.o : 'any',
  };
}

/* ---------- Generated files ---------- */
function shellHtml(cfg) {
  const name = esc(cfg.n);
  const url = esc(cfg.u);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${name}</title>
<meta name="theme-color" content="${cfg.c}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${name}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-512.png">
<style>
html,body{margin:0;height:100%;background:${cfg.c};font-family:system-ui,sans-serif;color:#fff}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff;padding-top:env(safe-area-inset-top)}
#splash{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:${cfg.c};transition:opacity .4s}
#splash img{width:96px;height:96px;border-radius:22px}
#splash .by{position:absolute;bottom:calc(24px + env(safe-area-inset-bottom));font-size:12px;opacity:.6;letter-spacing:.04em}
#splash.hide{opacity:0;pointer-events:none}
.spin{width:28px;height:28px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
#offline{display:none;position:fixed;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:${cfg.c};text-align:center;padding:24px}
#offline a,#offline button{background:#fff;color:#111;border:0;border-radius:10px;padding:12px 20px;font-size:16px;text-decoration:none;cursor:pointer}
</style>
</head>
<body>
<div id="splash"><img src="icon-192.png" alt=""><div>${name}</div><div class="spin"></div><div class="by">Powered by Ntandomods</div></div>
<div id="offline"><div style="font-size:20px">Can't reach ${name}</div><button onclick="location.reload()">Try again</button><a href="${url}">Open site directly</a></div>
${cfg.f ? `<iframe id="app" src="${url}" allow="camera; microphone; geolocation; fullscreen; clipboard-write; payment; autoplay" referrerpolicy="origin-when-cross-origin"></iframe>` : ''}
<script>
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(function(){});
var splash=document.getElementById('splash');
${cfg.f
  ? `var f=document.getElementById('app');f.addEventListener('load',function(){splash.classList.add('hide')});setTimeout(function(){splash.classList.add('hide')},6000);
window.addEventListener('offline',function(){document.getElementById('offline').style.display='flex'});
window.addEventListener('online',function(){document.getElementById('offline').style.display='none'});`
  : `setTimeout(function(){location.replace(${JSON.stringify(cfg.u).replace(/</g, '\\u003c')})},400);`}
</script>
</body>
</html>
`;
}

function manifestJson(cfg) {
  return JSON.stringify({
    id: './',
    name: cfg.n,
    short_name: cfg.n.slice(0, 12),
    description: `${cfg.n} as an app`,
    start_url: './',
    scope: './',
    display: cfg.d,
    orientation: cfg.o,
    background_color: cfg.c,
    theme_color: cfg.c,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2);
}

function swJs(cfg) {
  return `const CACHE='site2app-${Date.now().toString(36)}';
const SHELL=['./','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('./'))));
});
`;
}

async function pwaFiles(cfg) {
  const src = await loadIconSource(cfg);
  const [i192, i512, im512, i1024] = await Promise.all([
    buildIcon(src, cfg, 192, false),
    buildIcon(src, cfg, 512, false),
    buildIcon(src, cfg, 512, true),
    buildIcon(src, cfg, 1024, false),
  ]);
  return {
    files: {
      'index.html': Buffer.from(shellHtml(cfg)),
      'manifest.webmanifest': Buffer.from(manifestJson(cfg)),
      'sw.js': Buffer.from(swJs(cfg)),
      'icon-192.png': i192,
      'icon-512.png': i512,
      'icon-maskable-512.png': im512,
    },
    icon1024: i1024,
    iconMaskable: im512,
  };
}

function appId(cfg) {
  const host = new URL(cfg.u).hostname.replace(/^www\./, '').split('.').reverse();
  const parts = host.map((p) => p.replace(/[^a-z0-9]/gi, '').toLowerCase()).filter(Boolean).map((p) => (/^[0-9]/.test(p) ? 'a' + p : p));
  return 'app.ntandomods.' + (parts.join('.') || 'site');
}

async function capacitorFiles(cfg) {
  const { icon1024 } = await pwaFiles(cfg);
  const id = appId(cfg);
  const pkgName = id.replace(/[^a-z0-9]/g, '-');
  const files = {
    'package.json': JSON.stringify({
      name: pkgName, version: '1.0.0', private: true,
      scripts: { assets: `capacitor-assets generate --android --iconBackgroundColor '${cfg.c}' --splashBackgroundColor '${cfg.c}'`, sync: 'cap sync' },
      dependencies: { '@capacitor/core': '^6.2.0', '@capacitor/android': '^6.2.0', '@capacitor/ios': '^6.2.0' },
      devDependencies: { '@capacitor/cli': '^6.2.0', '@capacitor/assets': '^3.0.5' },
    }, null, 2),
    'capacitor.config.json': JSON.stringify({
      appId: id, appName: cfg.n, webDir: 'www',
      server: { url: cfg.u, cleartext: false, allowNavigation: [new URL(cfg.u).hostname, '*.' + new URL(cfg.u).hostname.replace(/^www\./, '')] },
      android: { backgroundColor: cfg.c },
    }, null, 2),
    'www/index.html': `<!doctype html><meta charset="utf-8"><title>${name(cfg)}</title><body style="background:${cfg.c}"><script>location.replace(${JSON.stringify(cfg.u).replace(/</g, '\\u003c')})</script>`,
    '.github/workflows/build-apk.yml': `name: Build Android APK
on:
  workflow_dispatch:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 17 }
      - run: npm install
      - run: npx cap add android
      - run: npm run assets
      - run: npx cap sync android
      - run: cd android && chmod +x gradlew && ./gradlew assembleDebug
      - uses: actions/upload-artifact@v4
        with:
          name: app-debug-apk
          path: android/app/build/outputs/apk/debug/app-debug.apk
`,
    'README.md': `# ${cfg.n} - native app wrapper

_Made with Ntandomods App Maker._

This project wraps **${cfg.u}** in a real Android/iOS app using [Capacitor](https://capacitorjs.com).
The app loads the live site, so site updates show up in the app automatically.

## Build the Android APK (easiest, no Android Studio)
1. Create a GitHub repo and push this folder to it.
2. Open the **Actions** tab, run **Build Android APK**.
3. Download the \`app-debug-apk\` artifact and install \`app-debug.apk\` on your phone.

## Build locally
\`\`\`
npm install
npx cap add android
npm run assets
npx cap sync android
npx cap open android      # opens Android Studio, then Build > Build APK
\`\`\`
iOS: \`npx cap add ios && npx cap open ios\` (needs a Mac and Xcode).

## Publishing
The debug APK is for testing. For Google Play you need a signed release build and a developer account.
Note: Apple and Google may reject apps that are only a thin website wrapper, so add native value if you plan to publish.
`,
  };
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = Buffer.from(v);
  out['assets/icon-only.png'] = icon1024;
  out['assets/icon-foreground.png'] = icon1024;
  return out;
}
const name = (cfg) => esc(cfg.n);

module.exports = { inspectSite, encodeCfg, decodeCfg, pwaFiles, capacitorFiles, safeFetch, appId };
