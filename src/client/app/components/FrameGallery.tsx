import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Frame } from '../App';
import { User, Calendar, ArrowBigUp, ArrowBigDown } from 'lucide-react';

interface FrameGalleryProps {
  pendingFrame?: { imageData: string; startedAt: number } | null;
  initialVotes?: Record<string, { up: number; down: number; my: -1|0|1 }>;
  showModeration?: boolean;  // Force show moderation panel (override auto-detect)
  currentWeek?: number;      // so the current week's group shows even with 0 frames
}

const mapItemToFrame = (o: any): Frame => ({
  id: o.key, imageData: o.src || o.url || '', timestamp: o.lastModified || Date.now(),
  artist: o.artist || 'anonymous', paletteWeek: o.week ?? 0, key: o.key,
});

// The gallery lists every week from the O(weeks) /api/frame-weeks index and loads a week's frames
// only when its accordion opens (?week=N). So opening the gallery — and each week — costs one
// week's worth of data, never the whole history. That is what lets it hold years of frames.
export const FrameGallery: React.FC<FrameGalleryProps> = ({ pendingFrame, initialVotes, showModeration, currentWeek }) => {
  const [weekCounts, setWeekCounts] = useState<Record<number, number>>({});
  const [weekFrames, setWeekFrames] = useState<Record<number, Frame[]>>({});
  const [loadingWeeks, setLoadingWeeks] = useState<Record<number, boolean>>({});
  const [openWeeks, setOpenWeeks] = useState<Record<number, boolean>>({});
  const [votes, setVotes] = useState<Record<string, { up: number; down: number; my: -1|0|1 }>>(initialVotes ? { ...initialVotes } : {});
  const [isMod, setIsMod] = useState(false);
  const [modFrames, setModFrames] = useState<any[]>([]);
  const [fetchingDirectors, setFetchingDirectors] = useState(false);
  // Store resolved winning bundle data (theme + palette + brush names) per week
  const [weekBundles, setWeekBundles] = useState<Record<number,{ theme:string; palette:string[]; brushes:string[]; director?:string }>>({});
  const [hydrated, setHydrated] = useState<Record<string,string>>({});
  const formatDate = (timestamp: number) => new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Which weeks exist + their counts — cheap, index-backed. No frame data loaded here.
  useEffect(()=>{
    let cancel = false;
    (async ()=>{
      try {
        const r = await fetch('/api/frame-weeks');
        if (!r.ok) return;
        const j = await r.json();
        if (cancel) return;
        const counts: Record<number, number> = {};
        for (const w of (j.weeks || [])) counts[w.week] = w.count;
        setWeekCounts(counts);
      } catch {/* ignore */}
    })();
    return ()=>{ cancel = true; };
  }, []);

  // Load one week's frames on demand (accordion open), and seed that week's votes from the same
  // response. Past weeks are cached; the current week is refetched since it can still grow.
  const ensureWeekLoaded = useCallback(async (week: number, force = false)=>{
    if (!force && weekFrames[week]) return;
    setLoadingWeeks(s=>({ ...s, [week]: true }));
    try {
      const r = await fetch(`/api/list-frames?week=${week}&meta=1`);
      if (r.ok) {
        const j = await r.json();
        const arr: Frame[] = (j.frames || []).map(mapItemToFrame).sort((a:Frame,b:Frame)=>a.timestamp-b.timestamp);
        setWeekFrames(m=>({ ...m, [week]: arr }));
        setWeekCounts(c=>({ ...c, [week]: arr.length }));
        if (!initialVotes) {
          setVotes(v=>{
            const nv = { ...v };
            for (const f of (j.frames || [])) {
              const k = f.key; if (!k) continue;
              if (f.votesUp != null || f.votesDown != null || f.myVote != null) nv[k] = { up: f.votesUp||0, down: f.votesDown||0, my: (f.myVote ?? 0) as (-1|0|1) };
            }
            return nv;
          });
        }
      }
    } catch {/* ignore */} finally { setLoadingWeeks(s=>({ ...s, [week]: false })); }
  }, [weekFrames, initialVotes]);

  const toggleWeek = useCallback((week:number)=>{
    setOpenWeeks(o=>{ const next = { ...o, [week]: !o[week] }; if (next[week]) void ensureWeekLoaded(week); return next; });
  }, [ensureWeekLoaded]);

  // Moderation queue auto-detect
  useEffect(()=>{ (async ()=>{
    if (showModeration === false) { setIsMod(false); return; }
    try {
      const me = await fetch('/api/mod/me');
      if (me.ok) {
        const j = await me.json();
        if (showModeration === true || j.isMod) {
          setIsMod(true);
          const r = await fetch('/api/mod/frames');
          if (r.ok) { const mj = await r.json(); setModFrames(mj.frames||[]); }
        }
      }
    } catch {/* ignore */}
  })(); }, [showModeration]);

  const restoreFrame = useCallback(async (key:string)=>{
    try { const r = await fetch(`/api/mod/frames/${encodeURIComponent(key)}/restore`, { method:'POST' }); if (r.ok){ setModFrames(m=>m.filter(x=>x.key!==key)); } } catch {}
  },[]);
  const deleteFrame = useCallback(async (key:string)=>{
    try { const r = await fetch(`/api/mod/frames/${encodeURIComponent(key)}`, { method:'DELETE' }); if (r.ok){ setModFrames(m=>m.filter(x=>x.key!==key)); } } catch {}
  },[]);

  const vote = useCallback(async (key:string, dir: -1|0|1)=>{
    try {
      const res = await fetch(`/api/frame-vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, dir }) });
      if (!res.ok) return;
      const j = await res.json();
      setVotes(v => ({ ...v, [key]: { up: j.votesUp ?? 0, down: j.votesDown ?? 0, my: (j.myVote ?? 0) as (-1|0|1) } }));
    } catch {/* ignore */}
  }, []);

  const hydrateFrame = useCallback(async (frame: Frame) => {
    if (!frame || !frame.key) return;
    if (hydrated[frame.key]) return; // already hydrated
    try {
      const binResp = await fetch(`/api/frame/${encodeURIComponent(frame.key)}`);
      if (binResp.ok) {
        const blob = await binResp.blob();
        const reader = new FileReader();
        reader.onload = () => { const dataUrl = reader.result as string; setHydrated(h => ({ ...h, [frame.key!]: dataUrl })); };
        reader.readAsDataURL(blob);
      }
    } catch {/* ignore */}
  }, [hydrated]);

  // Weeks to render: every week that has frames, plus the current week even if still empty, so its
  // gallery appears the moment the week rolls over — not only after the first frame.
  const weekNumbers = useMemo(()=>{
    const s = new Set<number>(Object.keys(weekCounts).map(Number));
    if (currentWeek) s.add(currentWeek);
    return Array.from(s).sort((a,b)=>a-b);
  }, [weekCounts, currentWeek]);

  const totalPublished = useMemo(()=> Object.values(weekCounts).reduce((a,b)=>a+b,0), [weekCounts]);

  const showPending = !!pendingFrame; // header dedupe removed with the full-list load; pending is shown while in progress

  // Fetch each week's AUTHORITATIVE bundle (theme/palette/brushes/director) so every past week
  // shows the config it was actually drawn with, not the current week's palette.
  useEffect(()=>{
    let cancel = false;
    (async ()=>{
      if (!weekNumbers.length) return;
      setFetchingDirectors(true);
      try {
        const results = await Promise.all(weekNumbers.map(async w => {
          try { const r = await fetch(`/api/week-bundle?week=${w}`); if (!r.ok) return null; return { week: w, bundle: await r.json() }; }
          catch { return null; }
        }));
        if (cancel) return;
        const bundles: Record<number,{ theme:string; palette:string[]; brushes:string[]; director?:string }> = {};
        for (const res of results) {
          if (!res || !res.bundle) continue;
          const b = res.bundle;
          bundles[res.week] = {
            theme: b.theme || '',
            palette: Array.isArray(b.palette) ? b.palette.slice(0,6) : [],
            brushes: Array.isArray(b.brushes) ? b.brushes.slice(0,4) : [],
            director: b.director || undefined,
          };
        }
        if (Object.keys(bundles).length) setWeekBundles(prev=>({ ...prev, ...bundles }));
      } finally { if (!cancel) setFetchingDirectors(false); }
    })();
    return ()=>{ cancel = true; };
  }, [weekNumbers.join(',')]);

  if (weekNumbers.length === 0 && !showPending) return (
    <div className="text-center py-16">
      <div className="bg-white/10 backdrop-blur-sm rounded-2xl p-12 border border-white/20 max-w-md mx-auto">
        <h3 className="text-2xl font-bold text-white mb-4">No frames yet</h3>
        <p className="text-white/70 mb-6">Start drawing to create your first frame and contribute to the collaborative video.</p>
        <div className="w-24 h-24 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full mx-auto opacity-20" />
      </div>
    </div>
  );

  return (
      <div className="space-y-10">
        {isMod && (
          <div className="bg-amber-500/10 border border-amber-400/30 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-amber-200 text-sm font-semibold">Moderation Queue</h3>
              <span className="text-amber-200/70 text-xs">{modFrames.length} flagged</span>
            </div>
            {modFrames.length===0 ? (
              <div className="text-amber-200/70 text-xs">Queue is empty.</div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                {modFrames.map(mf=> (
                  <div key={mf.key} className="bg-white/5 border border-white/10 rounded-lg overflow-hidden">
                    <div className="aspect-[9/16] bg-black/40">
                      <img src={mf.url} alt={mf.key} className="w-full h-full object-contain" />
                    </div>
                    <div className="p-2">
                      <div className="flex items-center justify-between text-[10px] text-white/70">
                        <span className="truncate max-w-[80px]">{mf.artist}</span>
                        <span>{(mf.votesUp||0) - (mf.votesDown||0)}</span>
                      </div>
                      <div className="mt-1 flex gap-2">
                        <button onClick={()=>restoreFrame(mf.key)} className="flex-1 text-emerald-300 hover:text-emerald-200 text-[10px]">Restore</button>
                        <button onClick={()=>deleteFrame(mf.key)} className="flex-1 text-red-300 hover:text-red-200 text-[10px]">Delete</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="text-center">
          <h2 className="text-4xl font-bold text-white mb-2">Frame Gallery</h2>
          <p className="text-white/70 text-sm sm:text-base">{totalPublished} frames published{showPending ? ' • 1 in progress' : ''}</p>
        </div>

  {showPending && pendingFrame && (
          <div className="max-w-[1580px] mx-auto px-2">
              <div className="mb-4">
              <h3 className="text-white/80 text-sm font-semibold mb-1 tracking-wide uppercase">In progress</h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6 gap-3">
                <div className="relative bg-white/10 backdrop-blur-sm rounded-2xl overflow-hidden border border-yellow-400/40 hover:bg-white/20 transition-all duration-300">
                  <div className="relative aspect-[9/16] bg-black/40 flex items-center justify-center">
                    <img src={pendingFrame.imageData} alt="Pending frame" className="w-full h-full object-contain opacity-90" loading="lazy" />
                    <div className="absolute top-2 left-2 bg-yellow-500/80 text-black text-xs font-bold px-2 py-1 rounded">In progress</div>
                  </div>
                  <div className="p-2">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-white font-semibold text-[10px]">(day)</span>
                      <span className="text-white/60 text-[10px]">Not published</span>
                    </div>
                    <div className="flex items-center space-x-1.5 text-white/70 text-[10px]">
                      <Calendar className="w-3 h-3" />
                      <span>{formatDate(pendingFrame.startedAt)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

  {weekNumbers.map((week)=>{
          const list = weekFrames[week] || [];
          const sorted = [...list].sort((a,b)=>a.timestamp-b.timestamp);
          const count = weekCounts[week] ?? sorted.length;
          const bundle = weekBundles[week];
          const loaded = !!(bundle && Array.isArray(bundle.palette) && bundle.palette.length >= 3);
          const NEUTRAL_STRIPES = ['#e7e0cf','#ded7c4','#e7e0cf','#ded7c4','#e7e0cf','#ded7c4'];
          const palette = loaded ? bundle!.palette : NEUTRAL_STRIPES;
          const theme = loaded ? (bundle!.theme || (week === 1 ? 'Moving Lines' : '')) : '';
          const director = loaded ? (bundle!.director || undefined) : undefined;
          const brushLine = (loaded && bundle!.brushes && bundle!.brushes.length) ? bundle!.brushes.join(', ') : '';
          const isOpen = !!openWeeks[week];
          const isLoading = !!loadingWeeks[week];
          return (
            <div key={week} className="max-w-[1580px] mx-auto px-2">
              <div className="clapper">
                <div className="clapper-header">
                  <div className="clapper-stripes">
                    {palette.slice(0,6).map((c,i)=> <div key={i} className="clapper-stripe-tile" style={{ background: c }} />)}
                  </div>
                  <div className="clapper-meta-row" style={{rowGap:4}}>
                    <button onClick={()=>toggleWeek(week)} className="clapper-toggle-btn" aria-label="Toggle Week">
                      {isOpen ? '−' : '+'}
                    </button>
                    <div style={{display:'flex',flexDirection:'column',minWidth:160}}>
                      <span className="clapper-title">Week {week} Theme: {theme}</span>
                    </div>
                    <div className="clapper-info-line" style={{minWidth:70}}>
                      <span className="clapper-label">Frames</span>
                      <span className="clapper-sub">{count}</span>
                    </div>
                    <div className="clapper-info-line" style={{flex:1,minWidth:140}}>
                      <span className="clapper-label">Brushes</span>
                      <span className="clapper-sub" style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{brushLine}</span>
                    </div>
                    <div className="clapper-info-line" style={{minWidth:140}}>
                      <span className="clapper-label">Director</span>
                      <span className="clapper-director">{director ? 'u/'+director : (fetchingDirectors ? 'loading…' : 'unknown')}</span>
                    </div>
                  </div>
                </div>
                <div className={`clapper-body ${isOpen ? '' : 'closed'}`}>
                  <div className="clapper-grid">
                    {isOpen && isLoading && sorted.length === 0 ? (
                      <div style={{gridColumn:'1 / -1', textAlign:'center', padding:'18px 8px', fontSize:12, opacity:0.6}}>Loading…</div>
                    ) : sorted.length === 0 ? (
                      <div style={{gridColumn:'1 / -1', textAlign:'center', padding:'18px 8px', fontSize:12, opacity:0.6}}>No frames yet this week — be the first to draw!</div>
                    ) : [...sorted].reverse().map((frame, ri)=>{
                      const num = sorted.length - ri; // 1-based position within the week
                      const key = (frame as any).key || frame.id;
                      const preferredSrc = (frame as any).src || frame.imageData || hydrated[key];
                      return (
                        <div key={key} className="clapper-frame-card">
                          <div className="clapper-thumb">
                            {preferredSrc ? (
                              <img src={preferredSrc} alt={`Frame ${num}`} loading="lazy" onError={()=>{ if(!hydrated[key]) hydrateFrame(frame); }} />
                            ) : (
                              <button onClick={()=>hydrateFrame(frame)} className="vote-btn" title="Load image">Load</button>
                            )}
                          </div>
                          <div className="clapper-frame-meta">
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                              <span style={{fontSize:10,fontWeight:600}}>#{num}</span>
                              <span style={{fontSize:9,opacity:0.6}}>{new Date(frame.timestamp).toLocaleTimeString()}</span>
                            </div>
                            <div style={{display:'flex',alignItems:'center',gap:4,marginTop:2,fontSize:9}}>
                              <User className="w-3 h-3" />
                              <span className="truncate" style={{maxWidth:70}}>{frame.artist}</span>
                            </div>
                            <div style={{display:'flex',alignItems:'center',gap:4,marginTop:2,fontSize:8,opacity:0.7}}>
                              <Calendar className="w-3 h-3" />
                              <span>{formatDate(frame.timestamp)}</span>
                            </div>
                            {key && (
                              <div className="vote-bar">
                                <button aria-label="Upvote" onClick={()=>vote(key, votes[key]?.my===1 ? 0 : 1)} className={`vote-btn ${votes[key]?.my===1 ? 'active' : ''}`}>
                                  <ArrowBigUp className="w-4 h-4" />
                                </button>
                                <span style={{fontSize:9,opacity:0.7}}>{(votes[key]?.up ?? 0) - (votes[key]?.down ?? 0)}</span>
                                <button aria-label="Downvote" onClick={()=>vote(key, votes[key]?.my===-1 ? 0 : -1)} className={`vote-btn ${votes[key]?.my===-1 ? 'active' : ''}`}>
                                  <ArrowBigDown className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
};
