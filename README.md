# Ntandomods App Maker

Paste a website link, get an installable app.

- **Install link**: hosted PWA (`/p/<token>/`) you open on a phone and add to the home screen.
- **PWA zip**: the same app as static files for your own hosting.
- **Android/iOS project zip**: a Capacitor project plus a GitHub Actions workflow that builds the APK.

No database. Every app's settings live inside its link, so it works on Render's free plan with no disk.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render dashboard > **New > Blueprint** (uses `render.yaml`), or **New > Web Service** with build `npm install` and start `npm start`.
3. Done. Health check: `/healthz`.

Run locally: `npm install && npm start` then open http://localhost:3000.

Notes: sites that send `X-Frame-Options`/CSP `frame-ancestors` cannot be embedded, so the app opens them directly. The Android/iOS project handles those properly.
