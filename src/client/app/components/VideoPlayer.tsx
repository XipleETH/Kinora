import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Frame } from '../App';
import { WeekVideo } from './WeekVideo';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface VideoPlayerProps { frames: Frame[]; fitHeight?: boolean }
interface WeekBundle { palette: string[]; director?: string }

// Past weeks are frozen history, so their bundles survive reloads here.
const BUNDLE_CACHE_KEY = 'kinoraWeekBundles';
const readBundleCache = (): Record<number, WeekBundle> => {
  try { return JSON.parse(localStorage.getItem(BUNDLE_CACHE_KEY) || '{}'); } catch { return {}; }
};
const writeBundleCache = (b: Record<number, WeekBundle>) => {
  try { localStorage.setItem(BUNDLE_CACHE_KEY, JSON.stringify(b)); } catch { /* quota / private mode */ }
};

// Group frames by paletteWeek (placeholder property)
export const VideoPlayer: React.FC<VideoPlayerProps> = ({ frames, fitHeight }) => {
  const groups = useMemo(()=>{
    const map = new Map<number, Frame[]>();
    for(const f of frames){
      const arr = map.get(f.paletteWeek) || [];
      arr.push(f);
      map.set(f.paletteWeek, arr);
    }
    const list = Array.from(map.entries()).map(([week, arr])=>({ week, frames: arr.sort((a,b)=>a.timestamp-b.timestamp) }));
    list.sort((a,b)=>a.week-b.week);
    return list;
  },[frames]);
  const currentWeek = groups.at(-1)?.week ?? 1;
  const [focusWeek,setFocusWeek] = useState<number>(currentWeek);
  const weekIndex = groups.findIndex(g=>g.week===focusWeek);
  const prev = weekIndex>0? groups[weekIndex-1]: null;
  const current = weekIndex>=0? groups[weekIndex]: null;
  const next = (weekIndex>=0 && weekIndex < groups.length-1)? groups[weekIndex+1]: null;
  // Every week that has frames gets a clapper. The library column scrolls, so the list can grow
  // indefinitely; capping it would silently hide old weeks with nothing to hint they exist.
  const recentWeeks = groups;

  // Each week's palette + director for the picker, from the same authoritative bundle the
  // gallery uses, so a past week shows the config it was actually drawn with.
  // A finished week's bundle never changes again, so it is cached: without this, opening Play
  // fired one request per week — fine at 8 weeks, hundreds once the library stopped capping.
  // The newest week is always refetched, being the only one still live.
  const [bundles,setBundles] = useState<Record<number,WeekBundle>>(()=> readBundleCache());
  const weekKey = recentWeeks.map(g=>g.week).join(',');
  useEffect(()=>{
    if(!weekKey) return;
    let cancel = false;
    (async ()=>{
      const weeks = weekKey.split(',').map(Number);
      const cached = readBundleCache();
      const newest = Math.max(...weeks);
      const missing = weeks.filter(w => w === newest || !cached[w]);
      const results = await Promise.all(missing.map(async w => {
        try {
          const r = await fetch(`/api/week-bundle?week=${w}`);
          if(!r.ok) return null;
          const j = await r.json();
          return { week: w, bundle: j };
        } catch { return null; }
      }));
      if(cancel) return;
      const next: Record<number,WeekBundle> = {};
      for(const res of results){
        if(!res || !res.bundle) continue;
        next[res.week] = {
          palette: Array.isArray(res.bundle.palette) ? res.bundle.palette.slice(0,6) : [],
          director: res.bundle.director || undefined,
        };
      }
      if(Object.keys(next).length){
        const merged = { ...cached, ...next };
        setBundles(merged);
        writeBundleCache(merged);
      }
    })();
    return ()=>{ cancel = true; };
  },[weekKey]);

  // Desktop puts the picker in a right-hand column, which frees the player to use the full
  // screen height (it is portrait, so height is what makes it big). Mobile keeps its natural
  // size with the picker stacked below — scrolling a phone to reach it is expected.
  const videoRowRef = useRef<HTMLDivElement>(null);
  const [videoH,setVideoH] = useState<number|undefined>(undefined);
  useEffect(()=>{
    if(!fitHeight){ setVideoH(undefined); return; }
    const update = ()=>{
      const row = videoRowRef.current;
      if(!row) return;
      const top = row.getBoundingClientRect().top;
      // Slack covers the player's own caption above and frame count below (both inside the
      // measured row), plus the page's bottom padding.
      setVideoH(Math.max(240, window.innerHeight - top - 84));
    };
    update();
    window.addEventListener('resize', update);
    return ()=> window.removeEventListener('resize', update);
  },[fitHeight, weekKey]);

  if(groups.length===0){
    return <div className="text-center py-12 text-white/60">No frames yet</div>;
  }
  return (
    <div className="space-y-6">
      <h2 className="text-center text-3xl font-bold text-white">Animation Gallery</h2>
      {/* One week at a time — the chevrons and the picker below move between weeks. */}
      {/* Desktop: player left, clapper library right. Mobile: stacked. */}
      <div ref={videoRowRef} className={fitHeight ? 'flex items-start justify-center gap-6' : 'space-y-6'}>
        <div className="flex items-center justify-center gap-4">
          <button onClick={()=> prev && setFocusWeek(prev.week)} disabled={!prev} aria-label="Previous week" className={`p-2 rounded-full border border-white/20 text-white/70 hover:text-white hover:bg-white/10 ${!prev? 'opacity-30 cursor-not-allowed':''}`}><ChevronLeft className="w-5 h-5"/></button>
          {current && <WeekVideo frames={current.frames} title={`Week ${current.week}`} height={videoH}/>}
          <button onClick={()=> next && setFocusWeek(next.week)} disabled={!next} aria-label="Next week" className={`p-2 rounded-full border border-white/20 text-white/70 hover:text-white hover:bg-white/10 ${!next? 'opacity-30 cursor-not-allowed':''}`}><ChevronRight className="w-5 h-5"/></button>
        </div>
        <div
          className={fitHeight ? 'shrink-0 overflow-y-auto pt-6 pr-1' : 'pt-2'}
          style={fitHeight && videoH ? { maxHeight: videoH } : undefined}
        >
          <div className={fitHeight ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-2 justify-center'}>
          {recentWeeks.map(g=> {
            const b = bundles[g.week];
            const palette = b?.palette?.length ? b.palette : [];
            const active = g.week===focusWeek;
            return (
              <button
                key={g.week}
                onClick={()=>setFocusWeek(g.week)}
                aria-pressed={active}
                aria-label={`Week ${g.week}`}
                className={`clapper clapper-mini ${active? 'is-active':''}`}
              >
                <div className="clapper-mini-stripes">
                  {palette.length
                    ? palette.map((c,i)=> <div key={i} className="clapper-stripe-tile" style={{ background: c }} />)
                    : <div className="clapper-stripe-tile" style={{ background: 'var(--hatch-light)', opacity: 0.3 }} />}
                </div>
                <div className="clapper-mini-meta">
                  <span className="clapper-mini-week">Week {g.week}</span>
                  <span className="clapper-director">{b?.director ? 'u/'+b.director : '—'}</span>
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
