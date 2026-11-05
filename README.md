# Ntandomods App Maker

Paste a website link, get an installable app.

- **Install link**: hosted PWA (`/p/<token>/`) you open on a phone and add to the home screen.
- **PWA zip**: the same app as static files for your own hosting.
- **Android/iOS project zip**: a Capacitor project plus a GitHub Actions workflow that builds the APK.
- **PC app zip** (Windows, Mac, Linux): an Electron project plus a GitHub Actions workflow that builds the `.exe`, `.dmg` and `.AppImage` installers.

No database. Every app's settings live inside its link, so it works on Render's free plan with no disk.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render dashboard > **New > Blueprint** (uses `render.yaml`), or **New > Web Service** with build `npm install` and start `npm start`.
3. Done. Health check: `/healthz`.

Run locally: `npm install && npm start` then open http://localhost:3000.

Notes: sites that send `X-Frame-Options`/CSP `frame-ancestors` cannot be embedded, so the app opens them directly. The Android/iOS project handles those properly.

## Real .apk / .exe downloads (cloud builds)
The "Get Android APK" and "Get PC app" buttons trigger GitHub Actions in a builder repo (default `xofcntando/ntandomods-apk-builder`, see `BUILD_REPO`). When the build finishes the file is published as a release and the page shows a direct download link (usually 5 to 10 minutes).

Set these env vars on Render:
- `BUILD_GITHUB_TOKEN` - GitHub token that can run workflows in the builder repo (fine-grained: Actions read/write + Contents read on that repo; classic: `repo`)
- `PUBLIC_URL` - your public site URL, e.g. `https://ntandomods-app-maker.onrender.com`

Without `BUILD_GITHUB_TOKEN` the build buttons are hidden and only the zip downloads show.

## Custom domains (app.yourshop.com)
Users enter their domain on the result page and get two DNS records:
- `CNAME  app.yourshop.com -> <your Render hostname>`
- `TXT    _site2app.app.yourshop.com -> <app token>`

The server reads the TXT record to decide which app to serve on that domain, so no database is needed.
The domain also has to be added to the Render service (Render issues the HTTPS certificate). Two ways:
- Manual: add it in Render > your service > Settings > Custom Domains.
- Automatic: set `RENDER_API_KEY` and `RENDER_SERVICE_ID` (the `srv-...` id) and the **Connect domain** button adds it for users who have already set their TXT record (proof they control the domain).

Optional: `OWN_HOSTS` (comma-separated hostnames that should always show the App Maker itself, e.g. your own main domain).
