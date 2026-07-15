import express from 'express';
import { InitResponse, IncrementResponse, DecrementResponse } from '../shared/types/api';
import { redis, reddit, createServer, context, getServerPort, media, scheduler, realtime } from '@devvit/web/server';
import { createPost } from './core/post';
import { getHouseBundle, houseWinnersForWeek, buildHouseProposals, HOUSE_DIRECTOR } from './presets';
import crypto from 'node:crypto';
import { RichTextBuilder } from '@devvit/shared-types/richtext/RichTextBuilder.js';

const app = express();

// Middleware for JSON body parsing (increase limit for base64 PNG data URLs)
app.use(express.json({ limit: '3mb' }));
// Middleware for URL-encoded body parsing
app.use(express.urlencoded({ extended: true }));
// Middleware for plain text body parsing
app.use(express.text());

// --- Weekly cycle utilities (Monday 00:00 UTC week counter) ---
// Requirements:
//  - Weeks reset every Monday 00:00:00 UTC, which is Sunday 7:00 PM Colombia (UTC-5).
//    The weekly showcase post cron ("5 0 * * 1" = Monday 00:05 UTC = Sunday 7:05 PM
//    Colombia) therefore fires 5 minutes AFTER the reset.
//  - Week 1 starts at the Monday 00:00 UTC that contains 'now'; next Monday => week 2 (weeks run Mon–Sun UTC).
//  - Auto-advance without manual rollover for consumers (chat, proposals, videos, gallery).
// Notes:
//  - Anchor is stored in Redis so restarts preserve numbering.
//  - A manual rollover endpoint still exists but is optional.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Offset applied when snapping to the Monday boundary. 0 => Monday 00:00 UTC
// (= Sunday 7:00 PM Colombia). Change this only to move the reset moment.
const WEEK_BOUNDARY_OFFSET_MS = 0;
const WEEK_ANCHOR_KEY = 'week:anchor:startMs'; // UTC ms of start of week 1
const CURRENT_WEEK_KEY = 'week:current:number'; // cached current week number
const WEEK_TIME_OFFSET_KEY = 'week:timeOffsetMs'; // simulation offset ms
const WEEK_PROPOSALS_KEY = (postId: string, w: number) => `proposals:${postId}:week:${w}`;
const WEEK_WINNERS_KEY = (postId: string, w: number) => `week:winners:${postId}:${w}`;
const WEEK_SEEDED_KEY = (postId: string, w: number) => `week:seeded:${postId}:${w}`;

async function getTimeOffsetMs(): Promise<number> {
  const raw = await redis.get(WEEK_TIME_OFFSET_KEY);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

async function nowMs(): Promise<number> { return Date.now() + await getTimeOffsetMs(); }

function startOfMondayWeekET(utcMs: number): number {
  // Snap to the Monday 00:00 UTC boundary at or before utcMs.
  // (Monday 00:00 UTC = Sunday 7:00 PM Colombia. Offset is 0 = pure UTC.)
  const shifted = utcMs - WEEK_BOUNDARY_OFFSET_MS;
  const d = new Date(shifted);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Days since last Monday: Sun(0)->6, Mon(1)->0, Tue(2)->1, etc.
  const daysSinceMonday = (day + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  const mondayStartMs = d.getTime() - (daysSinceMonday * 24 * 60 * 60 * 1000);
  return mondayStartMs + WEEK_BOUNDARY_OFFSET_MS;
}

function computeWeekNumber(anchorStartMs: number, now: number): number {
  if (now < anchorStartMs) return 1; // safety
  return Math.floor((now - anchorStartMs) / WEEK_MS) + 1;
}

function getWeekBoundariesFromAnchor(anchorStartMs: number, week: number) {
  const startMs = anchorStartMs + (week - 1) * WEEK_MS;
  return { startMs, endMs: startMs + WEEK_MS - 1 };
}

function pickWinner<T extends { votes: number; proposedAt: number; house?: boolean }>(items: T[]): T | undefined {
  return items.reduce((b, i) => {
    if (!b) return i;
    if (i.votes > b.votes) return i;
    if (i.votes < b.votes) return b;
    // Equal votes: a human proposal always beats a house (auto-seeded) one so
    // the house bundle is only a floor. Otherwise the earliest wins.
    const bHouse = !!(b as any).house, iHouse = !!(i as any).house;
    if (bHouse && !iHouse) return i;
    if (iHouse && !bHouse) return b;
    if (i.proposedAt < b.proposedAt) return i;
    return b;
  }, undefined as T | undefined);
}

// Normalize proposal types (support synonyms / language variants)
function normalizeProposalType(raw: any): string {
  if (typeof raw !== 'string') return '';
  const t = raw.toLowerCase();
  if (['palette','paleta','colors','colores','palette-colors','color-palette'].includes(t)) return 'palette';
  if (['brushkit','brush-kit','brushes','pinceles','pincel','brushes-kit'].includes(t)) return 'brushKit';
  if (['theme','tema','motif'].includes(t)) return 'theme';
  return raw;
}

// Ensure the week's ballot is never empty: if nobody has proposed a THEME yet,
// inject a house bundle (theme + palette + brushes, 1 vote each) so both the
// voting screen and the resulting weekly config are never blank. The house
// bundle loses vote ties to any human bundle (see pickWinner), so it only acts
// as a floor that promotes participation. Idempotent per (postId, week).
function proposalsHaveHouse(arr: any[]): boolean {
  return Array.isArray(arr) && arr.some((p: any) => p?.house === true || (typeof p?.id === 'string' && p.id.startsWith('house_')));
}

async function ensureWeekSeeded(postId: string, week: number): Promise<void> {
  if (!postId || week < 1) return;
  try {
    if (await redis.get(WEEK_SEEDED_KEY(postId, week))) return;
    const key = WEEK_PROPOSALS_KEY(postId, week);
    const raw = await redis.get(key);
    const proposals: any[] = raw ? JSON.parse(raw) : [];
    // Always seed the house pitch once per week — a COMPLETE, votable bundle — so the
    // ballot is never empty, regardless of any partial/lone human proposals. Users can
    // vote for it like any other pitch; it loses vote ties to humans (pickWinner), so it
    // wins only when unopposed or genuinely ahead.
    if (!proposalsHaveHouse(proposals)) {
      const bounds = await getAccurateWeekBoundaries(week);
      const proposedAt = bounds.startMs || (await nowMs());
      const house = buildHouseProposals(week, proposedAt);
      // Re-read immediately before writing to shrink the lost-update window against a
      // concurrent human proposal POST. This is not fully atomic (get+set are two
      // commands with no CAS/Lua here), so an extremely narrow race can still drop a
      // human proposal — but the ballot always keeps a COMPLETE house bundle, and this
      // matches the app's existing read-modify-write concurrency model for proposals.
      const raw2 = await redis.get(key);
      const proposals2: any[] = raw2 ? JSON.parse(raw2) : [];
      if (!proposalsHaveHouse(proposals2)) {
        await redis.set(key, JSON.stringify([...house, ...proposals2]));
        console.log('[seed] house bundle seeded for week', week, 'postId', postId);
      }
    }
    await redis.set(WEEK_SEEDED_KEY(postId, week), '1');
  } catch (e: any) {
    console.error('[seed] ensureWeekSeeded error', e?.message);
  }
}

async function ensureCurrentWeek(): Promise<number> {
  const now = await nowMs();
  let anchorStr = await redis.get(WEEK_ANCHOR_KEY);
  if (!anchorStr) {
    // First-time initialization: anchor is the Sunday of current time (ET)
    const anchor = startOfMondayWeekET(now);
    await redis.set(WEEK_ANCHOR_KEY, anchor.toString());
    await redis.set(CURRENT_WEEK_KEY, '1');
    return 1;
  }
  const anchorStartMs = parseInt(anchorStr, 10);
  const computedWeek = computeWeekNumber(anchorStartMs, now);
  const storedWeekStr = await redis.get(CURRENT_WEEK_KEY);
  let storedWeek = storedWeekStr ? parseInt(storedWeekStr, 10) : NaN;
  if (!storedWeek || storedWeek < computedWeek) {
    // Auto-advance
    storedWeek = computedWeek;
    await redis.set(CURRENT_WEEK_KEY, storedWeek.toString());
  }
  return storedWeek;
}

// getWeekBoundaries removed; use getAccurateWeekBoundaries(week) instead.

async function getAccurateWeekBoundaries(week: number) {
  const anchorStr = await redis.get(WEEK_ANCHOR_KEY);
  if (!anchorStr) return { startMs: 0, endMs: 0 };
  const anchor = parseInt(anchorStr, 10);
  return getWeekBoundariesFromAnchor(anchor, week);
}

async function computeWeekForTimestamp(ts:number):Promise<number>{
  const anchorStr = await redis.get(WEEK_ANCHOR_KEY);
  if(!anchorStr){ return 1; }
  const anchor = parseInt(anchorStr,10);
  return computeWeekNumber(anchor, ts);
}

const router = express.Router();

// --- Reddit Media API storage ---
// Uploads a base64 data URL to Reddit's CDN via the native media.upload() API.
// Returns the permanent i.redd.it URL, or null on failure.
async function uploadToRedditCDN(dataUrl: string): Promise<string | null> {
  try {
    const result = await media.upload({ url: dataUrl, type: 'image' });
    console.log('[media] uploaded to Reddit CDN:', result.mediaUrl);
    return result.mediaUrl;
  } catch (e: any) {
    console.error('[media] upload failed:', e?.message);
    return null;
  }
}

// Helper to store pending frame data URL separately from turn state (avoids JSON bloat)
const PENDING_FRAME_DATA_KEY = (postId: string) => `pending:frame:data:${postId}`;

// --- SHOWCASE ARCHITECTURE ---
// Structure per week:
//   1× Weekly announcement post (theme, palette, brushes — text only)
//   7× Day comments (replies to weekly post — text only, editable, grouped by artist)
//     N× Frame sub-comments (replies to day comment — 1 image each)
const SHOWCASE_WEEKLY_KEY = (_postId: string, week: number) => `showcase:v10:weekly:w${week}`;
const SHOWCASE_DAY_COMMENT_KEY = (week: number, dateStr: string) => `showcase:v10:daycomment:w${week}:${dateStr}`;
const SHOWCASE_DAILY_FRAMES_KEY = (week: number, dateStr: string) => `showcase:v10:dayframes:w${week}:${dateStr}`;
const SHOWCASE_WEEK_META_KEY = (week: number) => `showcase:v10:weekmeta:w${week}`;

function getUTCDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function formatDateHuman(ms: number): string {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const d = new Date(ms);
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function getDayOfWeek(nowMs: number, weekStartMs: number): number {
  return Math.min(7, Math.max(1, Math.floor((nowMs - weekStartMs) / (24 * 60 * 60 * 1000)) + 1));
}

interface DayFrameEntry {
  artist: string;
  imageUrl: string;
  frameNumber: number;
}

// Build the day comment text (text only, no images — editable)
// Groups frames by artist: u/artist1: Frame #1, #3 \n u/artist2: Frame #2
function buildDayCommentText(dayOfWeek: number, dateHuman: string, entries: DayFrameEntry[]): string {
  let text = `**📅 Day ${dayOfWeek} | ${dateHuman}**\n\n`;
  text += `${entries.length} frame${entries.length !== 1 ? 's' : ''}\n\n`;

  // Group by artist
  const artistOrder: string[] = [];
  const grouped: Record<string, number[]> = {};
  for (const entry of entries) {
    if (!grouped[entry.artist]) {
      grouped[entry.artist] = [];
      artistOrder.push(entry.artist);
    }
    grouped[entry.artist]!.push(entry.frameNumber);
  }
  for (const artist of artistOrder) {
    const frames = grouped[artist]!;
    text += `u/${artist}: Frame ${frames.map(n => `#${n}`).join(', ')}\n\n`;
  }
  return text.trim();
}

// --- ensureWeeklyShowcasePost (Gamino hSetNX pattern) ---
// Atomically ensures exactly ONE showcase post exists per week per subreddit.
// Returns the post ID if created or already exists, null on skip/error.
async function ensureWeeklyShowcasePost(callerPostId?: string): Promise<string | null> {
  const { subredditName } = context;
  if (!subredditName) {
    console.warn('[showcase] no subredditName — skipping');
    return null;
  }

  const now = await nowMs();
  const currentWeek = await ensureCurrentWeek();
  const weekKey = String(currentWeek);
  const dedupeHash = `weekly_showcase_posts:${subredditName}`;
  let reserved = false;

  try {
    // Atomic reserve: if weekKey already has a value, skip
    const reserveResult = await redis.hSetNX(dedupeHash, weekKey, 'pending');
    reserved = reserveResult === 1;

    if (!reserved) {
      // Post already exists for this week — return its ID
      const existingId = await redis.hGet(dedupeHash, weekKey);
      if (existingId && existingId.startsWith('t3_')) {
        console.log('[showcase] week', currentWeek, 'post already exists:', existingId);
        return existingId;
      }
      // If value is 'pending' from a failed previous attempt, allow retry
      if (existingId === 'pending') {
        console.log('[showcase] previous attempt was pending, retrying...');
        reserved = true; // allow creation below
      } else {
        return existingId || null;
      }
    }

    // Build the week metadata
    const anchorStr = await redis.get(WEEK_ANCHOR_KEY);
    const anchorMs = anchorStr ? parseInt(anchorStr, 10) : now;
    const weekBounds = getWeekBoundariesFromAnchor(anchorMs, currentWeek);
    const startDate = formatDateHuman(weekBounds.startMs);
    const endDate = formatDateHuman(weekBounds.endMs);

    let themeTitle: string | null = null;
    let paletteName: string | null = null;
    let paletteColors: string[] = [];
    let brushKitName: string | null = null;
    let brushNames: string[] = [];
    let directorName: string | null = null;

    if (currentWeek === 1) {
      const hb = getHouseBundle(1);
      themeTitle = hb.theme.name;
      paletteName = hb.palette.name;
      paletteColors = hb.palette.colors;
      brushKitName = hb.brushKit.name;
      brushNames = hb.brushKit.names;
      directorName = hb.director;
    } else {
      // Resolve previous week's winners — never empty (house preset fills gaps).
      const postId = callerPostId || context.postId || '';
      let w: any = postId ? await materializePreviousWeekWinners(postId, currentWeek) : null;
      if (!w) w = houseWinnersForWeek(currentWeek - 1);
      if (w.theme?.title) themeTitle = w.theme.title;
      if (w.theme?.proposedBy) directorName = w.theme.proposedBy;
      if (w.palette) {
        paletteName = w.palette.title || null;
        if (Array.isArray(w.palette.data?.colors)) paletteColors = w.palette.data.colors;
      }
      if (w.brushKit) {
        brushKitName = w.brushKit.title || null;
        if (Array.isArray(w.brushKit.data?.names)) brushNames = w.brushKit.data.names;
        else if (Array.isArray(w.brushKit.data?.brushes)) brushNames = w.brushKit.data.brushes.map((b: any) => typeof b === 'string' ? b : b.name || '');
      }
    }

    const title = themeTitle
      ? `🎬 ${themeTitle} | Kinora Week ${currentWeek}`
      : `🎬 Kinora Animations — Week ${currentWeek}`;

    const weekMeta = {
      week: currentWeek,
      theme: themeTitle || '',
      paletteName: paletteName || '',
      paletteColors,
      brushKitName: brushKitName || '',
      brushNames,
      directorName: directorName || '',
      startDate,
      endDate,
    };

    // Store metadata in Redis for the showcase client
    await redis.set(SHOWCASE_WEEK_META_KEY(currentWeek), JSON.stringify(weekMeta));
    console.log('[showcase] stored week meta for week', currentWeek);

    // Create the Reddit post
    console.log('[showcase] creating weekly custom post:', title);
    const post = await reddit.submitCustomPost({
      subredditName,
      title,
      entry: 'showcase',
      postData: { weekMeta },
    });

    // Finalize the dedupe hash with the real post ID
    await redis.hSet(dedupeHash, { [weekKey]: post.id });
    // Also keep the legacy key for backward compat
    await redis.set(SHOWCASE_WEEKLY_KEY('', currentWeek), post.id);
    console.log('[showcase] weekly post created:', post.id, 'for week', currentWeek);

    // NOTE: the previous week's animation GIF is scheduled by the cron handler via
    // schedulePreviousWeekAnimation() — NOT here — so it still runs when this weekly
    // post already exists (this function returns early on the dedup path above).

    return post.id;
  } catch (e: any) {
    // Clean up the reserve on failure so next attempt can retry
    if (reserved) {
      try { await redis.hDel(dedupeHash, [weekKey]); } catch {}
    }
    console.error('[showcase] weekly post failed:', e?.message);
    return null;
  }
}

// Main entry: add a frame to today's day comment on the weekly post
// 1. Get/create the weekly showcase post
// 2. Get/create today's day comment (text-only, on the weekly post)
// 3. Create a sub-comment reply on the day comment (with the frame image)
// 4. Edit the day comment to update the frame list
async function addFrameToDailyComment(
  showcasePostId: string,
  _postId: string,
  imageUrl: string,
  artist: string,
  week: number,
  frameNumber: number
): Promise<void> {
  const debugLog: string[] = [];
  const log = (msg: string) => { debugLog.push(`${new Date().toISOString()} ${msg}`); console.log('[showcase]', msg); };

  try {
    const now = await nowMs();
    const dateStr = getUTCDateString(now);
    const dateHuman = formatDateHuman(now);
    const anchorStr = await redis.get(WEEK_ANCHOR_KEY);
    const anchorMs = anchorStr ? parseInt(anchorStr, 10) : now;
    const weekBounds = getWeekBoundariesFromAnchor(anchorMs, week);
    const dayOfWeek = getDayOfWeek(now, weekBounds.startMs);

    const dayCommentKey = SHOWCASE_DAY_COMMENT_KEY(week, dateStr);
    const framesKey = SHOWCASE_DAILY_FRAMES_KEY(week, dateStr);
    log(`START week=${week} dateStr=${dateStr} day=${dayOfWeek}`);

    // Load existing frames for today
    let entries: DayFrameEntry[] = [];
    try {
      const raw = await redis.get(framesKey);
      if (raw) entries = JSON.parse(raw);
    } catch {}

    // Add the new frame
    entries.push({ artist, imageUrl, frameNumber });
    await redis.set(framesKey, JSON.stringify(entries));
    log(`frame ${entries.length} saved`);

    // Get or create today's day comment on the weekly post
    let dayCommentId = await redis.get(dayCommentKey);
    log(`dayCommentKey GET => ${dayCommentId || '(null)'}`);

    if (!dayCommentId || !dayCommentId.startsWith('t1_')) {
      // Create the day comment (text only — on the weekly post)
      log(`creating day comment for day ${dayOfWeek}`);
      const commentText = buildDayCommentText(dayOfWeek, dateHuman, entries);
      const dayComment = await reddit.submitComment({
        id: showcasePostId as `t3_${string}`,
        text: commentText,
      });
      dayCommentId = dayComment.id;
      await redis.set(dayCommentKey, dayCommentId);
      log(`day comment created: ${dayCommentId}`);
    } else {
      // Edit existing day comment to update the frame list
      log(`editing day comment ${dayCommentId} with ${entries.length} frames`);
      try {
        const commentText = buildDayCommentText(dayOfWeek, dateHuman, entries);
        const existingComment = await reddit.getCommentById(dayCommentId as `t1_${string}`);
        await existingComment.edit({ text: commentText });
        log(`day comment EDIT SUCCESS`);
      } catch (editErr: any) {
        log(`day comment edit failed: ${editErr?.message}`);
      }
    }

    // Create a sub-comment (reply to the day comment) with the frame image
    log(`creating frame sub-comment for frame #${frameNumber}`);
    try {
      const frameRt = new RichTextBuilder()
        .paragraph((p) => p.text({ text: `🖼️ Frame #${frameNumber} by u/${artist}` }))
        .image({ mediaUrl: imageUrl });
      await reddit.submitComment({
        id: dayCommentId as `t1_${string}`,
        richtext: frameRt,
      });
      log(`frame sub-comment posted for frame #${frameNumber}`);
    } catch (subErr: any) {
      log(`frame sub-comment failed: ${subErr?.message}`);
    }

  } catch (outerErr: any) {
    log(`ERROR: ${outerErr?.message}`);
  } finally {
    try {
      await redis.set('showcase:debug:last_run', JSON.stringify(debugLog));
    } catch {}
  }
}

// --- Showcase data endpoint (for the showcase custom post client) ---
router.get('/api/showcase-data', async (_req: any, res: any) => {
  try {
    const week = await ensureCurrentWeek();
    let metaRaw = await redis.get(SHOWCASE_WEEK_META_KEY(week));
    if (metaRaw) {
      try {
        const parsed = JSON.parse(metaRaw);
        // Self-heal corrupted Week 1 data
        if (week === 1 && parsed.theme !== 'Moving Lines') {
          const anyRedis: any = redis as any;
          if (typeof anyRedis.del === 'function') { await anyRedis.del(SHOWCASE_WEEK_META_KEY(1)); }
          else { await redis.set(SHOWCASE_WEEK_META_KEY(1), ''); }
          metaRaw = undefined;
        } else {
          return res.json(parsed);
        }
      } catch (e) {
        metaRaw = undefined;
      }
    }
    
    if (!metaRaw) {
      // Build a never-empty bundle when week metadata hasn't been stored yet.
      const now = await nowMs();
      const anchorStr = await redis.get(WEEK_ANCHOR_KEY);
      const anchorMs = anchorStr ? parseInt(anchorStr, 10) : now;
      const weekBounds = getWeekBoundariesFromAnchor(anchorMs, week);
      let theme = '', paletteName = '', paletteColors: string[] = [], brushKitName = '', brushNames: string[] = [], directorName = '';
      if (week === 1) {
        const hb = getHouseBundle(1);
        theme = hb.theme.name; paletteName = hb.palette.name; paletteColors = hb.palette.colors;
        brushKitName = hb.brushKit.name; brushNames = hb.brushKit.names; directorName = hb.director;
      } else {
        const { postId } = context;
        let w: any = postId ? await materializePreviousWeekWinners(postId, week) : null;
        if (!w) w = houseWinnersForWeek(week - 1);
        theme = w.theme?.title || w.theme?.data?.value || '';
        directorName = w.theme?.proposedBy || '';
        paletteName = w.palette?.title || '';
        paletteColors = Array.isArray(w.palette?.data?.colors) ? w.palette.data.colors : [];
        brushKitName = w.brushKit?.title || '';
        brushNames = Array.isArray(w.brushKit?.data?.names) ? w.brushKit.data.names : [];
      }
      res.json({
        week, theme, paletteName, paletteColors, brushKitName, brushNames, directorName,
        startDate: formatDateHuman(weekBounds.startMs),
        endDate: formatDateHuman(weekBounds.endMs),
      });
    }
  } catch (e: any) {
    res.json({ error: e?.message });
  }
});

// --- Debug endpoint to inspect showcase Redis state ---
router.get('/api/debug-showcase', async (_req: any, res: any) => {
  try {
    const { postId } = context;
    if (!postId) return res.json({ error: 'no postId' });
    const now = await nowMs();
    const dateStr = getUTCDateString(now);
    const week = await ensureCurrentWeek();
    const dayCommentKey = SHOWCASE_DAY_COMMENT_KEY(week, dateStr);
    const framesKey = SHOWCASE_DAILY_FRAMES_KEY(week, dateStr);
    const weeklyKey = SHOWCASE_WEEKLY_KEY(postId, week);
    const dayCommentId = await redis.get(dayCommentKey);
    const framesRaw = await redis.get(framesKey);
    const weeklyPostId = await redis.get(weeklyKey);
    const debugLogRaw = await redis.get('showcase:debug:last_run');
    let debugLog: string[] = [];
    try { if (debugLogRaw) debugLog = JSON.parse(debugLogRaw); } catch {}
    res.json({
      postId, week, dateStr,
      dayCommentKey, framesKey, weeklyKey,
      dayCommentId: dayCommentId || null,
      weeklyPostId: weeklyPostId || null,
      framesCount: framesRaw ? JSON.parse(framesRaw).length : 0,
      debugLog,
    });
  } catch (e: any) {
    res.json({ error: e?.message });
  }
});

// --- FULL RESET: clear frames + showcase state + delete showcase posts ---
router.get('/api/reset-showcase', async (_req: any, res: any) => {
  const log: string[] = [];
  try {
    const { postId, subredditName } = context;
    const week = await ensureCurrentWeek();
    const now = await nowMs();

    // 1. Clear frames list for this post
    if (postId) {
      const framesListKey = `frames:list:${postId}`;
      const framesRaw = await redis.get(framesListKey);
      if (framesRaw) {
        const frameKeys: string[] = JSON.parse(framesRaw);
        // Clear each individual frame
        for (const fk of frameKeys) {
          try { await redis.set(fk, ''); } catch {}
        }
        await redis.set(framesListKey, '[]');
        log.push(`cleared ${frameKeys.length} frames`);
      }
      // Clear frame counter
      try { await redis.set(`frame:counter:${postId}`, '0'); } catch {}
      log.push('frame counter reset');
    }

    // 2. Clear all showcase keys (v3 through v8)
    for (let v = 3; v <= 8; v++) {
      for (let w = 1; w <= week + 1; w++) {
        for (let d = 0; d < 14; d++) {
          const dt = new Date(now - d * 86400000);
          const ds = getUTCDateString(dt.getTime());
          const keys = [
            `showcase:v${v}:weekly:w${w}`,
            `showcase:v${v}:daycomment:w${w}:${ds}`,
            `showcase:v${v}:dailypost:w${w}:${ds}`,
            `showcase:v${v}:dayedit:w${w}:${ds}`,
            `showcase:v${v}:dayframes:w${w}:${ds}`,
            `showcase:v${v}:weekframes:w${w}`,
            `showcase:v${v}:weekmeta:w${w}`,
          ];
          for (const key of keys) {
            try { await redis.set(key, ''); } catch {}
          }
        }
      }
    }
    log.push('all showcase keys cleared (v3-v8)');

    // 3. Clear auto-reset flags
    for (const flag of ['showcase:auto_reset_v024', 'showcase:auto_reset_v026', 'showcase:debug:last_run']) {
      try { await redis.set(flag, ''); } catch {}
    }
    log.push('reset flags cleared');

    // 4. Delete all showcase posts (but NOT the main Kinora interactive post)
    if (subredditName) {
      try {
        const appUser = await reddit.getAppUser();
        if (appUser) {
          const appPosts = await reddit.getPostsByUser({ username: appUser.username, sort: 'new', limit: 100 }).all();
          let deletedCount = 0;
          for (const p of appPosts) {
            if (p.subredditName !== subredditName) continue;
            // Skip the main interactive app post (the one with just "Kinora" title and no emojis/week info)
            if (postId && p.id === postId) {
              log.push(`SKIPPED main app post: ${p.id} "${p.title}"`);
              continue;
            }
            // Delete everything else by the app
            const isShowcaseOrOld = (
              p.title?.includes('📅') ||
              p.title?.includes('🎬') ||
              p.title?.includes('Kinora Animations') ||
              p.title?.includes('Kinora Week') ||
              p.title?.includes('Kinora Day') ||
              p.title?.includes('Moving Lines') ||
              p.title?.includes('Day ') ||
              p.title?.includes('Week ')
            );
            if (isShowcaseOrOld) {
              try {
                await p.delete();
                deletedCount++;
                log.push(`deleted: ${p.id} "${p.title}"`);
              } catch (dErr: any) {
                log.push(`failed to delete ${p.id}: ${dErr?.message}`);
              }
            }
          }
          log.push(`deleted ${deletedCount} showcase posts`);
        }
      } catch (userErr: any) {
        log.push(`post cleanup failed: ${userErr?.message}`);
      }
    }

    res.json({ ok: true, log });
  } catch (e: any) {
    res.json({ error: e?.message, log });
  }
});

// --- Keep only the last frame, delete all others, renumber as #1 ---
router.get('/api/keep-last-frame', async (_req: any, res: any) => {
  const log: string[] = [];
  try {
    const { postId } = context;
    if (!postId) return res.json({ error: 'no postId' });

    const framesListKey = `frames:list:${postId}`;
    const framesRaw = await redis.get(framesListKey);
    if (!framesRaw) return res.json({ error: 'no frames list', log });

    const frameKeys: string[] = JSON.parse(framesRaw);
    if (frameKeys.length === 0) return res.json({ error: 'no frames', log });

    const lastKey = frameKeys[frameKeys.length - 1];
    log.push(`keeping last frame: ${lastKey}`);

    // Delete all frames except the last one
    for (let i = 0; i < frameKeys.length - 1; i++) {
      try { await redis.set(`frames:data:${postId}:${frameKeys[i]}`, ''); } catch {}
    }
    log.push(`deleted ${frameKeys.length - 1} old frames`);

    // Update the frames list to only contain the last frame
    await redis.set(framesListKey, JSON.stringify([lastKey]));
    log.push('frames list updated to [lastKey]');

    // Reset counter to 1
    await redis.set(`frame:counter:${postId}`, '1');
    log.push('frame counter reset to 1');

    // Clear all showcase day frames for current week so the comment gets rebuilt fresh
    const week = await ensureCurrentWeek();
    const now = await nowMs();
    for (let d = 0; d < 14; d++) {
      const dt = new Date(now - d * 86400000);
      const ds = getUTCDateString(dt.getTime());
      const dayFramesKey = SHOWCASE_DAILY_FRAMES_KEY(week, ds);
      const dayCommentKey = SHOWCASE_DAY_COMMENT_KEY(week, ds);
      try { await redis.set(dayFramesKey, ''); } catch {}
      try { await redis.set(dayCommentKey, ''); } catch {}
    }
    log.push('showcase day frames/comments cleared');

    // Delete old showcase sub-comments (frame image comments) from Reddit
    const weeklyKey = SHOWCASE_WEEKLY_KEY(postId, week);
    const weeklyPostId = await redis.get(weeklyKey);
    if (weeklyPostId && weeklyPostId.startsWith('t3_')) {
      try {
        const post = await reddit.getPostById(weeklyPostId as `t3_${string}`);
        const comments = await post.comments.all();
        let deletedComments = 0;
        for (const c of comments) {
          // Delete all comments (day comments and frame sub-comments)
          try {
            await c.delete();
            deletedComments++;
          } catch {}
        }
        log.push(`deleted ${deletedComments} comments from showcase post`);
      } catch (cErr: any) {
        log.push(`comment cleanup failed: ${cErr?.message}`);
      }
    }

    res.json({ ok: true, keptFrame: lastKey, log });
  } catch (e: any) {
    res.json({ error: e?.message, log });
  }
});



router.get<{ postId: string }, InitResponse | { status: string; message: string }>(
  '/api/init',
  async (_req, res): Promise<void> => {
    const { postId: contextPostId } = context;
    if (!contextPostId) {
      console.error('API Init Error: postId not found in devvit context');
      res.status(400).json({ status: 'error', message: 'postId is required but missing from context' });
      return;
    }

    // Resolve the effective postId: if this post has no frames (e.g. a splash post),
    // fall back to the stored main post ID so the app shows the real data.
    let postId = contextPostId;
    const hasFrames = await redis.get(`frame:counter:${contextPostId}`);
    if (!hasFrames) {
      const mainId = await redis.get('kinora:main_post_id');
      if (mainId) {
        postId = mainId as typeof postId;
      }
    } else {
      // This post has frame data — it's the real main post. Store its ID.
      try { await redis.set('kinora:main_post_id', contextPostId); } catch {}
    }

    try {
      const [count, username] = await Promise.all([
        redis.get('count'),
        reddit.getCurrentUsername(),
      ]);

      res.json({
        type: 'init',
        postId: postId,
        count: count ? parseInt(count) : 0,
        username: username ?? 'anonymous',
      });
    } catch (error) {
      console.error(`API Init Error for post ${postId}:`, error);
      let errorMessage = 'Unknown error during initialization';
      if (error instanceof Error) {
        errorMessage = `Initialization failed: ${error.message}`;
      }
      res.status(400).json({ status: 'error', message: errorMessage });
    }
  }
);

router.post<{ postId: string }, IncrementResponse | { status: string; message: string }, unknown>(
  '/api/increment',
  async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      res.status(400).json({ status: 'error', message: 'postId is required' });
      return;
    }
    res.json({ count: await redis.incrBy('count', 1), postId, type: 'increment' });
  }
);

router.post<{ postId: string }, DecrementResponse | { status: string; message: string }, unknown>(
  '/api/decrement',
  async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      res.status(400).json({
        status: 'error',
        message: 'postId is required',
      });
      return;
    }

    res.json({
      count: await redis.incrBy('count', -1),
      postId,
      type: 'decrement',
    });
  }
);

router.post('/internal/on-app-install', async (_req, res): Promise<void> => {
  try {
    const post = await createPost();
    // Store the main app post ID so splash posts can link to it
    await redis.set('kinora:main_post_id', post.id);

    res.json({
      status: 'success',
      message: `Post created in subreddit ${context.subredditName} with id ${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: 'error',
      message: 'Failed to create post',
    });
  }
});

router.post('/internal/menu/post-create', async (_req, res): Promise<void> => {
  try {
    const post = await createPost();
    // Store the main app post ID so splash posts can link to it
    await redis.set('kinora:main_post_id', post.id);

    res.json({
      navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: 'error',
      message: 'Failed to create post',
    });
  }
});

// Menu action: create a splash invitation post (clapperboard + Animate button)
router.post('/internal/menu/splash-create', async (_req, res): Promise<void> => {
  try {
    const { subredditName } = context;
    if (!subredditName) {
      res.status(400).json({ status: 'error', message: 'subredditName required' });
      return;
    }
    const post = await reddit.submitCustomPost({
      entry: 'default',
      subredditName,
      title: '🎬 Kinora — Join the Animation',
    });
    res.json({
      navigateTo: `https://reddit.com/r/${subredditName}/comments/${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating splash post: ${error}`);
    res.status(400).json({ status: 'error', message: 'Failed to create splash post' });
  }
});

// API to get the main Kinora app post URL (for splash posts)
router.get('/api/main-post', async (_req, res) => {
  try {
    const { subredditName } = context;
    let mainPostId = await redis.get('kinora:main_post_id');
    // Fallback: if not stored yet, use the current context postId (works if called from the main post)
    if (!mainPostId) {
      mainPostId = context.postId || undefined;
    }
    if (mainPostId && subredditName) {
      res.json({ ok: true, postId: mainPostId, url: `https://www.reddit.com/r/${subredditName}/comments/${mainPostId}` });
    } else {
      res.json({ ok: false, url: `https://www.reddit.com/r/${subredditName || 'kinora'}` });
    }
  } catch (e: any) {
    res.json({ ok: false, url: 'https://www.reddit.com/r/kinora' });
  }
});

// --- Simple 2h window turn system (local Reddit-only) ---
interface TurnState {
  currentArtist: string | null;
  windowStart: number; // ms
  windowEnd: number;   // ms
  started: boolean;
  hasPendingFrame?: boolean; // flag only; actual data stored in separate Redis key
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TURN_KEY = 'turn:current';

async function loadTurn(): Promise<TurnState> {
  const raw = await redis.get(TURN_KEY);
  const now = Date.now();
  if (raw) {
    try {
      const parsed: TurnState = JSON.parse(raw);
      // If there was an active turn and it expired, reset to idle
      if (parsed.started && parsed.windowEnd > 0 && now >= parsed.windowEnd) {
        return await resetTurnWindow();
      }
      return parsed;
    } catch {
      return await resetTurnWindow();
    }
  }
  return await resetTurnWindow();
}

async function resetTurnWindow(): Promise<TurnState> {
  // Idle state: no active artist and no ticking window
  const state: TurnState = { currentArtist: null, windowStart: 0, windowEnd: 0, started: false, hasPendingFrame: false };
  await redis.set(TURN_KEY, JSON.stringify(state));
  return state;
}

async function saveTurn(state: TurnState) {
  await redis.set(TURN_KEY, JSON.stringify(state));
}

router.get('/api/turn', async (_req, res) => {
  try {
    const state = await loadTurn();
    const now = Date.now();
    const timeToEndSeconds = (state.started && state.currentArtist)
      ? Math.max(0, Math.floor((state.windowEnd - now) / 1000))
      : 0;
    res.json({
      currentArtist: state.currentArtist,
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      started: state.started,
      timeToEndSeconds
    });
  } catch(e:any) {
    console.error('[turn:get] error', e?.message);
    res.status(500).json({ error: 'turn failed' });
  }
});

router.post('/api/turn', async (_req, res) => {
  try {
    // Resolve identity from Reddit (preferred) or client-provided fallback
    const resolveUser = async (req: any): Promise<string> => {
      try {
        const u = await reddit.getCurrentUsername();
        if (u) return u;
      } catch {}
      const bodyUser = typeof req?.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : '';
      const headerUser = typeof req?.headers?.['x-user'] === 'string' && (req.headers['x-user'] as string).trim() ? (req.headers['x-user'] as string).trim() : '';
      return bodyUser || headerUser || 'anonymous';
    };
    const username = await resolveUser(_req);
    let state = await loadTurn();
    const now = Date.now();
    // If expired while active, reset to idle then allow claim
    if (state.started && state.windowEnd > 0 && now >= state.windowEnd) {
      state = await resetTurnWindow();
    }
    // Distinguish between explicit 'start' and 'resume' actions to avoid accidental re-claim after finalize
    const action = typeof _req?.body?.action === 'string' ? String(_req.body.action).toLowerCase() : 'start';

    if (action === 'resume') {
      // Resume should NEVER claim a new window. It only reaffirms if this user is the current artist in an active window.
      const active = state.started && !!state.currentArtist && now < state.windowEnd;
      const sameUser = active && state.currentArtist === username;
      return res.json({ ok: true, action: 'resume', active, sameUser, claimed: false, currentArtist: state.currentArtist });
    }

    // action === 'start' (or default): claim if idle; otherwise report current artist
    if (!state.started || !state.currentArtist) {
      // first come first serve claim
      state.currentArtist = username;
      state.started = true;
      // Start 2h window at claim time
      state.windowStart = now;
      state.windowEnd = now + TWO_HOURS_MS;
      await saveTurn(state);
      await broadcastSpectate(context.postId, { t: 'turn', a: state.currentArtist, windowEnd: state.windowEnd });
      return res.json({ ok: true, action: 'start', claimed: true, currentArtist: state.currentArtist });
    }
    // If same user as current artist, confirm continuity (but don't extend window)
    if (state.currentArtist === username) {
      return res.json({ ok: true, action: 'start', claimed: true, currentArtist: state.currentArtist });
    }
    return res.json({ ok: true, action: 'start', claimed: false, currentArtist: state.currentArtist });
  } catch(e:any) {
    console.error('[turn:post] error', e?.message);
    res.status(500).json({ error: 'turn claim failed' });
  }
});

// Pending frame endpoints (data stored separately from turn state to avoid JSON bloat)
router.get('/api/pending-frame', async (_req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.json({ pending: null });
    const state = await loadTurn();
    if (state.hasPendingFrame) {
      const raw = await redis.get(PENDING_FRAME_DATA_KEY(postId));
      if (raw) {
        try {
          const data = JSON.parse(raw);
          // data may have mediaUrl (uploaded to Reddit CDN) or dataUrl (legacy/fallback)
          const url = data.mediaUrl || data.dataUrl || '';
          return res.json({ pending: { url, lastModified: data.updated, artist: data.artist } });
        } catch {}
      }
    }
    res.json({ pending: null });
  } catch(e:any) {
    console.error('[pending:get] error', e?.message);
    res.status(500).json({ error: 'pending failed' });
  }
});

router.post('/api/pending-frame', async (req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.status(400).json({ error: 'post not found' });
    // Resolve identity from Reddit (preferred) or client-provided fallback header/body
    const resolveUser = async (): Promise<string> => {
      try {
        const u = await reddit.getCurrentUsername();
        if (u) return u;
      } catch {}
      const bodyUser = typeof req?.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : '';
      const headerUser = typeof req?.headers?.['x-user'] === 'string' && (req.headers['x-user'] as string).trim() ? (req.headers['x-user'] as string).trim() : '';
      return bodyUser || headerUser || 'anonymous';
    };
    const username = await resolveUser();
    let state = await loadTurn();
    if (username !== state.currentArtist) return res.status(403).json({ error: 'not artist' });
    const { dataUrl } = req.body || {};
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) return res.status(400).json({ error: 'invalid dataUrl' });
    // Upload to Reddit CDN IMMEDIATELY (avoids storing huge data URL in Redis)
    console.log('[pending:post] uploading to Reddit CDN...', dataUrl.length, 'chars');
    const mediaUrl = await uploadToRedditCDN(dataUrl);
    if (mediaUrl) {
      console.log('[pending:post] uploaded successfully:', mediaUrl);
      // Store only the small URL string in Redis (not the huge data URL)
      await redis.set(PENDING_FRAME_DATA_KEY(postId), JSON.stringify({ mediaUrl, updated: Date.now(), artist: username }));
    } else {
      console.warn('[pending:post] CDN upload failed, storing dataUrl in Redis as fallback');
      // Fallback: store data URL directly (may fail for large images)
      await redis.set(PENDING_FRAME_DATA_KEY(postId), JSON.stringify({ dataUrl, updated: Date.now(), artist: username }));
    }
    state.hasPendingFrame = true;
    await saveTurn(state);
    // Broadcast a keyframe so spectators self-heal (repaint the authoritative base) between
    // the lightweight realtime stroke deltas.
    if (mediaUrl) await broadcastSpectate(postId, { t: 'key', a: username, url: mediaUrl, ver: Date.now() });
    res.json({ ok: true, storage: mediaUrl ? 'reddit' : 'redis' });
  } catch(e:any) {
    console.error('[pending:post] error', e?.message);
    res.status(500).json({ error: 'pending store failed' });
  }
});

router.delete('/api/pending-frame', async (_req, res) => {
  try {
    const { postId } = context;
    let state = await loadTurn();
    state.hasPendingFrame = false;
    await saveTurn(state);
    // Clean up separate data key
    if (postId) {
      try { await redis.set(PENDING_FRAME_DATA_KEY(postId), ''); } catch {}
    }
    res.json({ ok: true });
  } catch(e:any) {
    console.error('[pending:delete] error', e?.message);
    res.status(500).json({ error: 'pending delete failed' });
  }
});

// Finalize current turn: persist pending frame (if exists) into Redis frame list and reset window
router.post('/api/finalize-turn', async (_req, res) => {
  try {
    let state = await loadTurn();
    const { postId } = context;
    if (!postId) return res.status(400).json({ error: 'post not found' });
    // Persist pending frame if present
    if (state.hasPendingFrame && state.currentArtist) {
      // Load pending data from separate Redis key (should contain mediaUrl from CDN upload)
      const pendingRaw = await redis.get(PENDING_FRAME_DATA_KEY(postId));
      let mediaUrl: string | null = null;
      let dataUrl: string | null = null;
      if (pendingRaw) {
        try {
          const pd = JSON.parse(pendingRaw);
          mediaUrl = pd.mediaUrl || null;
          dataUrl = pd.dataUrl || null;
        } catch {}
      }
      const hasContent = !!(mediaUrl || dataUrl);
      if (hasContent) {
        // Ensure week anchor/current week exist before computing week for timestamp
        await ensureCurrentWeek();
        const ts = await nowMs();
        const week = await computeWeekForTimestamp(ts);
        const key = `frames/week-${week}/${ts.toString(36)}.png`;
        let stored: StoredFrame;
        if (mediaUrl) {
          // Already uploaded to Reddit CDN during pending-frame save
          console.log('[finalize-turn] using pre-uploaded CDN URL:', mediaUrl);
          stored = { key, mediaUrl, timestamp: ts, artist: state.currentArtist, week, storage: 'reddit', contentType: 'image/png' };
        } else if (dataUrl) {
          // Legacy fallback: try uploading now
          console.log('[finalize-turn] attempting CDN upload from dataUrl fallback...');
          const url = await uploadToRedditCDN(dataUrl);
          if (url) {
            stored = { key, mediaUrl: url, timestamp: ts, artist: state.currentArtist, week, storage: 'reddit', contentType: 'image/png' };
          } else {
            stored = { key, dataUrl, timestamp: ts, artist: state.currentArtist, week, storage: 'redis' };
          }
        } else {
          stored = { key, timestamp: ts, artist: state.currentArtist, week, storage: 'redis' };
        }
        await redis.set(`frames:data:${postId}:${key}`, JSON.stringify(stored));
        // update list
        const frameKeysStr = await redis.get(`frames:list:${postId}`);
        const frameKeys: string[] = frameKeysStr ? JSON.parse(frameKeysStr) : [];
        frameKeys.push(key);
        await redis.set(`frames:list:${postId}`, JSON.stringify(frameKeys));
        // Keep the canvas post id current so the weekly animation cron always finds
        // the frames on the post they were actually saved to.
        try { await redis.set('kinora:main_post_id', postId); } catch {}
        console.log('[finalize-turn] frame stored:', key, 'storage:', stored.storage);

        // --- Auto-post to weekly showcase (daily editable comment) ---
        if (stored.mediaUrl) {
          try {
            const showcaseId = await ensureWeeklyShowcasePost(postId);
            if (showcaseId) {
              await addFrameToDailyComment(showcaseId, postId, stored.mediaUrl, state.currentArtist!, week, frameKeys.length);
            }
          } catch (showcaseErr: any) {
            console.warn('[finalize-turn] showcase auto-comment failed (non-fatal):', showcaseErr?.message);
          }
        }
      }
      // Clean up pending data key
      try { await redis.set(PENDING_FRAME_DATA_KEY(postId), ''); } catch {}
    }
    // Reset window so Start Turn is available immediately
    state = await resetTurnWindow();
    await saveTurn(state);
    // Tell spectators the turn ended so they clear the LIVE indicator immediately.
    await broadcastSpectate(postId, { t: 'turn', a: null, windowEnd: 0 });
    // Read showcase debug log
    let showcaseDebug: string[] = [];
    try {
      const dbg = await redis.get('showcase:debug:last_run');
      if (dbg) showcaseDebug = JSON.parse(dbg);
    } catch {}
    res.json({ ok: true, reset: true, showcaseDebug });
  } catch(e:any) {
    console.error('[finalize-turn] error', e?.message);
    res.status(500).json({ error: 'finalize failed' });
  }
});

// --- Live spectating over Devvit realtime -------------------------------------------
// The artist's stroke batches round-trip through the server (clients cannot publish on
// realtime directly), which relays them to spectators. Channel is scoped to the post.
function spectateChannel(postId: string): string {
  // postId is `t3_...` (alphanumeric + underscore), so it passes realtime's channel validator.
  return `spectate_${postId}`;
}
async function broadcastSpectate(postId: string | undefined, msg: any): Promise<void> {
  if (!postId) return;
  try {
    await realtime.send(spectateChannel(postId), msg);
  } catch (e: any) {
    console.warn('[spectate] realtime send failed (non-fatal):', e?.message);
  }
}

// Artist streams smoothed stroke segments here; server relays to spectators in realtime.
router.post('/api/stroke', async (req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.status(400).json({ error: 'post not found' });
    const resolveUser = async (): Promise<string> => {
      try { const u = await reddit.getCurrentUsername(); if (u) return u; } catch {}
      const b = typeof req?.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : '';
      const h = typeof req?.headers?.['x-user'] === 'string' && (req.headers['x-user'] as string).trim() ? (req.headers['x-user'] as string).trim() : '';
      return b || h || 'anonymous';
    };
    const username = await resolveUser();
    const state = await loadTurn();
    if (username !== state.currentArtist) return res.status(403).json({ error: 'not artist' });
    const segs = req.body?.segs;
    if (!Array.isArray(segs) || !segs.length) return res.json({ ok: true, skipped: true });
    await broadcastSpectate(postId, { t: 'stroke', a: username, b: req.body?.b || {}, segs });
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[stroke] error', e?.message);
    res.status(500).json({ error: 'stroke failed' });
  }
});

// Artist relays discrete canvas events (clear / fill) to spectators in realtime.
router.post('/api/spectate', async (req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.status(400).json({ error: 'post not found' });
    const resolveUser = async (): Promise<string> => {
      try { const u = await reddit.getCurrentUsername(); if (u) return u; } catch {}
      const b = typeof req?.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : '';
      const h = typeof req?.headers?.['x-user'] === 'string' && (req.headers['x-user'] as string).trim() ? (req.headers['x-user'] as string).trim() : '';
      return b || h || 'anonymous';
    };
    const username = await resolveUser();
    const state = await loadTurn();
    if (username !== state.currentArtist) return res.status(403).json({ error: 'not artist' });
    const t = req.body?.t;
    if (t === 'clear') {
      await broadcastSpectate(postId, { t: 'clear', a: username });
    } else if (t === 'fill') {
      await broadcastSpectate(postId, { t: 'fill', a: username, x: req.body.x, y: req.body.y, c: req.body.c });
    } else {
      return res.json({ ok: true, skipped: true });
    }
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[spectate] error', e?.message);
    res.status(500).json({ error: 'spectate failed' });
  }
});

// Removed external proxy overrides to ensure purely local Reddit-only operation.

// --- Redis-based persistent storage for frames (shared across all users) ---
interface StoredFrame {
  key: string;
  mediaUrl?: string;    // Reddit CDN URL (i.redd.it/...) — new primary storage
  dataUrl?: string;     // Legacy: base64 data URL (redis-only fallback)
  timestamp: number;
  artist: string;
  week?: number;
  status?: string; // 'active' | 'flagged'
  storage?: 'redis' | 'r2' | 'reddit';  // 'reddit' = Reddit CDN via media.upload
  size?: number; // bytes
  contentType?: string; // e.g., image/png
}

// ---- Frame storage helpers (defensive) ----
function FRAME_LIST_KEY(postId: string){ return `frames:list:${postId}`; }
function FRAME_DATA_KEY(postId: string, frameKey: string){ return `frames:data:${postId}:${frameKey}`; }

async function loadFrameKeys(postId: string): Promise<string[]> {
  const raw = await redis.get(FRAME_LIST_KEY(postId));
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

async function saveFrameKeys(postId: string, keys: string[]): Promise<void> {
  await redis.set(FRAME_LIST_KEY(postId), JSON.stringify(keys));
}

async function loadFrame(postId: string, frameKey: string): Promise<StoredFrame | null> {
  const raw = await redis.get(FRAME_DATA_KEY(postId, frameKey));
  if (!raw) return null;
  if (!raw.trim()) return null; // treat empty string as deleted tombstone
  try { return JSON.parse(raw); } catch { return null; }
}

async function deleteFrameData(postId: string, frameKey: string){
  // Prefer redis.del if available (Devvit redis shim may or may not expose) – fallback to empty tombstone
  const anyRedis: any = redis as any;
  if (typeof anyRedis.del === 'function') {
    try { await anyRedis.del(FRAME_DATA_KEY(postId, frameKey)); return; } catch {}
  }
  await redis.set(FRAME_DATA_KEY(postId, frameKey), '');
}

// List frames from Redis storage (canonical route)
router.get('/api/list-frames', async (req, res) => {
  // Robust listing that tolerates corrupt / missing entries without failing entire request.
  try {
    const { postId } = context;
    if (!postId) return res.json({ frames: [] });
    // Ensure week anchor and current week are materialized for correct week computations
    await ensureCurrentWeek();
    const filterWeek = req.query.week ? parseInt(String(req.query.week),10) : undefined;
    const group = req.query.group === '1' || req.query.group === 'true';
    // New pagination params
  let page = req.query.page ? Math.max(1, parseInt(String(req.query.page),10)) : 1;
  const pageSizeParam = req.query.pageSize || req.query.limit; // backward compatibility
  let pageSize = pageSizeParam ? Math.max(1, Math.min(200, parseInt(String(pageSizeParam),10))) : 50;
    const metaOnly = req.query.meta === '1' || req.query.meta === 'true';
    let frameKeys = await loadFrameKeys(postId);
    const invalid: string[] = [];
    // Sort by insertion (original order) then we will slice based on pagination *after* filtering invalids and week
    // We iterate full list but stop if size guard triggers.
    // Response size guard: approximate serialized JSON bytes to stay under ~3MB (safety below 4MB gRPC)
    const MAX_BYTES = 3 * 1024 * 1024; // 3MB safety ceiling
    let approxBytes = 0;
    // Pre-calculate slice boundaries (we still need to know total after filtering to expose totalPages)
    const accepted: any[] = [];
    // The viewer is the same for the whole request: resolving it per frame cost one Reddit API
    // round-trip per frame, which is what made this endpoint scale with history length.
    let me: string | undefined;
    try { me = await reddit.getCurrentUsername(); } catch { /* anon */ }
    for (const key of frameKeys) {
      try {
        const frameData = await loadFrame(postId, key);
        if (!frameData) { invalid.push(key); continue; }
        if (frameData.status && frameData.status !== 'active') continue;
        // votes
        const vraw = await redis.get(VOTES_KEY(postId, key));
        let votesUp = 0, votesDown = 0; let myVote: -1|0|1 = 0;
        if (vraw) { try { const v = JSON.parse(vraw); votesUp = v.up||0; votesDown = v.down||0; } catch{} }
        if (me && vraw) {
          try { const v = JSON.parse(vraw); const by = v.by||{}; myVote = by[me] ?? 0; } catch {}
        }
        // week derivation
        let week: number;
        if (typeof frameData.week === 'number') {
          week = frameData.week;
        } else {
          const m = key.match(/week-(\d+)\//);
          if (m && m[1]) week = parseInt(m[1],10); else {
            week = await computeWeekForTimestamp(frameData.timestamp);
            frameData.week = week;
            await redis.set(FRAME_DATA_KEY(postId, key), JSON.stringify(frameData));
          }
        }
        if (filterWeek && week !== filterWeek) continue;
        // Determine public src: Reddit CDN URL > legacy proxy path
        let publicSrc: string;
        if (frameData.storage === 'reddit' && frameData.mediaUrl) {
          publicSrc = frameData.mediaUrl;
        } else {
          publicSrc = `/api/frame/${encodeURIComponent(frameData.key)}`;
        }
        const frameOut = {
          key: frameData.key,
          lastModified: frameData.timestamp,
          artist: frameData.artist || 'anonymous',
          week,
          votesUp,
          votesDown,
          myVote,
          src: publicSrc,
          url: (metaOnly || frameData.storage === 'reddit' || frameData.storage === 'r2') ? undefined : frameData.dataUrl
        };
        accepted.push(frameOut);
      } catch(err:any) {
        console.warn('[frames:list] skipping corrupt frame key', key, err?.message);
        invalid.push(key);
      }
    }
    if (invalid.length) {
      // Clean list (best-effort, ignore errors)
      try { frameKeys = frameKeys.filter(k => !invalid.includes(k)); await saveFrameKeys(postId, frameKeys); } catch {}
    }
  // Sort newest-first BEFORE size guard so if we must degrade (remove url) we degrade older frames first
  accepted.sort((a,b)=> b.lastModified - a.lastModified);
    const total = accepted.length;
    // If no explicit pagination params provided, return ALL frames (subject to size guard w/ degradation)
    const noExplicitPaging = !req.query.page && !req.query.pageSize && !req.query.limit;
    if (noExplicitPaging) {
      pageSize = total || 1;
      page = 1;
    }
  const totalPages = Math.max(1, Math.ceil(total / (pageSize||1)));
    const start = (page - 1) * pageSize;
  const pageItems = accepted.slice(start, start + pageSize);
    // Apply size guard (truncate if necessary)
    const safeItems: any[] = [];
    let truncated = false;
    let autoDowngraded = false;
    let downgradedCount = 0;
  for (const original of pageItems) {
      let item: any = original;
      let est = JSON.stringify(item).length + 2;
      if (approxBytes + est > MAX_BYTES) {
        // Try degrade by removing url (keeps metadata so week grouping still complete)
        if (!metaOnly && item.url) {
          const degraded = { ...item }; delete degraded.url;
          const estMeta = JSON.stringify(degraded).length + 2;
            if (approxBytes + estMeta <= MAX_BYTES) {
              item = degraded; est = estMeta; autoDowngraded = true; downgradedCount++;
            } else { truncated = true; break; }
        } else { truncated = true; break; }
      }
      approxBytes += est;
      safeItems.push(item);
    }
  // Re-sort safe items oldest-first for stable chronological consumption by clients that expect ascending order
  safeItems.sort((a,b)=> a.lastModified - b.lastModified);
  if (group) {
      const byWeek: Record<string, any[]> = {};
      for (const f of safeItems) {
        const wk = (f.week ?? 0).toString();
        if(!byWeek[wk]) byWeek[wk] = [];
        const copy = { ...f };
        if (metaOnly) delete (copy as any).url;
        byWeek[wk].push(copy);
      }
      return res.json({ framesByWeek: byWeek, invalidRemoved: invalid.length, page, totalPages, pageSize, total, truncated, metaOnly, autoDowngraded, downgradedCount });
    }
  // Remove undefined url fields to reduce payload; always keep src
  for (const f of safeItems) { if (metaOnly) delete (f as any).url; }
    res.json({ frames: safeItems, invalidRemoved: invalid.length, page, totalPages, pageSize, total, truncated, metaOnly, autoDowngraded, downgradedCount });
  } catch(e:any){
    console.error('[devvit r2/frames] fatal list error', e?.message);
    res.status(500).json({ frames: [], error: 'list failed', message: e?.message });
  }
});

// Get single frame (redirect to Reddit CDN or serve from Redis legacy)
router.get('/api/frame/:key', async (req, res) => {
  try {
    const { postId } = context;
    const key = req.params.key;
    if (!postId) return res.status(404).json({ error: 'post not found' });
    const frameDataStr = await redis.get(`frames:data:${postId}:${key}`);
    if (!frameDataStr) return res.status(404).json({ error: 'frame not found' });
    const frameData: StoredFrame = JSON.parse(frameDataStr);
    // Reddit CDN storage: redirect to permanent i.redd.it URL
    if (frameData.storage === 'reddit' && frameData.mediaUrl) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.redirect(302, frameData.mediaUrl);
    }
    // Legacy R2 storage: redirect if mediaUrl present (migrated), else 404
    if (frameData.storage === 'r2') {
      if (frameData.mediaUrl) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.redirect(302, frameData.mediaUrl);
      }
      // R2 files without mediaUrl are no longer accessible (R2 removed)
      // Fall through to dataUrl if somehow present
    }
    // Legacy Redis storage: serve from stored dataUrl
    if (frameData.dataUrl) {
      const base64 = frameData.dataUrl.split(',')[1];
      if (!base64) return res.status(400).json({ error: 'invalid data URL' });
      const buffer = Buffer.from(base64, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.end(buffer);
    }
    return res.status(404).json({ error: 'image not available' });
  } catch(e: any) {
    console.error('[frame] error', e?.message);
    res.status(500).json({ error: 'fail' });
  }
});

// Upload frame to Reddit CDN
router.post('/api/upload-frame', async (req, res) => {
  try {
    const { postId } = context;
    const { dataUrl } = req.body || {};
    
    if (!postId) return res.status(400).json({ error: 'post not found' });
    
    console.log('[upload-frame] incoming', dataUrl ? dataUrl.length : 0, 'postId', postId);
    
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ error: 'invalid dataUrl' });
    }
    
    const base64 = dataUrl.split(',')[1] || '';
    const size = Math.ceil(base64.length * 3 / 4);
    
    if (size > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'too large (max 5MB)' });
    }
    
    const ts = await nowMs();
    const id = ts.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const week = await computeWeekForTimestamp(ts);
    const key = `frames/week-${week}/${id}.png`;
    
    const username = await reddit.getCurrentUsername();
    let stored: StoredFrame;
    // Upload to Reddit CDN
    const mediaUrl = await uploadToRedditCDN(dataUrl);
    if (mediaUrl) {
      stored = { key, mediaUrl, timestamp: ts, artist: username || 'anonymous', week, storage: 'reddit', size, contentType: 'image/png' };
    } else {
      // Fallback to Redis storage
      stored = { key, dataUrl, timestamp: ts, artist: username || 'anonymous', week, storage: 'redis' };
    }
    await redis.set(`frames:data:${postId}:${key}`, JSON.stringify(stored));
    
    // Update frames list
    const frameKeysStr = await redis.get(`frames:list:${postId}`);
    const frameKeys: string[] = frameKeysStr ? JSON.parse(frameKeysStr) : [];
    frameKeys.push(key);
    await redis.set(`frames:list:${postId}`, JSON.stringify(frameKeys));
    
    console.log('[upload-frame] stored', key, 'storage:', stored.storage, 'for post', postId);
    res.json({ ok: true, key, url: mediaUrl || dataUrl });
  } catch(e: any) {
    console.error('[upload-frame] error', e?.message);
    res.status(500).json({ error: 'upload failed', message: e?.message });
  }
});

// NOTE: /api/list-frames now defined above as canonical; previous duplicate removed.

// --- Voting System Endpoints ---

// Get all proposals for voting
router.get('/api/proposals', async (req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.json({ proposals: [] });
    const weekParam = req.query.week ? parseInt(String(req.query.week)) : undefined;
    const currentWeek = await ensureCurrentWeek();
    const targetWeek = weekParam || currentWeek;
    // Seed the house bundle into the current week's ballot if nobody proposed a theme.
    await ensureWeekSeeded(postId, currentWeek);
    const proposalsStr = await redis.get(WEEK_PROPOSALS_KEY(postId, targetWeek));
    const proposals = proposalsStr ? JSON.parse(proposalsStr) : [];
    res.json({ proposals, week: targetWeek });
  } catch(e:any){
    console.error('[devvit api/proposals] error', e?.message);
    res.json({ proposals: [] });
  }
});

// --- Frame Voting & Moderation System ---

type VoteDir = -1 | 0 | 1;
function VOTES_KEY(postId: string, frameKey: string){ return `frame:votes:${postId}:${frameKey}`; }
function MOD_QUEUE_KEY(postId: string){ return `frames:modqueue:${postId}`; }
function MODS_SET_KEY(postId: string){ return `mods:allow:${postId}`; }

async function getVotes(postId: string, frameKey: string){
  const raw = await redis.get(VOTES_KEY(postId, frameKey));
  if (!raw) return { by: {} as Record<string, VoteDir>, up: 0, down: 0 };
  try { const v = JSON.parse(raw); return { by: v.by||{}, up: v.up||0, down: v.down||0 }; } catch { return { by: {}, up: 0, down: 0 }; }
}

async function setVotes(postId: string, frameKey: string, v: { by: Record<string, VoteDir>, up: number, down: number }){
  await redis.set(VOTES_KEY(postId, frameKey), JSON.stringify(v));
}

async function isModUser(username: string | null | undefined, postId: string | null | undefined){
  if (!username || !postId) return false;
  try {
    const raw = await redis.get(MODS_SET_KEY(postId));
    const list: string[] = raw ? JSON.parse(raw) : [];
    return list.includes(username);
  } catch { return false; }
}

// Self-check: am I mod?
router.get('/api/mod/me', async (_req, res) => {
  try {
    const u = await reddit.getCurrentUsername();
    const ok = await isModUser(u, context.postId);
    res.json({ isMod: !!ok, username: u || null });
  } catch { res.json({ isMod: false, username: null }); }
});

// Allowlist management (simple): add/remove moderator usernames
router.post('/api/mods', async (req, res) => {
  try {
    const { postId } = context; if (!postId) return res.status(400).json({ error: 'post not found' });
    const me = await reddit.getCurrentUsername();
    // Only existing mods can modify allowlist
    const allowed = await isModUser(me, postId);
    if (!allowed) return res.status(403).json({ error: 'forbidden' });
    const { username } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'username required' });
    const raw = await redis.get(MODS_SET_KEY(postId));
    const list: string[] = raw ? JSON.parse(raw) : [];
    if (!list.includes(username)) list.push(username);
    await redis.set(MODS_SET_KEY(postId), JSON.stringify(list));
    res.json({ ok: true, mods: list });
  } catch(e:any){ res.status(500).json({ error: 'mod add failed', message: e?.message }); }
});

router.delete('/api/mods/:username', async (req, res) => {
  try {
    const { postId } = context; if (!postId) return res.status(400).json({ error: 'post not found' });
    const me = await reddit.getCurrentUsername();
    const allowed = await isModUser(me, postId);
    if (!allowed) return res.status(403).json({ error: 'forbidden' });
    const user = req.params.username;
    const raw = await redis.get(MODS_SET_KEY(postId));
    let list: string[] = raw ? JSON.parse(raw) : [];
    list = list.filter((u)=>u!==user);
    await redis.set(MODS_SET_KEY(postId), JSON.stringify(list));
    res.json({ ok: true, mods: list });
  } catch(e:any){ res.status(500).json({ error: 'mod remove failed', message: e?.message }); }
});

// R2 config endpoints removed — storage now uses Reddit Media API.
// Legacy endpoints return 410 Gone to inform any cached clients.
router.get('/api/r2-config', (_req, res) => {
  res.status(410).json({ error: 'R2 storage removed. Images now use Reddit Media API.' });
});
router.post('/api/r2-config', (_req, res) => {
  res.status(410).json({ error: 'R2 storage removed. Images now use Reddit Media API.' });
});

// Cast a vote on a frame (path param)
router.post('/api/frames/:key/vote', async (req, res) => {
  try {
  const { postId } = context; let frameKey = req.params.key as string;
  if (frameKey && frameKey.includes('%')) { try { frameKey = decodeURIComponent(frameKey); } catch {} }
    if (!postId) return res.status(400).json({ error: 'post not found' });
    const me = await reddit.getCurrentUsername(); if (!me) return res.status(401).json({ error: 'auth required' });
    let dir: VoteDir = req.body?.dir; if (dir !== 1 && dir !== -1 && dir !== 0) return res.status(400).json({ error: 'invalid dir' });
    // Load frame
    const fraw = await redis.get(`frames:data:${postId}:${frameKey}`);
    if (!fraw) return res.status(404).json({ error: 'frame not found' });
    const frameData = JSON.parse(fraw);
    if (frameData.status && frameData.status !== 'active') return res.status(400).json({ error: 'frame not active' });
    // Votes
    const v = await getVotes(postId, frameKey);
    const prev: VoteDir = (v.by[me] ?? 0) as VoteDir;
    let next: VoteDir = dir;
    if (prev === dir) next = 0; // toggle off if same click
    v.by[me] = next;
    // recompute counts without scanning whole map by adjusting deltas
    const prevUp = prev === 1 ? 1 : 0; const prevDown = prev === -1 ? 1 : 0;
    const nextUp = next === 1 ? 1 : 0; const nextDown = next === -1 ? 1 : 0;
    v.up = Math.max(0, (v.up || 0) - prevUp + nextUp);
    v.down = Math.max(0, (v.down || 0) - prevDown + nextDown);
    await setVotes(postId, frameKey, v);
    // Threshold: 5 negative votes => flag to moderation queue
    let flagged = false;
    if ((v.down || 0) >= 5) {
      // move from public list to mod queue if not already flagged
      if (!frameData.status || frameData.status === 'active') {
        frameData.status = 'flagged'; frameData.flaggedAt = Date.now();
        await redis.set(`frames:data:${postId}:${frameKey}`, JSON.stringify(frameData));
        // Remove from public list
        const listRaw = await redis.get(`frames:list:${postId}`);
        let list: string[] = listRaw ? JSON.parse(listRaw) : [];
        list = list.filter(k => k !== frameKey);
        await redis.set(`frames:list:${postId}`, JSON.stringify(list));
        // Push to mod queue
        const mqRaw = await redis.get(MOD_QUEUE_KEY(postId));
        const mq: string[] = mqRaw ? JSON.parse(mqRaw) : [];
        if (!mq.includes(frameKey)) mq.push(frameKey);
        await redis.set(MOD_QUEUE_KEY(postId), JSON.stringify(mq));
        flagged = true;
      }
    }
    res.json({ ok: true, votesUp: v.up, votesDown: v.down, myVote: next, status: flagged ? 'flagged' : 'active' });
  } catch(e:any){
    console.error('[devvit api/frames/vote] error', e?.message);
    res.status(500).json({ error: 'vote failed', message: e?.message });
  }
});


// Cast a vote with JSON body key (fallback)
router.post('/api/frame-vote', async (req,res)=>{
  try {
    const { postId } = context; if (!postId) return res.status(400).json({ error: 'post not found' });
    const me = await reddit.getCurrentUsername(); if (!me) return res.status(401).json({ error: 'auth required' });
    let { key, dir } = req.body || {};
    if (typeof key !== 'string' || !key) return res.status(400).json({ error: 'key required' });
    if (key.includes('%')) { try { key = decodeURIComponent(key); } catch {} }
    if (dir !== 1 && dir !== -1 && dir !== 0) return res.status(400).json({ error: 'invalid dir' });
    const fraw = await redis.get(`frames:data:${postId}:${key}`);
    if (!fraw) return res.status(404).json({ error: 'frame not found' });
    const frameData = JSON.parse(fraw);
    if (frameData.status && frameData.status !== 'active') return res.status(400).json({ error: 'frame not active' });
    const v = await getVotes(postId, key);
    const prev: VoteDir = (v.by[me] ?? 0) as VoteDir;
    let next: VoteDir = dir;
    if (prev === dir) next = 0;
    v.by[me] = next;
    const prevUp = prev === 1 ? 1 : 0; const prevDown = prev === -1 ? 1 : 0;
    const nextUp = next === 1 ? 1 : 0; const nextDown = next === -1 ? 1 : 0;
    v.up = Math.max(0, (v.up || 0) - prevUp + nextUp);
    v.down = Math.max(0, (v.down || 0) - prevDown + nextDown);
    await setVotes(postId, key, v);
    let flagged = false;
    if ((v.down || 0) >= 5) {
      if (!frameData.status || frameData.status === 'active') {
        frameData.status = 'flagged'; frameData.flaggedAt = Date.now();
        await redis.set(`frames:data:${postId}:${key}`, JSON.stringify(frameData));
        const listRaw = await redis.get(`frames:list:${postId}`);
        let list: string[] = listRaw ? JSON.parse(listRaw) : [];
        list = list.filter(k => k !== key);
        await redis.set(`frames:list:${postId}`, JSON.stringify(list));
        const mqRaw = await redis.get(MOD_QUEUE_KEY(postId));
        const mq: string[] = mqRaw ? JSON.parse(mqRaw) : [];
        if (!mq.includes(key)) mq.push(key);
        await redis.set(MOD_QUEUE_KEY(postId), JSON.stringify(mq));
        flagged = true;
      }
    }
    res.json({ ok: true, votesUp: v.up, votesDown: v.down, myVote: next, status: flagged ? 'flagged' : 'active' });
  } catch(e:any){
    console.error('[devvit api/frame-vote] error', e?.message);
    res.status(500).json({ error: 'vote failed', message: e?.message });
  }
});

// List flagged frames for moderation queue
router.get('/api/mod/frames', async (_req, res) => {
  try {
    const { postId } = context; if (!postId) return res.json({ frames: [] });
    const me = await reddit.getCurrentUsername(); const allowed = await isModUser(me, postId);
    if (!allowed) return res.status(403).json({ error: 'forbidden' });
    const mqRaw = await redis.get(MOD_QUEUE_KEY(postId));
    const keys: string[] = mqRaw ? JSON.parse(mqRaw) : [];
    const out: any[] = [];
    for (const key of keys) {
      const fraw = await redis.get(`frames:data:${postId}:${key}`);
      if (!fraw) continue;
      const fd = JSON.parse(fraw);
      const vraw = await redis.get(VOTES_KEY(postId, key));
      let votesUp = 0, votesDown = 0;
      if (vraw) { try { const v = JSON.parse(vraw); votesUp = v.up||0; votesDown = v.down||0; } catch{} }
      const publicSrc = (fd.storage === 'reddit' && fd.mediaUrl)
        ? fd.mediaUrl
        : `/api/frame/${encodeURIComponent(key)}`;
      out.push({ key, url: (fd.storage === 'reddit' || fd.storage === 'r2') ? undefined : fd.dataUrl, src: publicSrc, lastModified: fd.timestamp, artist: fd.artist, votesUp, votesDown, flaggedAt: fd.flaggedAt||null });
    }
    res.json({ frames: out });
  } catch(e:any){ res.status(500).json({ error: 'mod list failed', message: e?.message }); }
});

// Restore a flagged frame to gallery
router.post('/api/mod/frames/:key/restore', async (req, res) => {
  try {
    const { postId } = context; const key = req.params.key; if (!postId) return res.status(400).json({ error: 'post not found' });
    const me = await reddit.getCurrentUsername(); const allowed = await isModUser(me, postId);
    if (!allowed) return res.status(403).json({ error: 'forbidden' });
    const fraw = await redis.get(`frames:data:${postId}:${key}`); if (!fraw) return res.status(404).json({ error: 'frame not found' });
    const fd = JSON.parse(fraw); fd.status = 'active'; delete fd.flaggedAt; await redis.set(`frames:data:${postId}:${key}`, JSON.stringify(fd));
    // Add back to public list (append at end)
    const listRaw = await redis.get(`frames:list:${postId}`); const list: string[] = listRaw ? JSON.parse(listRaw) : [];
    if (!list.includes(key)) { list.push(key); await redis.set(`frames:list:${postId}`, JSON.stringify(list)); }
    // Remove from mod queue
    const mqRaw = await redis.get(MOD_QUEUE_KEY(postId)); let mq: string[] = mqRaw ? JSON.parse(mqRaw) : [];
    mq = mq.filter(k => k !== key); await redis.set(MOD_QUEUE_KEY(postId), JSON.stringify(mq));
    res.json({ ok: true });
  } catch(e:any){ res.status(500).json({ error: 'restore failed', message: e?.message }); }
});

// Permanently delete a flagged frame
router.delete('/api/mod/frames/:key', async (req, res) => {
  try {
    const { postId } = context; const key = req.params.key; if (!postId) return res.status(400).json({ error: 'post not found' });
    const me = await reddit.getCurrentUsername(); const allowed = await isModUser(me, postId);
    if (!allowed) return res.status(403).json({ error: 'forbidden' });
  // Remove data (tombstone friendly)
  await deleteFrameData(postId, key);
    // Ensure removed from public list
    const listRaw = await redis.get(`frames:list:${postId}`); let list: string[] = listRaw ? JSON.parse(listRaw) : [];
    list = list.filter(k => k !== key); await redis.set(`frames:list:${postId}`, JSON.stringify(list));
    // Remove from mod queue
    const mqRaw = await redis.get(MOD_QUEUE_KEY(postId)); let mq: string[] = mqRaw ? JSON.parse(mqRaw) : [];
    mq = mq.filter(k => k !== key); await redis.set(MOD_QUEUE_KEY(postId), JSON.stringify(mq));
    // Clear votes
  // Clear votes (prefer del but fallback to empty)
  const anyRedis: any = redis as any;
  if (typeof anyRedis.del === 'function') { try { await anyRedis.del(VOTES_KEY(postId, key)); } catch { await redis.set(VOTES_KEY(postId, key), ''); } }
  else { await redis.set(VOTES_KEY(postId, key), ''); }
    res.json({ ok: true });
  } catch(e:any){ res.status(500).json({ error: 'delete failed', message: e?.message }); }
});

// Submit a new proposal
router.post('/api/proposals', async (req, res) => {
  try {
    const { postId } = context; const { type, title, data } = req.body || {};
    if (!postId) return res.status(400).json({ error: 'post not found' });
    if (!type || !title) return res.status(400).json({ error: 'type and title required' });
    const username = await reddit.getCurrentUsername();
    const week = await ensureCurrentWeek();
    // Ensure the house floor exists before writing the human proposal, so the two
    // coexist (and to shrink the seed-vs-proposal lost-update window).
    await ensureWeekSeeded(postId, week);
  const ts = await nowMs();
  const proposal = { id: ts.toString(), type, title, data, proposedBy: username || 'anonymous', proposedAt: ts, votes: 0, voters: [], week };
    const proposalsStr = await redis.get(WEEK_PROPOSALS_KEY(postId, week));
    const proposals = proposalsStr ? JSON.parse(proposalsStr) : [];
    proposals.unshift(proposal);
    await redis.set(WEEK_PROPOSALS_KEY(postId, week), JSON.stringify(proposals));
    console.log('[devvit api/proposals] new proposal added', proposal.id, 'week', week);
    res.json({ ok: true, proposal });
  } catch(e:any){
    console.error('[devvit api/proposals] error', e?.message);
    res.status(500).json({ error:'proposal failed', message:e?.message });
  }
});

// Vote on a proposal
router.post('/api/proposals/:id/vote', async (req,res)=>{
  try {
    const { postId } = context; const proposalId = req.params.id; if(!postId) return res.status(400).json({ error:'post not found' });
    const username = await reddit.getCurrentUsername(); if(!username) return res.status(401).json({ error:'authentication required' });
    const week = await ensureCurrentWeek();
    const proposalsStr = await redis.get(WEEK_PROPOSALS_KEY(postId, week));
    const proposals = proposalsStr ? JSON.parse(proposalsStr) : [];
    const proposal = proposals.find((p:any)=>p.id===proposalId); if(!proposal) return res.status(404).json({ error:'proposal not found' });
    // The house pitch is votable like any other: it is a real candidate on the ballot, not
    // just a floor. It still loses vote ties to human pitches (see pickWinner), so backing
    // it means backing it outright rather than handing it a tie.
    const hasVoted = proposal.voters.includes(username);
    if(hasVoted){ proposal.voters = proposal.voters.filter((v:string)=>v!==username); proposal.votes = Math.max(0, proposal.votes-1); }
    else { proposal.voters.push(username); proposal.votes += 1; }
    await redis.set(WEEK_PROPOSALS_KEY(postId, week), JSON.stringify(proposals));
    console.log('[devvit api/proposals/vote]', username, hasVoted? 'removed vote':'voted', 'on', proposalId, 'week', week);
    res.json({ ok:true, voted: !hasVoted, votes: proposal.votes });
  } catch(e:any){
    console.error('[devvit api/proposals/vote] error', e?.message);
    res.status(500).json({ error:'vote failed', message:e?.message });
  }
});

// Get voting stats
router.get('/api/voting-stats', async (req,res)=>{
  try {
    const { postId } = context; if(!postId) return res.json({ totalVotes:0, activeVoters:0, totalProposals:0 });
    const weekParam = req.query.week ? parseInt(String(req.query.week)) : undefined;
    const currentWeek = await ensureCurrentWeek(); const targetWeek = weekParam || currentWeek;
    const proposalsStr = await redis.get(WEEK_PROPOSALS_KEY(postId, targetWeek));
    const proposals = proposalsStr ? JSON.parse(proposalsStr) : [];
    const totalProposals = proposals.length;
    const totalVotes = proposals.reduce((sum:number,p:any)=>sum+p.votes,0);
    const allVoters = new Set<string>(); proposals.forEach((p:any)=>p.voters.forEach((v:string)=>allVoters.add(v)));
    const activeVoters = allVoters.size;
    res.json({ totalVotes, activeVoters, totalProposals, week: targetWeek });
  } catch(e:any){
    console.error('[devvit api/voting-stats] error', e?.message);
    res.json({ totalVotes:0, activeVoters:0, totalProposals:0 });
  }
});

// Get the post type context for client routing
router.get('/api/post-type', async (_req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.json({ type: 'canvas' });
    
    // Check explicit cache if we set it upon creation
    const cachedType = await redis.get(`postType:${postId}`);
    if (cachedType) return res.json({ type: cachedType });

    // Fallback: infer from the post title
    const post = await reddit.getPostById(postId);
    const tit = post.title || '';
    if (tit.includes('🎬') || tit.includes('Week ')) {
      await redis.set(`postType:${postId}`, 'showcase');
      return res.json({ type: 'showcase' });
    }
    if (tit.includes('Join the Animation') || tit.includes('splash') || tit.includes('??')) {
      await redis.set(`postType:${postId}`, 'splash');
      return res.json({ type: 'splash' });
    }
    await redis.set(`postType:${postId}`, 'canvas');
    return res.json({ type: 'canvas' });
  } catch (e) {
    return res.json({ type: 'canvas' });
  }
});

// Minimal alias for quick user resolution (must be outside other handler)
router.get('/api/whoami', async (_req, res) => {
  try {
    const u = await reddit.getCurrentUsername();
    res.json({ username: u || null });
  } catch(e:any){
    res.json({ username: null });
  }
});

// Get current user info (verbose)
router.get('/api/user', async (_req, res) => {
  try {
    const username = await reddit.getCurrentUsername();
    console.log('[devvit api/user] resolved username', username, 'context.postId', context.postId, 'subreddit', context.subredditName);
    res.json({ username: username || null, context: { postId: context.postId, subreddit: context.subredditName } });
  } catch(e: any) {
    console.error('[devvit api/user] error', e?.message);
    res.json({ username: null, error: e?.message });
  }
});
// --- Admin: hard reset to week 1 ---
router.post('/api/admin/reset-week', async (_req, res) => {
  try {
    const { subredditName } = context;
    const now = Date.now();
    // Reset anchor to current Monday
    const anchor = startOfMondayWeekET(now);
    await redis.set(WEEK_ANCHOR_KEY, anchor.toString());
    await redis.set(CURRENT_WEEK_KEY, '1');
    // Clear time offset
    await redis.set(WEEK_TIME_OFFSET_KEY, '0');
    // Purge week 1 metadata so it regenerates with new theme
    await redis.set(SHOWCASE_WEEK_META_KEY(1), '');
    // Clear the showcase dedupe hash so a new post can be created
    if (subredditName) {
      const dedupeHash = `weekly_showcase_posts:${subredditName}`;
      try { await redis.hDel(dedupeHash, ['1']); } catch {}
    }
    // Clear legacy showcase key
    await redis.set(SHOWCASE_WEEKLY_KEY('', 1), '');
    console.log('[admin] reset to week 1, anchor:', anchor);
    res.json({ ok: true, anchor, week: 1 });
  } catch (e: any) {
    console.error('[admin:reset-week] error', e?.message);
    res.status(500).json({ error: e?.message });
  }
});
// --- Admin: fresh reset to week 1 WITH the first house preset pre-seeded ---
// Like reset-week, but also clears proposals/winners/seed-flags and seeds Week 1's
// ballot with the house bundle (theme "Moving Lines" + a fresh palette + brushes),
// so voting/config are populated from the very first load. Call from a post context.
// Optional: ?frames=1 also wipes this post's frames.
router.post('/api/admin/reset-fresh', async (req, res) => {
  try {
    const { subredditName, postId } = context;
    const now = Date.now();
    const anchor = startOfMondayWeekET(now);
    await redis.set(WEEK_ANCHOR_KEY, anchor.toString());
    await redis.set(CURRENT_WEEK_KEY, '1');
    await redis.set(WEEK_TIME_OFFSET_KEY, '0');

    // Clear proposals / winners / seed flags for the first weeks (defensive).
    if (postId) {
      for (let w = 1; w <= 8; w++) {
        await redis.set(WEEK_PROPOSALS_KEY(postId, w), JSON.stringify([]));
        await redis.set(WEEK_WINNERS_KEY(postId, w), '');
        await redis.set(WEEK_SEEDED_KEY(postId, w), '');
      }
    }

    // Purge Week 1 showcase metadata + dedupe so the announcement regenerates.
    await redis.set(SHOWCASE_WEEK_META_KEY(1), '');
    if (subredditName) {
      const dedupeHash = `weekly_showcase_posts:${subredditName}`;
      try { await redis.hDel(dedupeHash, ['1']); } catch {}
    }
    await redis.set(SHOWCASE_WEEKLY_KEY('', 1), '');

    // Optional: wipe this post's frames.
    let framesDeleted = 0;
    if (postId && req.query.frames === '1') {
      const listKey = `frames:list:${postId}`;
      const raw = await redis.get(listKey);
      const keys: string[] = raw ? JSON.parse(raw) : [];
      for (const key of keys) { try { await redis.set(`frames:data:${postId}:${key}`, ''); framesDeleted++; } catch {} }
      await redis.set(listKey, JSON.stringify([]));
    }

    // Seed Week 1 ballot with the first house preset.
    let seeded: any = null;
    if (postId) {
      const bounds = await getAccurateWeekBoundaries(1);
      const proposedAt = bounds.startMs || anchor;
      const house = buildHouseProposals(1, proposedAt);
      await redis.set(WEEK_PROPOSALS_KEY(postId, 1), JSON.stringify(house));
      await redis.set(WEEK_SEEDED_KEY(postId, 1), '1');
      seeded = getHouseBundle(1);
    }

    console.log('[admin:reset-fresh] reset to week 1, anchor:', anchor, 'director:', HOUSE_DIRECTOR, 'seeded:', !!seeded);
    res.json({ ok: true, anchor, week: 1, postId: postId || null, framesDeleted, seeded });
  } catch (e: any) {
    console.error('[admin:reset-fresh] error', e?.message);
    res.status(500).json({ error: e?.message });
  }
});
// --- Admin: clear all frames ---
// Accepts optional query ?postId=t3_xxx to target a specific post, otherwise uses context.postId
router.post('/api/admin/clear-frames', async (req, res) => {
  try {
    const targetPostId = (req.query.postId as string) || context.postId;
    if (!targetPostId) return res.status(400).json({ error: 'no postId — pass ?postId=t3_xxx or call from a post context' });
    // Read current frame keys
    const listKey = `frames:list:${targetPostId}`;
    const raw = await redis.get(listKey);
    const keys: string[] = raw ? JSON.parse(raw) : [];
    // Delete each frame data entry
    let deleted = 0;
    for (const key of keys) {
      try { await redis.set(`frames:data:${targetPostId}:${key}`, ''); deleted++; } catch {}
    }
    // Clear the list
    await redis.set(listKey, JSON.stringify([]));
    console.log('[admin] cleared', deleted, 'frames for post', targetPostId);
    res.json({ ok: true, deleted, postId: targetPostId });
  } catch (e: any) {
    console.error('[admin:clear-frames] error', e?.message);
    res.status(500).json({ error: e?.message });
  }
});
// --- Admin: clear frames for a specific week ---
// Usage: POST /api/admin/clear-week?week=2
router.post('/api/admin/clear-week', async (req, res) => {
  try {
    const targetWeek = parseInt(req.query.week as string, 10);
    if (!targetWeek || isNaN(targetWeek)) return res.status(400).json({ error: 'pass ?week=N' });
    const { postId, subredditName } = context;
    if (!postId) return res.status(400).json({ error: 'no postId' });

    // 1. Remove frames tagged as this week from the frames list
    const listKey = `frames:list:${postId}`;
    const raw = await redis.get(listKey);
    const allKeys: string[] = raw ? JSON.parse(raw) : [];
    const kept: string[] = [];
    let deleted = 0;
    for (const key of allKeys) {
      const frameRaw = await redis.get(`frames:data:${postId}:${key}`);
      if (!frameRaw) { kept.push(key); continue; }
      try {
        const frame = JSON.parse(frameRaw);
        if (frame.week === targetWeek) {
          await redis.set(`frames:data:${postId}:${key}`, '');
          deleted++;
        } else {
          kept.push(key);
        }
      } catch { kept.push(key); }
    }
    await redis.set(listKey, JSON.stringify(kept));

    // 2. Clear showcase dedupe hash for this week
    if (subredditName) {
      const dedupeHash = `weekly_showcase_posts:${subredditName}`;
      try { await redis.hDel(dedupeHash, [String(targetWeek)]); } catch {}
    }
    // Clear legacy showcase key
    await redis.set(SHOWCASE_WEEKLY_KEY('', targetWeek), '');
    // Clear week metadata
    await redis.set(SHOWCASE_WEEK_META_KEY(targetWeek), '');

    // 3. Reset current week back if we deleted the current week
    const currentWeek = await ensureCurrentWeek();
    if (targetWeek >= currentWeek) {
      await redis.set(CURRENT_WEEK_KEY, String(targetWeek - 1 > 0 ? targetWeek - 1 : 1));
    }

    console.log('[admin] cleared week', targetWeek, ':', deleted, 'frames deleted,', kept.length, 'kept');
    res.json({ ok: true, week: targetWeek, framesDeleted: deleted, framesKept: kept.length });
  } catch (e: any) {
    console.error('[admin:clear-week] error', e?.message);
    res.status(500).json({ error: e?.message });
  }
});
// --- Admin: find posts with frames ---
router.get('/api/admin/find-frames', async (_req, res) => {
  try {
    const { postId } = context;
    // Try the current post and any recent known post IDs
    const candidates: string[] = [];
    if (postId) candidates.push(postId);
    // Check each candidate
    const results: { postId: string; frameCount: number; keys: string[] }[] = [];
    for (const pid of candidates) {
      const raw = await redis.get(`frames:list:${pid}`);
      if (raw) {
        try {
          const keys = JSON.parse(raw);
          if (Array.isArray(keys) && keys.length > 0) {
            results.push({ postId: pid, frameCount: keys.length, keys });
          }
        } catch {}
      }
    }
    res.json({ ok: true, currentPostId: postId, posts: results });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});
// --- Week rollover endpoint ---
router.post('/api/rollover-week', async (_req,res)=>{
  try {
    const { postId } = context; if(!postId) return res.status(400).json({ error:'post not found' });
    const currentWeek = await ensureCurrentWeek();
    // Use accurate boundaries from stored anchor and simulated current time
    const bounds = await getAccurateWeekBoundaries(currentWeek);
    const now = await nowMs();
    if(now <= bounds.endMs) return res.json({ rolled:false, reason:'week not ended', currentWeek });
    const proposalsStr = await redis.get(WEEK_PROPOSALS_KEY(postId, currentWeek));
    const proposals = proposalsStr ? JSON.parse(proposalsStr) : [];
    const paletteWinner = pickWinner(proposals.filter((p:any)=>p.type==='palette')) || null;
    const themeWinner = pickWinner(proposals.filter((p:any)=>p.type==='theme')) || null;
    const brushWinner = pickWinner(proposals.filter((p:any)=>p.type==='brushKit')) || null;
    await redis.set(WEEK_WINNERS_KEY(postId, currentWeek), JSON.stringify({ palette: paletteWinner, theme: themeWinner, brushKit: brushWinner }));
    const newWeek = currentWeek + 1;
    await redis.set(CURRENT_WEEK_KEY, newWeek.toString());
    await redis.set(WEEK_PROPOSALS_KEY(postId, newWeek), JSON.stringify([]));
    res.json({ rolled:true, newWeek });
  } catch(e:any){
    console.error('[devvit api/rollover-week] error', e?.message);
    res.status(500).json({ error:'rollover failed', message:e?.message });
  }
});
// Week info endpoint
router.get('/api/week', async (_req,res)=>{
  try {
    const { postId } = context;
    const currentWeek = await ensureCurrentWeek();
    if (postId) await ensureWeekSeeded(postId, currentWeek);
    const bounds = await getAccurateWeekBoundaries(currentWeek);
  const now = await nowMs();
    const secondsUntilEnd = Math.max(0, Math.floor((bounds.endMs - now)/1000));
    let winners: any = null;
    let autoMaterialized = false;
    if (postId) {
      // Route through the shared resolver so /api/week gets the same never-empty house
      // net + synonym-type normalization as every other read site (no all-null persist).
      const existed = await redis.get(WEEK_WINNERS_KEY(postId, currentWeek - 1));
      winners = await materializePreviousWeekWinners(postId, currentWeek);
      autoMaterialized = !existed && !!winners;
    }
    res.json({ week: currentWeek, startMs: bounds.startMs, endMs: bounds.endMs, secondsUntilEnd, previousWinners: winners, previousWinnersAutoMaterialized: autoMaterialized });
  } catch(e:any){
    console.error('[devvit api/week] error', e?.message);
    res.status(500).json({ error:'week info failed', message:e?.message });
  }
});

// Week status debug endpoint
router.get('/api/week-status', async (_req,res)=>{
  try {
  const [now, offsetMs] = [await nowMs(), await getTimeOffsetMs()];
    const anchorStr = await redis.get(WEEK_ANCHOR_KEY);
    const currentWeek = await ensureCurrentWeek();
    let anchor = anchorStr ? parseInt(anchorStr,10) : null;
    const bounds = anchor ? getWeekBoundariesFromAnchor(anchor, currentWeek) : { startMs:0, endMs:0 };
    res.json({
      now,
      offsetMs,
      simulated: offsetMs !== 0,
      anchorStartMs: anchor,
      currentWeek,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      secondsUntilEnd: bounds.endMs ? Math.max(0, Math.floor((bounds.endMs - now)/1000)) : null
    });
  } catch(e:any){
    res.status(500).json({ error:'week-status failed', message:e?.message });
  }
});
// Weekly chat endpoints (persist across the whole week in Devvit Redis)
interface ChatMessage { id:string; user:string; body:string; ts:number; week:number; }
const WEEK_CHAT_KEY = (postId:string,w:number)=>`chat:${postId}:week:${w}`; // JSON array key
const MAX_CHAT_MESSAGES = 500;

router.get('/api/chat', async (req,res)=>{
  try {
    const postId = context.postId;
    if(!postId){
      console.warn('[chat:get] missing postId');
      return res.json({ messages: [], week: 0, postId: null });
    }
    console.log('[chat:get] postId', postId, 'query.week', req.query.week);
    const weekParam = req.query.week ? parseInt(String(req.query.week)) : undefined;
    const currentWeek = await ensureCurrentWeek();
    const targetWeek = weekParam || currentWeek;
  const raw = await redis.get(WEEK_CHAT_KEY(postId, targetWeek));
  let messages: ChatMessage[] = [];
  if(raw){ try { messages = JSON.parse(raw); } catch { messages = []; } }
  console.log('[chat:get] returning', messages.length, 'messages week', targetWeek);
  res.json({ messages, week: targetWeek, postId });
  } catch(e:any){
    console.error('[devvit api/chat:get] error', e?.message);
    res.json({ messages: [] });
  }
});

// Simple in-memory subscriber map for SSE (per process). Devvit environment typically single process.
type SSEClient = { res: express.Response; week:number; postId:string };
const sseClients: Set<SSEClient> = new Set();

function broadcastChatMessage(postId:string, week:number, msg:ChatMessage){
  for(const c of sseClients){
    if(c.postId===postId && c.week===week){
      try { c.res.write(`event: message\n` + `data: ${JSON.stringify(msg)}\n\n`); } catch {}
    }
  }
}

router.get('/api/chat/stream', async (req,res)=>{
  try {
    const postId = context.postId;
    if(!postId){
      console.warn('[chat/stream] missing postId');
      return res.status(400).end();
    }
  console.log('[chat:stream] open postId', postId, 'weekQ', req.query.week);
    const weekParam = req.query.week ? parseInt(String(req.query.week)) : undefined;
    const currentWeek = await ensureCurrentWeek();
    const targetWeek = weekParam || currentWeek;
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.flushHeaders?.();
    // Send current history once
  const raw = await redis.get(WEEK_CHAT_KEY(postId, targetWeek));
  let messages: ChatMessage[] = [];
  if(raw){ try { messages = JSON.parse(raw); } catch { messages = []; } }
  res.write(`event: init\n` + `data: ${JSON.stringify(messages)}\n\n`);
    const client:SSEClient = { res, week: targetWeek, postId };
    sseClients.add(client);
    req.on('close', ()=>{ sseClients.delete(client); });
  } catch(e:any){
    console.error('[devvit api/chat/stream] error', e?.message);
    res.status(500).end();
  }
});

router.post('/api/chat', async (req,res)=>{
  try {
    const postId = context.postId;
    if(!postId){
      return res.status(400).json({ error:'post not found' });
    }
    let username = await reddit.getCurrentUsername();
    if(!username){
      username = 'anon';
    }
  console.log('[chat:post] incoming body', typeof req.body?.body, 'len', (req.body?.body||'').length, 'user', username, 'postId', postId);
    const { body } = req.body || {};
    if(typeof body !== 'string' || !body.trim()) return res.status(400).json({ error:'empty' });
    if(body.length > 280) return res.status(400).json({ error:'too long' });
    const week = await ensureCurrentWeek();
    const ts = await nowMs();
    const key = WEEK_CHAT_KEY(postId, week);
    const msg: ChatMessage = { id: ts.toString(36)+Math.random().toString(36).slice(2,6), user: username, body: body.trim(), ts, week };
  const raw = await redis.get(key);
  let arr: ChatMessage[] = [];
  if(raw){ try { arr = JSON.parse(raw); } catch { arr = []; } }
  arr.push(msg);
  if(arr.length > MAX_CHAT_MESSAGES) arr = arr.slice(-MAX_CHAT_MESSAGES);
  await redis.set(key, JSON.stringify(arr));
    console.log('[chat:post] stored', msg.id, 'user', username, 'postId', postId, 'week', week, 'size', arr.length);
    broadcastChatMessage(postId, week, msg);
    res.json({ ok:true, message: msg });
  } catch(e:any){
    console.error('[devvit api/chat:post] error', e?.message);
    res.status(500).json({ error:'chat failed', message:e?.message });
  }
});

// Debug endpoint for chat storage
router.get('/api/chat/debug', async (req,res)=>{
  try {
    const postId = context.postId;
    const weekParam = req.query.week ? parseInt(String(req.query.week)) : undefined;
    const currentWeek = await ensureCurrentWeek();
    const targetWeek = weekParam || currentWeek;
    if(!postId){ return res.json({ ok:false, reason:'no postId', currentWeek, targetWeek }); }
    const key = WEEK_CHAT_KEY(postId, targetWeek);
    let raw = await redis.get(key);
    let arr: ChatMessage[] = [];
    if(raw){ try { arr = JSON.parse(raw); } catch { raw = raw?.slice(0,200)+'/*parse error*/'; }
    }
    // Optional simulate write
    if(req.query.simulate === '1'){
  const ts = await nowMs();
  const msg: ChatMessage = { id: 'dbg-'+ts.toString(36), user: 'debug', body: 'debug message', ts, week: targetWeek };
      arr.push(msg);
      if(arr.length > MAX_CHAT_MESSAGES) arr = arr.slice(-MAX_CHAT_MESSAGES);
      await redis.set(key, JSON.stringify(arr));
      raw = await redis.get(key);
    }
    res.json({ ok:true, postId, currentWeek, targetWeek, key, rawLength: raw? raw.length: 0, count: arr.length, sampleLast: arr.slice(-3) });
  } catch(e:any){
    console.error('[chat:debug] error', e?.message);
    res.status(500).json({ ok:false, error: e?.message });
  }
});

// Simple health endpoint for chat diagnostics
router.get('/api/chat/health', async (_req,res)=>{
  try {
    res.json({ ok:true, postId: context.postId || null });
  } catch(e:any){ res.status(500).json({ ok:false, error:e?.message }); }
});

// R2/S3 health check removed — storage now uses Reddit Media API.
router.get('/api/r2-health', (_req, res) => {
  res.status(410).json({ ok: false, error: 'R2 storage removed. Images now use Reddit Media API.' });
});
// Use router middleware
app.use(router);

// Debug endpoint to inspect devvit context quickly
router.get('/api/debug/context', (_req, res) => {
  try {
    res.json({
      context: {
        postId: context.postId,
  subreddit: context.subredditName,
      }
    });
  } catch(e:any){
    res.status(500).json({ error: 'debug failed', message: e?.message });
  }
});

// Get port from environment variable with fallback
const port = getServerPort();

// Startup route listing (basic) and log
console.log('[devvit server] starting. Routes registered (simplified, Redis-only):');
['/api/init','/api/increment','/api/decrement','/api/list-frames','/api/frame/:key','/api/upload-frame'].forEach(r=>console.log('  -', r));

// Removed legacy compatibility /r2/* and /api/r2/* routes (all Redis-only now).

const server = createServer(app);
server.on('error', (err) => console.error(`server error; ${err.stack}`));
server.listen(port);

// Week simulation endpoint (POST). Body: { action: 'add-days'|'add-weeks'|'set-offset'|'reset', value?: number }
// Helper to lazily compute previous week winners if missing.
// Guarantees a non-empty result per category by filling any gaps with the
// deterministic house preset for that week (never-empty safety net).
async function materializePreviousWeekWinners(postId: string, currentWeek: number) {
  if (currentWeek <= 1) return null;
  const targetWeek = currentWeek - 1;
  let winners: any = null;
  const existing = await redis.get(WEEK_WINNERS_KEY(postId, targetWeek));
  if (existing) {
    try { winners = JSON.parse(existing); } catch { winners = null; }
  }
  if (!winners) {
    const proposalsStr = await redis.get(WEEK_PROPOSALS_KEY(postId, targetWeek));
    const proposals = proposalsStr ? JSON.parse(proposalsStr) : [];
    const norm = proposals.map((p:any)=> ({ ...p, _normType: normalizeProposalType(p.type) }));
    const paletteWinner = pickWinner(norm.filter((p:any)=>p._normType==='palette')) || null;
    const themeWinner = pickWinner(norm.filter((p:any)=>p._normType==='theme')) || null;
    const brushWinner = pickWinner(norm.filter((p:any)=>p._normType==='brushKit')) || null;
    winners = { palette: paletteWinner, theme: themeWinner, brushKit: brushWinner };
    // Carry-over fallback if all null: reuse the most recent week that had winners.
    if (!winners.palette && !winners.theme && !winners.brushKit) {
      for (let w = targetWeek - 1; w >= 1; w--) {
        const prev = await redis.get(WEEK_WINNERS_KEY(postId, w));
        if (prev) { try { const parsed = JSON.parse(prev); if (parsed && (parsed.palette||parsed.theme||parsed.brushKit)) { winners = parsed; break; } } catch {}
        }
      }
    }
  }
  // Never-empty safety net: fill any missing category with the house preset.
  const house = houseWinnersForWeek(targetWeek);
  winners = {
    palette: winners?.palette || house.palette,
    theme: winners?.theme || house.theme,
    brushKit: winners?.brushKit || house.brushKit,
  };
  await redis.set(WEEK_WINNERS_KEY(postId, targetWeek), JSON.stringify(winners));
  // ensure current week proposals array exists
  const curKey = WEEK_PROPOSALS_KEY(postId, currentWeek);
  if (!(await redis.get(curKey))) await redis.set(curKey, JSON.stringify([]));
  return winners;
}

// Week config endpoint to be consumed by drawing page (auto winners)
app.get('/api/week-config', async (_req, res) => {
  try {
    const { postId } = context; const currentWeek = await ensureCurrentWeek();
    if (postId) await ensureWeekSeeded(postId, currentWeek);
    const bounds = await getAccurateWeekBoundaries(currentWeek);
    let winners: any = null;
    if (postId) {
      winners = await materializePreviousWeekWinners(postId, currentWeek);
      if (!winners && currentWeek > 2) {
        for (let w = currentWeek - 2; w >= 1; w--) {
          const prev = await redis.get(WEEK_WINNERS_KEY(postId, w));
          if (prev) { try { const parsed = JSON.parse(prev); if (parsed && (parsed.palette||parsed.theme||parsed.brushKit)) { winners = parsed; break; } } catch {}
          }
        }
      }
    }
    const offsetMs = await getTimeOffsetMs();
    res.json({ week: currentWeek, startMs: bounds.startMs, endMs: bounds.endMs, previousWinners: winners, simulated: offsetMs !== 0, offsetMs });
  } catch(e:any){
    console.error('[devvit api/week-config] error', e?.message);
    res.status(500).json({ error:'week-config failed', message:e?.message });
  }
});

// Debug latest frames with stored vs computed week
app.get('/api/debug/frames-latest', async (req, res) => {
  try {
    const { postId } = context; if(!postId) return res.json({ frames: [] });
    const limit = req.query.limit ? parseInt(String(req.query.limit),10) : 25;
    const listRaw = await redis.get(`frames:list:${postId}`); const list:string[] = listRaw ? JSON.parse(listRaw):[];
    const slice = list.slice(-limit);
    const anchorStr = await redis.get(WEEK_ANCHOR_KEY); const anchor = anchorStr ? parseInt(anchorStr,10):0;
    const frames:any[] = [];
    for(const key of slice){
      const raw = await redis.get(`frames:data:${postId}:${key}`); if(!raw) continue;
      try {
        const fd = JSON.parse(raw);
        frames.push({ key, ts: fd.timestamp, storedWeek: fd.week ?? null, computedWeek: anchor? computeWeekNumber(anchor, fd.timestamp): null, artist: fd.artist });
      } catch {}
    }
    res.json({ frames, anchor });
  } catch(e:any){
    console.error('[devvit api/debug/frames-latest] error', e?.message);
    res.status(500).json({ error:'frames-latest failed', message:e?.message });
  }
});

// Full integrity scan (expensive) – iterate all stored frame keys and report issues.
app.get('/api/debug/frames-integrity', async (_req, res) => {
  try {
    const { postId } = context; if(!postId) return res.json({ ok:false, reason:'no postId'});
    const keys = await loadFrameKeys(postId);
    const bad: string[] = []; const flagged: string[] = []; const ok: number[] = [];
    for (const k of keys) {
      const fd = await loadFrame(postId, k);
      if (!fd) { bad.push(k); continue; }
      if (fd.status && fd.status !== 'active') { flagged.push(k); continue; }
      ok.push(fd.timestamp);
    }
    res.json({ ok:true, total: keys.length, good: ok.length, bad: bad.length, flagged: flagged.length, badKeys: bad.slice(0,50) });
  } catch(e:any){ res.status(500).json({ ok:false, error:e?.message }); }
});

// Debug proposals endpoint
app.get('/api/debug/proposals', async (req, res) => {
  try {
    const { postId } = context; if(!postId) return res.json({ ok:false, reason:'no postId'});
    const weekParam = req.query.week ? parseInt(String(req.query.week),10) : await ensureCurrentWeek();
    const raw = await redis.get(WEEK_PROPOSALS_KEY(postId, weekParam));
    const proposals = raw ? JSON.parse(raw) : [];
    const mapped = proposals.map((p:any)=> ({ id: p.id, type: p.type, norm: normalizeProposalType(p.type), votes: p.votes, proposedAt: p.proposedAt }));
    res.json({ ok:true, week: weekParam, count: proposals.length, mapped });
  } catch(e:any){ res.status(500).json({ ok:false, error:e?.message }); }
});

// Per-week bundle (theme/palette/brushes/director) for ANY week — used by the gallery
// so each past week shows the colors it was actually drawn with (not the current week's).
app.get('/api/week-bundle', async (req, res) => {
  try {
    const { postId } = context;
    const week = req.query.week ? parseInt(String(req.query.week), 10) : await ensureCurrentWeek();
    if (!week || week < 1) return res.json({ week, theme: '', palette: [], brushes: [], director: '' });
    // 1. Authoritative stored meta (written when that week's showcase post was created).
    const metaRaw = await redis.get(SHOWCASE_WEEK_META_KEY(week));
    if (metaRaw) {
      try {
        const m = JSON.parse(metaRaw);
        if (m && (m.theme || (Array.isArray(m.paletteColors) && m.paletteColors.length))) {
          return res.json({
            week,
            theme: m.theme || '',
            palette: Array.isArray(m.paletteColors) ? m.paletteColors.slice(0, 6) : [],
            brushes: Array.isArray(m.brushNames) ? m.brushNames.slice(0, 4) : [],
            director: m.directorName || '',
          });
        }
      } catch {}
    }
    // 2. Compute (never-empty): week 1 = house bundle; later weeks = previous week's winners.
    if (week === 1) {
      const hb = getHouseBundle(1);
      return res.json({ week, theme: hb.theme.name, palette: hb.palette.colors, brushes: hb.brushKit.names, director: hb.director });
    }
    let winners: any = postId ? await materializePreviousWeekWinners(postId, week) : null;
    if (!winners) winners = houseWinnersForWeek(week - 1);
    res.json({
      week,
      theme: winners.theme?.data?.value || winners.theme?.title || '',
      palette: Array.isArray(winners.palette?.data?.colors) ? winners.palette.data.colors.slice(0, 6) : [],
      brushes: Array.isArray(winners.brushKit?.data?.names) ? winners.brushKit.data.names.slice(0, 4) : [],
      director: winners.theme?.proposedBy || '',
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

// Unified draw configuration: winners + palette + brushes + theme + current week
app.get('/api/draw-config', async (req, res) => {
  try {
    const { postId } = context; if(!postId) return res.json({ ok:false, reason:'no postId'});
    const rawFlag = req.query.raw === '1';
    const currentWeek = await ensureCurrentWeek();
    await ensureWeekSeeded(postId, currentWeek);
    // Week 1 draw config comes from the house bundle (no previous voting exists):
    // keeps the signature "Moving Lines" theme with a generated palette + brushes.
    if (currentWeek === 1) {
      const hb = getHouseBundle(1);
      const seedBrushes = hb.brushKit.ids.map((id, i) => ({ id, name: hb.brushKit.names[i] }));
      const response: any = {
        ok: true, currentWeek, previousWeek: 0,
        paletteColors: hb.palette.colors,
        brushes: seedBrushes,
        theme: hb.theme.name,
        director: hb.director,
        toolsVersion: 'house-w1',
        tools: {
          palette: { colors: hb.palette.colors, id: 'house-w1-pal' },
          brushKit: { brushes: seedBrushes, id: 'house-w1-brk' },
          theme: { value: hb.theme.name, id: 'house-w1-thm' },
        },
      };
      return res.json(response);
    }
    let winners = await materializePreviousWeekWinners(postId, currentWeek);
    if (!winners && currentWeek > 2) {
      for (let w = currentWeek - 2; w >= 1; w--) {
        const prev = await redis.get(WEEK_WINNERS_KEY(postId, w));
        if (prev) { try { const parsed = JSON.parse(prev); if (parsed && (parsed.palette||parsed.theme||parsed.brushKit)) { winners = parsed; break; } } catch {}
        }
      }
    }
    async function fallbackCategory(cat: 'palette'|'theme'|'brushKit'){
      if(!postId) return null;
      const wAny: any = winners;
      if (wAny && wAny[cat]) return wAny[cat];
      for (let w = currentWeek - 2; w >= 1; w--) {
        const prevKey = WEEK_WINNERS_KEY(postId as string, w);
        const prev = await redis.get(prevKey);
        if (prev) {
          try { const parsed = JSON.parse(prev); if (parsed && parsed[cat]) return parsed[cat]; } catch{}
        }
      }
      return null;
    }
    const paletteEntry = await fallbackCategory('palette');
    const brushEntry = await fallbackCategory('brushKit');
    const themeEntry = await fallbackCategory('theme');
    if (!winners) winners = { palette: paletteEntry, brushKit: brushEntry, theme: themeEntry } as any;
    // Robust palette extraction
    function extractPalette(pe:any): string[]{
      if (!pe || !pe.data) return [];
      const d = pe.data;
      if (Array.isArray(d.colors)) return d.colors;
      if (Array.isArray(d.palette)) return d.palette;
      if (Array.isArray(d.hex)) return d.hex;
      if (Array.isArray(d.list)) return d.list;
      if (typeof d === 'object') {
        // attempt flatten values that look like hex strings
        const vals = Object.values(d);
        if (vals.every(v => typeof v === 'string' && /^#?[0-9A-Fa-f]{3,8}$/.test(v as string))) return vals as string[];
      }
      return [];
    }
    const paletteColors = extractPalette(paletteEntry);
    // Robust brush extraction: attempt structured forms and pair ids+names
    function extractBrushes(be:any): any[] {
      if (!be || !be.data) return [];
      const d = be.data;
      const simpleArrayReturn = (arr:any[]): any[] => {
        // Accept arrays of strings or objects already in desired form
        if (!Array.isArray(arr)) return [];
        return arr.map((b:any) => {
          if (b && typeof b === 'object') {
            const id = b.id ?? b.key ?? b.name;
            const name = b.name ?? b.title ?? b.id;
            return { id: String(id).toLowerCase(), name: String(name) };
          }
          return { id: String(b).toLowerCase(), name: String(b) };
        });
      };
      // Direct list forms
      if (Array.isArray(d.brushes)) return simpleArrayReturn(d.brushes);
      if (Array.isArray(d.items)) return simpleArrayReturn(d.items);
      if (Array.isArray(d.kit)) return simpleArrayReturn(d.kit);
      if (Array.isArray(d.list)) return simpleArrayReturn(d.list);
      // ids + names pairing
      if (Array.isArray(d.ids) && Array.isArray(d.names)) {
        const out:any[] = [];
        const len = Math.min(d.ids.length, d.names.length);
        for (let i=0;i<len;i++) {
          const rawId = d.ids[i];
          const rawName = d.names[i];
          out.push({ id: String(rawId).toLowerCase(), name: String(rawName) });
        }
        return out;
      }
      if (Array.isArray(d.ids)) {
        return d.ids.map((id:any) => ({ id: String(id).toLowerCase(), name: String(id) }));
      }
      return [];
    }
    // After extraction, canonicalize ids & names using known presets if possible
    const canonicalBrushName: Record<string,string> = {
      ink: 'Ink',
      acrilico: 'Acrílico',
      marker: 'Marker',
      charcoal: 'Charcoal',
      acuarela: 'Acuarela',
      lapicero: 'Lapicero'
    };
    const brushes = extractBrushes(brushEntry);
    for (const b of brushes) {
      if (!b || typeof b !== 'object') continue;
      if (b.id) {
        const low = String(b.id).toLowerCase();
        b.id = low;
        b.name = canonicalBrushName[low] || b.name || low;
      }
    }
    const theme = themeEntry?.data?.value || themeEntry?.title || null;
    const toolsVersion = [paletteEntry?.id||'', brushEntry?.id||'', themeEntry?.id||''].join('|');
    const tools = {
      palette: { colors: paletteColors, id: paletteEntry?.id || null },
      brushKit: { brushes, id: brushEntry?.id || null },
      theme: { value: theme, id: themeEntry?.id || null }
    };
    const director = themeEntry?.proposedBy || null;
    const response:any = { ok:true, currentWeek, previousWeek: currentWeek-1, paletteColors, brushes, theme, director, toolsVersion, tools, winners: winners||null };
    if (!rawFlag) delete response.winners; // hide heavy structure unless requested
    res.json(response);
  } catch(e:any){ res.status(500).json({ ok:false, error:e?.message }); }
});

// Force rebuild / recompute winners for a given week range (admin/debug)
app.post('/api/debug/rebuild-winners', async (req, res) => {
  try {
    const { postId } = context; if(!postId) return res.status(400).json({ ok:false, reason:'no postId'});
    const { fromWeek = 1, toWeek } = req.body || {};
    const currentWeek = await ensureCurrentWeek();
    const end = Math.min(toWeek || currentWeek - 1, currentWeek - 1);
    const rebuilt: Record<number, any> = {};
    for (let w = fromWeek; w <= end; w++) {
      const proposalsStr = await redis.get(WEEK_PROPOSALS_KEY(postId, w));
      const proposals = proposalsStr ? JSON.parse(proposalsStr) : [];
      const norm = proposals.map((p:any)=> ({ ...p, _normType: normalizeProposalType(p.type) }));
      const paletteWinner = pickWinner(norm.filter((p:any)=>p._normType==='palette')) || null;
      const themeWinner = pickWinner(norm.filter((p:any)=>p._normType==='theme')) || null;
      const brushWinner = pickWinner(norm.filter((p:any)=>p._normType==='brushKit')) || null;
      const winners = { palette: paletteWinner, theme: themeWinner, brushKit: brushWinner };
      await redis.set(WEEK_WINNERS_KEY(postId, w), JSON.stringify(winners));
      rebuilt[w] = winners;
    }
    res.json({ ok:true, rebuilt });
  } catch(e:any){ res.status(500).json({ ok:false, error:e?.message }); }
});

// Winners history (lightweight) for diagnostics
app.get('/api/debug/winners-history', async (req, res) => {
  try {
    const { postId } = context; if(!postId) return res.json({ ok:false, reason:'no postId'});
    const upto = req.query.upto ? parseInt(String(req.query.upto),10) : await ensureCurrentWeek();
    const out: Record<number, any> = {};
    for (let w = 1; w < upto; w++) {
      const raw = await redis.get(WEEK_WINNERS_KEY(postId, w));
      if (raw) { try { out[w] = JSON.parse(raw); } catch{} }
    }
    res.json({ ok:true, history: out });
  } catch(e:any){ res.status(500).json({ ok:false, error:e?.message }); }
});

// Raw winners for single week (includes per-category fallback result simulation)
app.get('/api/debug/week-winners', async (req, res) => {
  try {
    const { postId } = context; if(!postId) return res.json({ ok:false, reason:'no postId'});
    const targetWeek = req.query.week ? parseInt(String(req.query.week),10) : (await ensureCurrentWeek()) - 1;
    if (targetWeek < 1) return res.json({ ok:true, week: targetWeek, winners: null });
    const raw = await redis.get(WEEK_WINNERS_KEY(postId, targetWeek));
    let winners = raw ? (()=>{ try { return JSON.parse(raw); } catch { return null; } })() : null;
    res.json({ ok:true, week: targetWeek, winners });
  } catch(e:any){ res.status(500).json({ ok:false, error:e?.message }); }
});

app.post('/api/week-simulate', async (req, res) => {
  try {
    const { action, value } = req.body || {};
    let offset = await getTimeOffsetMs();
    if (action === 'add-days') {
      if (typeof value !== 'number') return res.status(400).json({ error: 'value (days) required' });
      offset += value * 24 * 60 * 60 * 1000;
    } else if (action === 'add-weeks') {
      if (typeof value !== 'number') return res.status(400).json({ error: 'value (weeks) required' });
      offset += value * WEEK_MS;
    } else if (action === 'set-offset') {
      if (typeof value !== 'number') return res.status(400).json({ error: 'value (ms) required' });
      offset = value;
    } else if (action === 'reset') {
      offset = 0;
    } else {
      return res.status(400).json({ error: 'invalid action' });
    }
    await redis.set(WEEK_TIME_OFFSET_KEY, offset.toString());
    const week = await ensureCurrentWeek();
    const anchorStr = await redis.get(WEEK_ANCHOR_KEY);
    const anchor = anchorStr ? parseInt(anchorStr,10) : 0;
    const bounds = getWeekBoundariesFromAnchor(anchor, week);
    res.json({ ok: true, action, offsetMs: offset, week, bounds });
  } catch(e:any){
    console.error('[devvit api/week-simulate] error', e?.message);
    res.status(500).json({ error: 'week-simulate failed', message: e?.message });
  }
});

// ====================================================================
// WEEKLY ANIMATION GIF GENERATOR
// ====================================================================
// Scheduled job: compile all frames from a completed week into an animated GIF
// and publish it as a Reddit post.

import UPNG from 'upng-js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

const ANIMATION_POST_KEY = (week: number) => `animation:post:w${week}`;

// Decode a base64 PNG data URL to raw RGBA pixel array
function decodePngDataUrl(dataUrl: string): { width: number; height: number; data: Uint8Array } | null {
  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const img = UPNG.decode(buffer);
    const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]!);
    return { width: img.width, height: img.height, data: rgba };
  } catch (e: any) {
    console.error('[animation] PNG decode failed:', e?.message);
    return null;
  }
}

// Fetch PNG data for a stored frame — supports both redis-stored dataUrl and Reddit CDN mediaUrl
async function fetchFramePixels(postId: string, frameKey: string): Promise<{ width: number; height: number; data: Uint8Array } | null> {
  const frame = await loadFrame(postId, frameKey);
  if (!frame) return null;

  // If we have a dataUrl stored in Redis, decode directly
  if (frame.dataUrl && frame.dataUrl.startsWith('data:image/png;base64,')) {
    return decodePngDataUrl(frame.dataUrl);
  }

  // If stored on Reddit CDN, fetch the image
  if (frame.mediaUrl) {
    try {
      const resp = await fetch(frame.mediaUrl);
      if (!resp.ok) return null;
      const arrayBuf = await resp.arrayBuffer();
      const img = UPNG.decode(new Uint8Array(arrayBuf) as any);
      const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]!);
      return { width: img.width, height: img.height, data: rgba };
    } catch (e: any) {
      console.error('[animation] CDN fetch failed for', frameKey, e?.message);
      return null;
    }
  }

  return null;
}

// Schedule the previous week's animation GIF. Called from the weekly cron so it runs
// independently of whether the weekly showcase post already exists (ensureWeeklyShowcasePost
// returns early on its dedup path). Frames live on the main canvas post (kinora:main_post_id).
// Guarded by a per-week key so it is never scheduled twice.
async function schedulePreviousWeekAnimation(currentWeek: number): Promise<void> {
  if (currentWeek <= 1) return;
  const targetWeek = currentWeek - 1;
  const animKey = `animation:scheduled:w${targetWeek}`;
  if (await redis.get(animKey)) return; // already scheduled or completed
  const canvasPostId = (await redis.get('kinora:main_post_id')) || context.postId || '';
  if (!canvasPostId) { console.warn('[animation] no canvas postId — cannot schedule week', targetWeek); return; }
  try {
    await scheduler.runJob({
      name: 'weekly-animation',
      data: { postId: canvasPostId, week: targetWeek },
      runAt: new Date(Date.now() + 2 * 60 * 1000), // ~2 min after week start
    });
    await redis.set(animKey, 'scheduled');
    console.log('[animation] scheduled weekly-animation for week', targetWeek, 'postId', canvasPostId);
  } catch (e: any) {
    console.error('[animation] failed to schedule week', targetWeek, ':', e?.message);
  }
}

// --- Weekly Showcase Post cron (cron "5 0 * * 1" => Monday 00:05 UTC = Sunday 7:05 PM Colombia) ---
// The week COUNTER rolls over at Monday 00:00 UTC (= Sunday 7:00 PM Colombia), so this cron fires
// 5 minutes AFTER the reset, when ensureCurrentWeek() already reports the new week. Ballot seeding is
// done lazily on request (ensureWeekSeeded), tied to the same Monday 00:00 UTC boundary.
app.post('/internal/cron/weekly-showcase-post', async (_req, res) => {
  try {
    console.log('[cron:weekly-showcase] triggered');
    const currentWeek = await ensureCurrentWeek();
    const postId = await ensureWeeklyShowcasePost();
    // Schedule the previous week's GIF regardless of whether the showcase post was
    // newly created or already existed (the bug that skipped the GIF last week).
    await schedulePreviousWeekAnimation(currentWeek);
    if (postId) {
      console.log('[cron:weekly-showcase] week', currentWeek, 'post:', postId);
      res.json({ ok: true, week: currentWeek, postId });
    } else {
      console.log('[cron:weekly-showcase] week', currentWeek, 'skipped or failed');
      res.json({ ok: true, week: currentWeek, skipped: true });
    }
  } catch (e: any) {
    console.error('[cron:weekly-showcase] error:', e?.message);
    res.json({ ok: false, error: e?.message });
  }
});

// Internal scheduler endpoint
app.post('/internal/scheduler/weekly-animation', async (req, res) => {
  try {
    const { data } = req.body || {};
    const postId = data?.postId || context.postId;
    const targetWeek = data?.week;
    if (!postId || !targetWeek) {
      console.error('[animation] missing postId or week');
      return res.json({ ok: false, reason: 'missing postId or week' });
    }

    console.log('[animation] starting GIF generation for week', targetWeek);

    // Check if already generated
    const existingPost = await redis.get(ANIMATION_POST_KEY(targetWeek));
    if (existingPost) {
      console.log('[animation] already generated for week', targetWeek, ':', existingPost);
      return res.json({ ok: true, alreadyExists: true, postId: existingPost });
    }

    // Load all frame keys and filter to the target week
    const allKeys = await loadFrameKeys(postId);
    const weekFrames: { key: string; timestamp: number }[] = [];
    for (const key of allKeys) {
      const frame = await loadFrame(postId, key);
      if (!frame) continue;
      if (frame.status && frame.status !== 'active') continue;
      // Determine week
      let fw: number;
      if (typeof frame.week === 'number') {
        fw = frame.week;
      } else if (frame.timestamp) {
        fw = await computeWeekForTimestamp(frame.timestamp);
      } else {
        continue;
      }
      if (fw === targetWeek) {
        weekFrames.push({ key, timestamp: frame.timestamp || 0 });
      }
    }

    // Sort chronologically
    weekFrames.sort((a, b) => a.timestamp - b.timestamp);
    console.log('[animation] found', weekFrames.length, 'frames for week', targetWeek);

    if (weekFrames.length < 1) {
      console.log('[animation] no frames for week', targetWeek, '— skipping');
      return res.json({ ok: false, reason: 'no frames' });
    }

    // Decode all frames to RGBA pixels
    const pixelFrames: { width: number; height: number; data: Uint8Array }[] = [];
    for (const { key } of weekFrames) {
      const px = await fetchFramePixels(postId, key);
      if (px) pixelFrames.push(px);
    }

    if (pixelFrames.length < 1) {
      console.log('[animation] no valid pixel data — skipping');
      return res.json({ ok: false, reason: 'no valid frames' });
    }

    console.log('[animation] decoded', pixelFrames.length, 'frames. Encoding GIF at 12 FPS...');

    // Encode animated GIF at 12 FPS (83ms per frame)
    const DELAY_MS = 83; // 1000 / 12 ≈ 83ms
    const encoder = GIFEncoder();
    // Canonical output size — matches the client's fixed 720x1280 PORTRAIT export.
    // Frames from any device (or older mixed-resolution frames) are resized to this
    // so the animation includes EVERY frame instead of dropping mismatched ones.
    const targetW = 720;
    const targetH = 1280;

    // Nearest-neighbor RGBA resize (no canvas API on the Devvit server runtime).
    const resizeRGBA = (src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array => {
      if (sw === dw && sh === dh) return src;
      const out = new Uint8Array(dw * dh * 4);
      for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
          const si = (sy * sw + sx) * 4;
          const di = (y * dw + x) * 4;
          out[di] = src[si]!; out[di + 1] = src[si + 1]!; out[di + 2] = src[si + 2]!; out[di + 3] = src[si + 3]!;
        }
      }
      return out;
    };

    let encoded = 0;
    for (const frame of pixelFrames) {
      const rgba = (frame.width !== targetW || frame.height !== targetH)
        ? resizeRGBA(frame.data, frame.width, frame.height, targetW, targetH)
        : frame.data;
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      encoder.writeFrame(index, targetW, targetH, { palette, delay: DELAY_MS });
      encoded++;
    }
    encoder.finish();
    console.log('[animation] encoded', encoded, 'of', pixelFrames.length, 'frames at', targetW, 'x', targetH);

    const gifBytes = encoder.bytes();
    console.log('[animation] GIF encoded:', gifBytes.length, 'bytes');

    if (gifBytes.length > 19 * 1024 * 1024) {
      console.error('[animation] GIF too large:', gifBytes.length, 'bytes');
      return res.json({ ok: false, reason: 'gif too large' });
    }

    // Convert to data URL for media.upload
    const gifBase64 = Buffer.from(gifBytes).toString('base64');
    const gifDataUrl = `data:image/gif;base64,${gifBase64}`;

    // Upload to Reddit CDN
    const uploadResult = await media.upload({ url: gifDataUrl, type: 'gif' });
    const gifUrl = uploadResult.mediaUrl;
    console.log('[animation] uploaded GIF to Reddit CDN:', gifUrl);

    // Get theme info for the title
    const weekMeta = await redis.get(SHOWCASE_WEEK_META_KEY(targetWeek));
    let theme = '';
    if (weekMeta) {
      try {
        const meta = JSON.parse(weekMeta);
        theme = meta.theme || '';
      } catch {}
    }
    if (!theme && targetWeek === 1) theme = 'Moving Lines';

    const frameCount = pixelFrames.length;
    const title = theme
      ? `🎬 Week ${targetWeek} Animation — ${theme} | ${frameCount} Frames`
      : `🎬 Week ${targetWeek} Animation | ${frameCount} Frames`;

    // Create the post
    const { subredditName } = context;
    if (!subredditName) {
      console.error('[animation] no subredditName');
      return res.json({ ok: false, reason: 'no subredditName' });
    }

    const animPost = await reddit.submitPost({
      subredditName,
      title,
      url: gifUrl,
    });

    await redis.set(ANIMATION_POST_KEY(targetWeek), animPost.id);
    await redis.set(`animation:scheduled:w${targetWeek}`, 'completed');
    console.log('[animation] published animation post:', animPost.id, 'for week', targetWeek);

    return res.json({ ok: true, postId: animPost.id, gifUrl, frameCount });
  } catch (e: any) {
    console.error('[animation] error:', e?.message, e?.stack);
    return res.status(500).json({ ok: false, error: e?.message });
  }
});

// Debug endpoint to manually trigger animation generation for a specific week
app.post('/api/debug/generate-animation', async (req, res) => {
  try {
    const { postId } = context;
    const week = req.body?.week;
    const force = req.body?.force === true;
    if (!postId || !week) return res.status(400).json({ ok: false, reason: 'postId and week required' });

    if (force) {
      // Clear the dedup so a fresh GIF is generated (overrides an already-generated post).
      const anyRedis: any = redis as any;
      try { if (typeof anyRedis.del === 'function') await anyRedis.del(ANIMATION_POST_KEY(week)); else await redis.set(ANIMATION_POST_KEY(week), ''); } catch {}
      try { await redis.set(`animation:scheduled:w${week}`, ''); } catch {}
    }

    await scheduler.runJob({
      name: 'weekly-animation',
      data: { postId, week },
      runAt: new Date(Date.now() + 1000),
    });
    res.json({ ok: true, forced: force, message: `Animation job scheduled for week ${week} (runs in ~1s)${force ? ' [forced regenerate]' : ''}` });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// Debug: force (re)create the CURRENT week's showcase announcement post, clearing any
// stale dedup entry first (fixes a week whose announcement was skipped by a stale hash).
app.post('/api/debug/force-showcase', async (_req, res) => {
  try {
    const { subredditName, postId } = context;
    const week = await ensureCurrentWeek();
    if (subredditName) {
      try { await redis.hDel(`weekly_showcase_posts:${subredditName}`, [String(week)]); } catch {}
    }
    await redis.set(SHOWCASE_WEEKLY_KEY('', week), '');
    await redis.set(SHOWCASE_WEEK_META_KEY(week), '');
    const newId = await ensureWeeklyShowcasePost(postId);
    res.json({ ok: true, week, postId: newId });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});
