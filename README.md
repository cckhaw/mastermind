# Mastermind (PWA)

Offline-first Mastermind with two board themes (Vintage 1970s / Modern Goliath), Pass & Play, and a peer-to-peer Online Challenge over WebRTC.

- **Files:** `index.html`, `styles.css`, `app.js`, `webrtc.js`, `sw.js`, `manifest.webmanifest`, `icons/`, `vendor/peerjs.min.js` (bundled, MIT, see `vendor/PEERJS-LICENSE`).
- **Run locally:** `python3 -m http.server 8000` (service worker needs https or localhost).
- **Install:** Safari: Share → Add to Home Screen. Chrome: ⋮ → Install app.

## Online mode
PeerJS cloud is used only as a signaling relay (STUN: Google ×2, Cloudflare). A challenge code is 6 characters from an unambiguous alphabet (shown `ABC-123`) mapped to peer id `mastermind-p2p-<code>`. Deep link: `/?join=<code>`.

Anti-cheat: the codemaker's code stays in local memory; only a SHA-256 commitment (`code|salt`) is sent at round start. Guesses go to the codemaker, who replies with `{exact, colorOnly}`. At round end `REVEAL` sends the code + salt; the codebreaker verifies the hash **and** re-scores every guess to check the feedback was honest.

Limits: no TURN server, so some strict NATs may fail to connect; reloading the page mid online match ends it (the secret is intentionally never persisted).

## Deploy
`vercel.json` disables Git-triggered builds. `.github/workflows/deploy-production.yml` deploys to production on push to `main`, waits for READY, then deletes every older deployment. Requires repo secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`. Bump `CACHE` in `sw.js` when shipping asset changes.
