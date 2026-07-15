import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Frame } from '../App';
import { WeekVideo } from './WeekVideo';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface VideoPlayerProps { fitHeight?: boolean }
interface WeekBundle { palette: string[]; director?: string }

// Past weeks are frozen history, so their bundles survive reloads here.
const BUNDLE_CACHE_KEY = 'kinoraWeekBundles';
const readBundleCache = (): Record<number, WeekBundle> => {
  try { return JSON.parse(localStorage.getItem(BUNDLE_CACHE_KEY) || '{}'); } catch { return {}; }
};
const writeBundleCache = (b: Record<number, WeekBundle>) => {
  try { localStorage.setItem(BUNDLE_CACHE_KEY, JSON.stringify(b)); } catch { /* quota / private mode */ }
};

const mapItemToFrame = (o: any): Frame => ({
  id: o.key, imageData: o.src || o.url || '', timestamp: o.lastModified || Date.now(),
  artist: o.artist || 'anonymous', paletteWeek: o.week ?? 0, key: o.key,
});

// Only the focused week's frames are fetched, and only when focused — so the player loads one
// week's worth of images at a time instead of the whole history. The week list comes from the
// O(weeks) /api/frame-weeks index, so this scales to years of animations.
export const VideoPlayer: React.FC<VideoPlayerProps> = ({ fitHeight }) => {
  const [weeks, setWeeks] = useState<number[]>([]);
  const [focusWeek, setFocusWeek] = useState<number | null>(null);
  const [framesByWeek, setFramesByWeek] = useState<Record<number, Frame[]>>({});
  const [loadingWeek, setLoadingWeek] = useState(false);

  // Week list (which weeks have frames). Cheap, index-backed.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch('/api/frame-weeks');
        if (!r.ok) return;
        const j = await r.json();
        const ws: number[] = Array.isArray(j.weeks) ? j.weeks.map((w: any) => w.week).sort((a: number, b: number) => a - b) : [];
        if (cancel) return;
        setWeeks(ws);
        setFocusWeek(prev => prev ?? (ws.at(-1) ?? null)); // default to the newest week
      } catch { /* ignore */ }
    })();
    return () => { cancel = true; };
  }, []);

  // The focused week's frames, fetched on demand. Past weeks are cached in state (immutable), the
  // newest week is always refetched since it can still gain frames.
  const newestWeek = weeks.at(-1) ?? null;
  useEffect(() => {
    if (focusWeek == null) return;
    if (framesByWeek[focusWeek] && focusWeek !== newestWeek) return;
    let cancel = false;
    setLoadingWeek(true);
    (async () => {
      try {
        const r = await fetch(`/api/list-frames?week=${focusWeek}&meta=1`);
        if (!r.ok) return;
        const j = await r.json();
        const arr: Frame[] = Array.isArray(j.frames) ? j.frames.map(mapItemToFrame).sort((a: Frame, b: Frame) => a.timestamp - b.timestamp) : [];
        if (cancel) return;
        setFramesByWeek(prev => ({ ...prev, [focusWeek]: arr }));
      } catch { /* ignore */ } finally { if (!cancel) setLoadingWeek(false); }
    })();
    return () => { cancel = true; };
  }, [focusWeek, newestWeek]);

  const weekIndex = focusWeek == null ? -1 : weeks.indexOf(focusWeek);
  const prevWeek = weekIndex > 0 ? weeks[weekIndex - 1]! : null;
  const nextWeek = weekIndex >= 0 && weekIndex < weeks.length - 1 ? weeks[weekIndex + 1]! : null;
  const currentFrames = focusWeek != null ? framesByWeek[focusWeek] : undefined;

  // Each week's palette + director for the clapper library, from the same authoritative bundle
  // the gallery uses. A finished week's bundle never changes, so it is cached; only the newest
  // week is refetched. Without this, opening Play fired one request per week of history.
  const [bundles, setBundles] = useState<Record<number, WeekBundle>>(() => readBundleCache());
  const weekKey = weeks.join(',');
  useEffect(() => {
    if (!weekKey) return;
    let cancel = false;
    (async () => {
      const ws = weekKey.split(',').map(Number);
      const cached = readBundleCache();
      const newest = Math.max(...ws);
      const missing = ws.filter(w => w === newest || !cached[w]);
      const results = await Promise.all(missing.map(async w => {
        try { const r = await fetch(`/api/week-bundle?week=${w}`); if (!r.ok) return null; return { week: w, bundle: await r.json() }; }
        catch { return null; }
      }));
      if (cancel) return;
      const nextB: Record<number, WeekBundle> = {};
      for (const res of results) {
        if (!res || !res.bundle) continue;
        nextB[res.week] = {
          palette: Array.isArray(res.bundle.palette) ? res.bundle.palette.slice(0, 6) : [],
          director: res.bundle.director || undefined,
        };
      }
      if (Object.keys(nextB).length) { const merged = { ...cached, ...nextB }; setBundles(merged); writeBundleCache(merged); }
    })();
    return () => { cancel = true; };
  }, [weekKey]);

  // Desktop puts the picker in a right-hand column, which frees the player to use the full
  // screen height (it is portrait, so height is what makes it big). Mobile keeps its natural
  // size with the picker stacked below — scrolling a phone to reach it is expected.
  const videoRowRef = useRef<HTMLDivElement>(null);
  const [videoH, setVideoH] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!fitHeight) { setVideoH(undefined); return; }
    const update = () => {
      const row = videoRowRef.current;
      if (!row) return;
      const top = row.getBoundingClientRect().top;
      // Slack covers the player's own caption above and frame count below (both inside the
      // measured row), plus the page's bottom padding.
      setVideoH(Math.max(240, window.innerHeight - top - 84));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [fitHeight, weekKey]);

  const emptyLibrary = useMemo(() => weeks.length === 0, [weeks]);
  if (emptyLibrary) {
    return <div className="text-center py-12 text-white/60">No frames yet</div>;
  }
  return (
    <div className="space-y-6">
      <h2 className="text-center text-3xl font-bold text-white">Animation Gallery</h2>
      {/* Desktop: player left, clapper library right. Mobile: stacked. */}
      <div ref={videoRowRef} className={fitHeight ? 'flex items-start justify-center gap-6' : 'space-y-6'}>
        <div className="flex items-center justify-center gap-4">
          <button onClick={() => prevWeek != null && setFocusWeek(prevWeek)} disabled={prevWeek == null} aria-label="Previous week" className={`p-2 rounded-full border border-white/20 text-white/70 hover:text-white hover:bg-white/10 ${prevWeek == null ? 'opacity-30 cursor-not-allowed' : ''}`}><ChevronLeft className="w-5 h-5" /></button>
          {currentFrames && currentFrames.length
            ? <WeekVideo frames={currentFrames} title={`Week ${focusWeek}`} height={videoH} />
            : <div className="flex items-center justify-center text-white/40 text-sm" style={{ width: videoH ? Math.round(videoH * 9 / 16) : 300, height: videoH ?? 533 }}>{loadingWeek ? 'Loading…' : 'No frames'}</div>}
          <button onClick={() => nextWeek != null && setFocusWeek(nextWeek)} disabled={nextWeek == null} aria-label="Next week" className={`p-2 rounded-full border border-white/20 text-white/70 hover:text-white hover:bg-white/10 ${nextWeek == null ? 'opacity-30 cursor-not-allowed' : ''}`}><ChevronRight className="w-5 h-5" /></button>
        </div>
        <div
          className={fitHeight ? 'shrink-0 overflow-y-auto pt-6 pr-1' : 'pt-2'}
          style={fitHeight && videoH ? { maxHeight: videoH } : undefined}
        >
          <div className={fitHeight ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-2 justify-center'}>
          {weeks.map(w => {
            const b = bundles[w];
            const palette = b?.palette?.length ? b.palette : [];
            const active = w === focusWeek;
            return (
              <button
                key={w}
                onClick={() => setFocusWeek(w)}
                aria-pressed={active}
                aria-label={`Week ${w}`}
                className={`clapper clapper-mini ${active ? 'is-active' : ''}`}
              >
                <div className="clapper-mini-stripes">
                  {palette.length
                    ? palette.map((c, i) => <div key={i} className="clapper-stripe-tile" style={{ background: c }} />)
                    : <div className="clapper-stripe-tile" style={{ background: 'var(--hatch-light)', opacity: 0.3 }} />}
                </div>
                <div className="clapper-mini-meta">
                  <span className="clapper-mini-week">Week {w}</span>
                  <span className="clapper-director">{b?.director ? 'u/' + b.director : '—'}</span>
                </div>
              </button>
            );
          })}
          </div>
        </div>
      </div>
    </div>
  );
};
