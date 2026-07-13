# 🎬 Kinora — Collaborative Frame‑by‑Frame Animation on Reddit

Kinora turns a subreddit into a **community animation studio**. Every week the community draws one shared movie together — one frame at a time — under a theme, color palette, brush kit, and "director" chosen by collective voting. When the week ends, all the frames are automatically stitched into an animated GIF and published back to the subreddit.

Built on **Devvit Web** (Reddit's developer platform). Submitted to the **Reddit "Games with a Hook" Hackathon**.

---

## Why it fits "Games with a Hook"

Kinora is a **shared creative experience** with retention built into its core loop:

- **The hook = a movie you can only make together.** No single person can finish the animation. You draw your frame on top of the previous artist's frame (onion‑skin guide), then hand the pencil to the next redditor. The payoff — the finished weekly GIF — only exists because the whole community showed up.
- **Watch it unfold live.** While one redditor draws, everyone else watches the strokes — with their real brush effects — appear in real time (Devvit realtime), behind a blinking "u/artist · LIVE" indicator. Each frame is a tiny live performance, not just a result.
- **Retention mechanics.** A weekly cycle (new theme every Sunday), community voting on next week's palette/theme/brushes/director, timed drawing turns, an onion‑skin that pulls you into "continue the story," and a **weekly animation reveal** that publishes automatically. There's always a reason to come back.
- **100% user contributions.** Every pixel in every frame is drawn by a redditor. The app contributes only the constraints (palette, brushes) and the stage.
- **Mobile‑first.** Draw with your finger on your phone in a vertical, full‑screen canvas — the same experience scales up to desktop.

---

## How it works

### 1. Weekly theme cycle
Each week has a **bundle**: a Theme + a 6‑color Palette + up to 4 Brushes + a Director. Redditors **propose and vote** on bundles for the upcoming week. When nobody proposes (a quiet week), a curated **house preset** is seeded automatically so the canvas is never empty — but any human bundle with a single real vote overtakes it, so the community always wins ties.

The week resets every **Sunday 7:00 PM (Colombia / UTC‑5) = Monday 00:00 UTC**, and the previous week's animation is published a couple of minutes later.

### 2. Drawing turns
Artists take **exclusive timed turns** (soft lock in Redis) so no two people draw the same frame at once. During a turn you draw on a blank canvas with a faint **onion‑skin** of the previous frame as a guide, using only that week's palette + brushes. Save the frame and it joins the movie.

### 3. Watch it happen live
While the current artist draws, every other viewer watches the **strokes render in real time over Devvit realtime** — the *actual* brush effects (ink taper, watercolor rim, spray, glow…), reproduced by a shared brush engine both sides run, not a flat placeholder. Eraser, fill and clear stream live too. Because clients can't publish on realtime directly, the artist's smoothed segments round‑trip through the server (~150 ms batches), and a periodic **keyframe snapshot** keeps late‑joiners and any dropped messages perfectly in sync. A turn can also be **resumed from another device** — or after closing the app — because the in‑progress frame is shared server‑side, not just cached locally.

### 4. Automatic showcase posts
This is where Kinora leans on Reddit itself:

- A **weekly announcement post** is auto‑created with the theme, palette swatches, brushes, and director.
- Each user's saved frame is **auto‑posted as an image comment** on the weekly post, grouped by day and artist.
- When the week ends, all frames are compiled into an **animated GIF** (12 fps) and **auto‑published as a new post** in the subreddit — the community's finished short film.

### 5. Playback
Browse frames in the gallery, scrub the weekly carousel, or watch the compiled GIF.

---

## Images: native Reddit Media API

Kinora previously (in an earlier hackathon build) stored frame images in **external object storage (Cloudflare R2 / S3‑compatible)**. That path was unreliable inside Devvit's sandbox and often failed to serve images. 

The app now uses **Reddit's native Media API** (`media.upload`) end‑to‑end: drawn frames and the compiled weekly GIF are uploaded to Reddit's own CDN (`i.redd.it`), and only lightweight metadata lives in Redis. This removed the external dependency entirely — **images and GIFs now work reliably**. (A Redis‑only base64 fallback remains for local/dev.)

---

## Mobile adaptation

The canvas and UI were rebuilt to be genuinely usable on a phone:

- **Finger drawing** — one finger draws; two fingers pinch‑zoom and pan. (Previously only a stylus/mouse could draw.)
- **Vertical 9:16 canvas** that fills the phone screen (Reels/TikTok shape).
- **Fixed canonical resolution (720×1280)** on every device, so a frame drawn on a phone and one drawn on a desktop are pixel‑compatible — the weekly GIF encoder now includes *every* frame instead of dropping mismatched ones.
- **Collapsible tools** — a right‑side drawer holds the tool panels and auto‑closes when you pick a tool, leaving the whole screen for drawing. A compact bottom nav replaces the desktop side rail.
- **Comfortable color picker** — an HSV **color wheel** replaces the poor native `<input type="color">` that Reddit's mobile app renders, so choosing palette colors works well on both phone and desktop.
- Desktop keeps the full paper‑sketch UI with the tool panels hugging the canvas.

---

## Tech stack

| Layer | Tech | Role |
|-------|------|------|
| Post UI (WebView) | React + Vite + Tailwind | Canvas, gallery, video carousel, weekly voting, chat |
| Server | Devvit Web (Node) | Turn locks, frame save, voting/tally, weekly rollover, showcase + GIF cron |
| Fast store | Redis (Devvit) | Week anchor, session locks (TTL), vote counters, frame metadata |
| Live spectating | Devvit realtime | Broadcast the artist's stroke batches + keyframes + turn changes to viewers |
| Image storage | Reddit Media API (`i.redd.it`) | Frame PNGs + weekly animation GIF |
| GIF encoding | `gifenc` + `upng-js` | Decode frames → resize to 720×1280 → encode 12 fps GIF |

---

## Custom brush engine

A hand‑written HTML‑canvas brush engine — no external art library. It draws in a fixed **logical coordinate space** so a brush feels identical on every device, and every stroke is:

- **Velocity‑driven** — on both finger and mouse, stroke width and opacity respond to speed (draw slow → thick and bold, flick fast → thin), simulating pressure even on touchscreens that report none.
- **Stabilized** — a "pulled‑string" position filter damps hand tremor (stronger at low speed) and sub‑pixel jitter is decimated, so lines come out clean.
- **Smoothed** — points are run through Chaikin midpoints and drawn as **quadratic curves**, not straight chords.

On top of that shared engine sit 12 brush characters: ink/manga pen (dual‑taper), marker, pencil, charcoal, **watercolor wash** (diffusion, granulation, and a darker pooled edge rim), acrylic with simulated bristles + impasto, airbrush, spray (with graffiti drip), splatter, **smudge** that drags the underlying color, calligraphy nib, **glow** with an additive halo and a bright solid core, pixel, and multi‑stamp. Weekly constraints cap which brushes are available to keep a cohesive style.

When building a weekly bundle, voters see a **live sample stroke** rendered for every brush (not just its name), so the kit choice is informed.

---

## Commands

```bash
npm install
npm run dev        # watch client + server + devvit playtest
npm run build      # build client + server (Vite)
npm run deploy     # build + devvit upload
npm run launch     # build + upload + publish
```

Install/update on a subreddit you moderate:

```bash
devvit install <subreddit>
```

Local UI preview (client only, no Reddit backend):

```bash
npm run dev:vite   # http://localhost:7474
```

---

## Project layout

```
src/
  client/           # React post UI
    app/
      components/   # Canvas (artist), SpectatorCanvas (live viewer), SidePanels, Header, FrameGallery, PaletteVoting…
      hooks/        # useSpectate — subscribes to the realtime channel and paints incoming strokes
      brushEngine.ts # shared per-engine stroke renderer used by BOTH artist and spectator
      brushes.ts    # brush presets / engine params
  server/
    index.ts        # Devvit Web server: turns, frames, voting, weekly cron, GIF job, realtime relay
    presets.ts      # house presets (theme list + palette/brush generators) for empty weeks
  shared/           # shared types
```

---

## Status

Concept‑complete and installed live on r/Kinora. Recent updates for the hackathon: **live spectating over Devvit realtime** (watch the current artist's strokes — with real brush effects — appear in real time, plus live eraser/fill/clear and a "u/artist · LIVE" badge), **cross‑device turn resume** (continue an in‑progress frame on another device or after closing the app), an **upgraded brush engine** (velocity dynamics + tremor stabilizer on finger and mouse, quadratic smoothing, per‑brush polish — watercolor rim, glow core, smudge color‑drag) now shared between the artist and spectators, a **color‑wheel palette picker**, **live brush previews** in the voting wizard, native Reddit Media API storage, automatic frame + weekly‑GIF posts, mobile finger‑drawing with a vertical fixed‑resolution canvas, community voting with house‑preset fallback, and a paper‑sketch UI polished for both mobile and desktop.

---

### License
BSD‑3‑Clause.
