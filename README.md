## 12FPS (Devvit App)

Collaborative frame-by-frame animation inside Reddit. Users contribute frames in timed drawing turns, and every week the community votes on the color palette, theme, and special brushes for the next cycle. The result is a community video whose aesthetic is steered by collective decisions.

---
### Goals
- Encourage coordinated yet asynchronous artistic creation.
- Enforce constrained resources (palette, brushes) to keep a cohesive weekly style.
- Integrate native voting + fast in-app state via Redis to close a weekly creative loop.

---
### High-Level Flow
1. Weekly cycle starts (Week N):
	- Voting phase opens (palette, theme, optional special brushes).
	- When voting closes we snapshot the config (cached in Redis).
2. Drawing Sessions (continuous / daily):
	- Each turn grants an exclusive 2h session (soft lock per user).
	- The author draws with only the enabled palette + brush modes.
	- On finish (or early force-end) a PNG/Base64 frame is produced and persisted.
3. Playback / Gallery:
	- Frames are listed + played at 6/12/24 FPS.
	- Each frame shows author, timestamp, week.
4. New Week:
	- Config cache is cleared and a new voting round begins.

---
### Technical Components
| Layer | Tech | Role |
|-------|------|------|
| WebView (post) | React + Vite | Interactive UI (canvas, gallery, video, voting) |
| Devvit Server | Node (Vite SSR build) | Internal endpoints: session lock, save frame, collect votes, weekly rollover task |
| Fast Store | Redis (Devvit integration) | Cache palette/theme, session locks (TTL), vote counters |
| Frame Storage | R2 / S3 / Base64 object | Persist final frame image |
| Weekly Config | Redis + JSON fallback | Snapshot of palette + theme + brushes |

---
### Redis / Key Model
Example keys:
- `week:current` → active week number.
- `week:<n>:config` → JSON (palette[], theme, enabled brushes).
- `session:lock` → userId + start + expiry (2h). TTL=7200s.
- `votes:palette:<n>` → hash { paletteId: count }.
- `votes:theme:<n>` → hash { themeId: count }.
- `votes:brush:<n>` → hash { brushId: count }.
- `frames:week:<n>` → list of frame IDs.
Locks use SET NX EX for atomicity; optional renewal guarded by ownership.

---
### Weekly Voting
1. Open: server seeds candidate palettes/themes (curated or pseudo-random).
2. User votes (rate-limited per user via Redis INCR + TTL bucket).
3. Close: cron (or manual endpoint) tallies results → writes `week:<n+1>:config` and updates `week:current`.
4. UI hydrates from cached new config.

Tie-breaking: earliest threshold (first to reach max) or optional second round.

---
### 2-Hour Turns (Session Lock)
On “Start Session”:
1. Server attempts `SET session:lock {userId,t0} NX EX 7200`.
2. On success returns remaining time for client countdown.
3. User may end early; server clears lock and records timestamp.
4. Natural expiry (no heartbeats) auto-frees slot.

No overlap: new user waits until expiry; UI shows “Busy”.

---
### Frame Save Pipeline
1. Client captures canvas → dataURL PNG (optionally compresses before upload).
2. POST to `/internal/frame/save` with metadata (week, palette hash, author).
3. Server validates lock + active week.
4. Upload to storage (R2, etc.) and push reference + metadata to weekly list.
5. Invalidate/update cache for listings.

---
### Video Playback
- Client fetches chronological frame list.
- Optional prefetch / lazy loading.
- Interval playback (6/12/24 FPS) + progress bar.
- Future export: server composition (ffmpeg WASM or backend job).

---
### Brushes & Constraints
Modes: Solid, Soft, Fade, Spray (experimental others). 
We apply weekly caps (max size, opacity, jitter, density) from config→Redis to enforce cohesion.

---
### Commands (Inside `twelve-fps/`)
- `npm run dev` → watch mode (client + server + playtest).
- `npm run build` → build client and server.
- `npm run build:client` / `build:server` → individual.
- `npm run deploy` → build + upload (`devvit upload`).
- `npm run launch` → publish version.
- `npm run login` → CLI auth.

Root monorepo:
- `npm run deploy:devvit` → root build + sync + server build + upload.
- `npm run deploy:reddit` → orchestrated pipeline (short alias).

---
### WebView Sync Pipeline
Root app builds with hashed assets. Script `tools/sync-devvit.mjs` copies `dist/index.html` + `dist/assets/` to `twelve-fps/dist/client/`, rewrites `/assets/` → `./assets/`, adds timestamp banner, verifies largest JS tail.

---
### Performance Notes
- Canvas caps DPR (<=3) to balance sharpness/memory.
- Spray / Soft brushes use heuristics to limit steps.
- Large frame images lazy load; images use `object-contain` preserving 540×740 aspect.

---
### Security / Anti-Abuse (Planned)
- Rate limit votes & frame saves (Redis INCR + TTL).
- Enforce max image size.
- Basic content filtering placeholder (future moderation layer).
- Audit metadata (userId, timestamps) per frame.

---
### Short-Term Roadmap
- GIF / MP4 export.
- Local Undo/Redo before submission.
- Configurable onion-skin overlay.
- Dynamic palettes with weighting (usage-based curation).
- Dedicated voting modal UI.

---
### Fast Local Dev
```bash
# root
npm install
npm run build        # optional for sync
npm run sync:devvit  # copy assets into WebView
cd twelve-fps
npm run build:server
npx devvit upload
```

Live/test mode:
```bash
cd twelve-fps
npm run dev
```

---
### R2 / S3 Storage Setup

This server can store frame binaries in Cloudflare R2 (S3-compatible). Redis keeps only metadata.

Env variables read by the server (twelve-fps/src/server/index.ts):

- R2_ENABLED=1
- R2_BUCKET=12fps-frames
- R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
- R2_ACCESS_KEY_ID=<your-access-key-id>
- R2_SECRET_ACCESS_KEY=<your-secret-access-key>
- R2_PUBLIC_BASE_URL=https://cdn.example.com/frames (optional; used for HTTP 302 redirects)

Create R2 access keys (Cloudflare Dashboard):
- R2 → S3 API Tokens → Create API token
- Grant Object Read/Write on bucket `12fps-frames`
- After creating, copy the Access Key ID and Secret Access Key. You won’t see the secret again.

Local dev (PowerShell):
```powershell
cd twelve-fps
$env:R2_ENABLED="1"
$env:R2_BUCKET="12fps-frames"
$env:R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
$env:R2_ACCESS_KEY_ID="<key>"
$env:R2_SECRET_ACCESS_KEY="<secret>"
# optional public base for CDN/domain
$env:R2_PUBLIC_BASE_URL="https://cdn.example.com/frames"

devvit playtest
```

Alternatively, create a `.env` in `twelve-fps/` and run with dotenv:
```powershell
cd twelve-fps
npx dotenv -e .env -- devvit playtest
```

Production (Devvit):
You have two ways to provide credentials in production:

1) App Settings (if using Devvit Public API settings)
- Use the Devvit console or CLI to set app-level settings and the runtime will expose them.
- CLI (from `twelve-fps/`):
	- `devvit settings set R2_BUCKET <value>`
	- `devvit settings set R2_ENDPOINT <value>`
	- `devvit settings set R2_ACCESS_KEY_ID <value>`
	- `devvit settings set R2_SECRET_ACCESS_KEY <value>`
	- `devvit settings set R2_ENABLED 1`
	- `devvit settings set R2_PUBLIC_BASE_URL <value>` (optional)

2) Redis-based runtime config (no Devvit settings required)
- The server exposes mod-only endpoints to write config to Redis and use it live without redeploys.
- In any Reddit post where the app is installed, open the browser DevTools Console and run:
```js
await fetch('/api/r2-config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    enabled: true,
    bucket: '<your-bucket>',
    endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
    accessKeyId: '<ACCESS_KEY_ID>',
    secretAccessKey: '<SECRET_ACCESS_KEY>',
    publicBaseUrl: 'https://cdn.example.com/frames' // optional
  })
});
```
- To inspect what’s currently active (mod-only):
```js
await (await fetch('/api/r2-config')).json();
```
- Notes:
  - First-time setup is allowed even if the app’s internal mod allowlist is empty (bootstrap). Subsequent updates require being in the allowlist (`/api/mods`).

Behavior:
- If R2 variables are valid, `/api/finalize-turn` and `/api/upload-frame` upload to R2; listings return a stable `src` per frame.
- If not configured, the server falls back to Redis-only storage (legacy `dataUrl`).

Health check:
- After configurar los secretos en producción, valida R2 con:
	- GET `/api/r2-health` → responde `{ ok, putOK, getOK, deleteOK, bucket, endpoint }`
	- ok=true confirma credenciales y acceso de escritura/lectura.

---
### Common Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| WebView not updating | Forgot sync after root build | `npm run build && npm run sync:devvit` |
| Old palette showing | Redis cache not invalidated | Run weekly rollover job / delete week keys |
| Turn not releasing | Client abandoned session | Wait TTL or force-release endpoint |

---
### License
BSD-3-Clause (subject to change if needed).

---
### Credits
Built on Devvit + Reddit community. Inspired by pixel-art collabs and jam sessions.

