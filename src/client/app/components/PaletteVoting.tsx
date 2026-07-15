import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { allBrushPresets } from '../brushes';
import { ColorWheelPicker } from './ColorWheelPicker';
import { BrushPreview } from './BrushPreview';

interface PaletteVotingProps {}

interface Proposal {
  id: string;
  type: 'palette' | 'theme' | 'brushKit';
  title: string;
  data: any;
  proposedBy: string;
  proposedAt: number;
  votes: number;
  voters: string[];
}

export const PaletteVoting: React.FC<PaletteVotingProps> = () => {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [currentWeek, setCurrentWeek] = useState<number>(1);

  useEffect(()=>{ let cancel=false; (async()=>{ try { const r= await fetch('/api/week'); if(r.ok){ const j= await r.json(); if(!cancel) setCurrentWeek(j.week); } } catch{} })(); return ()=>{cancel=true}; },[]);

  const loadData = useCallback(async () => {
    try {
      const [proposalsRes, userRes] = await Promise.all([
        fetch(`/api/proposals?week=${currentWeek}`),
        fetch('/api/user')
      ]);
      if (proposalsRes.ok) {
        const proposalsData = await proposalsRes.json();
        setProposals(proposalsData.proposals || []);
      }
      if (userRes.ok) {
        const userData = await userRes.json();
        setCurrentUser(userData.username);
      }
    } catch (e) {
      console.error('[PaletteVoting] load error', e);
    } finally { setLoading(false); }
  }, [currentWeek]);

  useEffect(()=>{ loadData(); }, [loadData]);

  interface CombinedSet { groupId: string; theme: Proposal; palette: Proposal; brushes: Proposal; }
  const combinedSets: CombinedSet[] = useMemo(()=>{
    const byGroup: Record<string, Partial<CombinedSet>> = {};
    for (const p of proposals) {
      const gid = p.data?.groupId; if (!gid) continue;
      if (!byGroup[gid]) byGroup[gid] = { groupId: gid } as any;
      if (p.type === 'theme') (byGroup[gid] as any).theme = p;
      else if (p.type === 'palette') (byGroup[gid] as any).palette = p;
      else if (p.type === 'brushKit') (byGroup[gid] as any).brushes = p;
    }
    const sets = Object.values(byGroup)
      .filter(g => g.theme && g.palette && g.brushes)
      .map(g => g as CombinedSet)
      .sort((a,b)=> (b.theme.votes + b.palette.votes + b.brushes.votes) - (a.theme.votes + a.palette.votes + a.brushes.votes));
    // Persist top winner locally (theme/palette/brushes/director) for App & Gallery consumption
    if (sets.length) {
      try {
        const top = sets[0];
        const paletteColors: string[] = (Array.isArray(top.palette.data)? top.palette.data : top.palette.data?.colors) || [];
        const brushNames: string[] = top.brushes.data?.names || [];
        const payload = {
          theme: top.theme.title,
          director: top.theme.proposedBy,
          palette: paletteColors.slice(0,6),
          brushes: brushNames.slice(0,4),
          updatedAt: Date.now()
        };
        localStorage.setItem('weekBundle_'+(currentWeek+1), JSON.stringify(payload));
      } catch {/* ignore */}
    }
    return sets;
  }, [proposals, currentWeek]);

  const vote = useCallback(async (proposalId: string) => {
    try {
      const res = await fetch(`/api/proposals/${proposalId}/vote`, { method:'POST', headers:{'Content-Type':'application/json'} });
      if (res.ok) {
        const data = await res.json();
        setProposals(prev => prev.map(p => p.id===proposalId ? { ...p, votes:data.votes, voters: data.voted ? [...p.voters, currentUser!].filter(Boolean) : p.voters.filter(v=>v!==currentUser) } : p));
      }
    } catch(e){ console.error('[PaletteVoting] vote error', e); }
  }, [currentUser]);

  const submitProposal = useCallback(async (type: 'palette' | 'theme' | 'brushKit', title: string, data: any) => {
    if (submitting) return false;
    setSubmitting(true);
    try {
      const response = await fetch('/api/proposals', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ type, title, data }) });
      if (response.ok) {
        const result = await response.json();
        setProposals(prev => [result.proposal, ...prev]);
        return true;
      }
    } catch(e){ console.error('[PaletteVoting] submit error', e); }
    finally { setSubmitting(false); }
    return false;
  }, [submitting]);

  const hasUserVoted = (p: Proposal) => currentUser ? p.voters.includes(currentUser) : false;

  // Wizard state
  const [wizTheme, setWizTheme] = useState('');
  const [wizPaletteColors, setWizPaletteColors] = useState<string[]>(['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD']);
  const [activePaletteIndex, setActivePaletteIndex] = useState(0);
  const [wizBrushIds, setWizBrushIds] = useState<string[]>([]);
  const [wizardStep, setWizardStep] = useState<1|2|3>(1);
  const wizValidTheme = wizTheme.trim().length >= 3;
  const wizValidPalette = wizPaletteColors.length===6 && wizPaletteColors.every(c=>/^#[0-9A-Fa-f]{6}$/.test(c));
  const wizValidBrushes = wizBrushIds.length>0 && wizBrushIds.length<=4;
  const wizardComplete = wizValidTheme && wizValidPalette && wizValidBrushes;
  const toggleWizBrush = (id:string)=> setWizBrushIds(prev => prev.includes(id) ? prev.filter(x=>x!==id) : (prev.length<4 ? [...prev,id] : prev));
  const resetWizard = ()=>{ setWizTheme(''); setWizPaletteColors(['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD']); setWizBrushIds([]); setWizardStep(1); };

  const submitCombined = useCallback(async ()=>{
    if (!currentUser || submitting || !wizardComplete) return;
    setSubmitting(true);
    const groupId = 'grp_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
    try {
      const themeOk = await submitProposal('theme', wizTheme.trim(), { description: wizTheme.trim(), groupId });
      const paletteOk = await submitProposal('palette', 'Custom Palette', { colors: wizPaletteColors, groupId });
      const brushNames = allBrushPresets.filter(b=>wizBrushIds.includes(b.id)).map(b=>b.name);
      const brushOk = await submitProposal('brushKit', brushNames.join(' + '), { ids:wizBrushIds, names:brushNames, groupId });
      if (themeOk && paletteOk && brushOk) { resetWizard(); }
    } finally { setSubmitting(false); }
  }, [currentUser, submitting, wizardComplete, wizTheme, wizPaletteColors, wizBrushIds, submitProposal]);

  const voteCombined = useCallback(async (setObj: CombinedSet)=>{
    if (!currentUser) return;
    const alreadyTheme = hasUserVoted(setObj.theme);
    const alreadyPalette = hasUserVoted(setObj.palette);
    const alreadyBrush = hasUserVoted(setObj.brushes);
    if (alreadyTheme && alreadyPalette && alreadyBrush) return;
    if (!alreadyTheme) await vote(setObj.theme.id);
    if (!alreadyPalette) await vote(setObj.palette.id);
    if (!alreadyBrush) await vote(setObj.brushes.id);
  }, [currentUser, vote]);

  if (loading && proposals.length===0) {
    return <div className="flex items-center justify-center h-64"><div className="text-black/40 text-sm">Loading…</div></div>;
  }

  return (
    <div className="paper-shell pencil-theme px-4 py-6 mx-auto max-w-6xl">
      <div className="space-y-10">
        <section className="sketch-border rounded-2xl p-6 bg-[#FFF9EE] shadow-[4px_4px_0_0_#000]">
          <h3 className="text-2xl font-bold text-black mb-4">Submit a pitch</h3>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-black/50">Select — step {wizardStep} of 3</span>
              <div className="flex flex-wrap items-center gap-2">
                {([[1,'Theme'],[2,'Palette'],[3,'Brushes']] as [1|2|3,string][]).map(([n,name])=>{
                  const active = wizardStep===n;
                  const done = wizardStep>n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={()=>{ if(n<=wizardStep) setWizardStep(n); }}
                      disabled={n>wizardStep}
                      aria-current={active ? 'step' : undefined}
                      // Active inverts to ink like every other selected control; done stays
                      // green because it reads as completed, not as the current step.
                      style={active ? { backgroundColor: 'var(--ink)', color: 'var(--paper-bg)' } : { backgroundColor: done ? '#A7F3D0' : '#FFFFFF' }}
                      className={`sketch-border flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-bold transition ${n>wizardStep?'opacity-50 cursor-not-allowed':'cursor-pointer'}`}
                    >
                      <span
                        style={active
                          ? { backgroundColor: 'var(--paper-bg)', color: 'var(--ink)', borderColor: 'var(--paper-bg)' }
                          : { backgroundColor: done ? '#34D399' : '#FFFFFF', color: '#000000' }}
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] border-2 border-black"
                      >{done?'✓':n}</span>
                      <span>{name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {wizardStep===1 && (
              <div className="space-y-3">
                <label className="text-black/80 text-sm font-semibold">Weekly theme</label>
                <input value={wizTheme} onChange={e=>setWizTheme(e.target.value)} placeholder="e.g. Retro Future" className="w-full px-3 py-2 rounded-md sketch-border bg-white text-black placeholder-black/40" />
                <div className="flex justify-end">
                  <button disabled={!wizValidTheme} onClick={()=>setWizardStep(2)} className={`sketch-border px-5 py-2 rounded-lg font-bold ${wizValidTheme? 'bg-emerald-300 hover:bg-emerald-400 cursor-pointer':'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>Next</button>
                </div>
              </div>
            )}
            {wizardStep===2 && (
              <div className="space-y-4">
                <h4 className="text-black font-semibold">Palette — tap a slot, then pick its color</h4>
                <div className="flex flex-wrap gap-2 justify-center">
                  {wizPaletteColors.map((c,i)=>(
                    <button
                      key={i}
                      type="button"
                      onClick={()=>setActivePaletteIndex(i)}
                      aria-label={`Color slot ${i+1}`}
                      className="w-11 h-11 rounded-lg sketch-border cursor-pointer"
                      style={{ background:c, outline: activePaletteIndex===i ? '3px solid var(--ink)' : 'none', outlineOffset:'2px' }}
                    />
                  ))}
                </div>
                <div className="text-center text-[11px] font-bold uppercase tracking-wide text-black/50">Editing slot {activePaletteIndex+1} of 6</div>
                <div className="flex justify-center">
                  <ColorWheelPicker
                    value={wizPaletteColors[activePaletteIndex] || '#FF6B6B'}
                    onChange={(hex)=>{ const arr=[...wizPaletteColors]; arr[activePaletteIndex]=hex; setWizPaletteColors(arr); }}
                  />
                </div>
                <div className="flex justify-between items-center">
                  <button onClick={()=>setWizardStep(1)} className="sketch-border px-4 py-2 rounded-md bg-white text-black hover:bg-black/5 text-sm font-semibold">Back</button>
                  <div className="flex gap-2">
                    <button onClick={()=>setWizPaletteColors(['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD'])} className="sketch-border px-4 py-2 rounded-md bg-white text-black hover:bg-black/5 text-xs">Reset</button>
                    <button disabled={!wizValidPalette} onClick={()=>setWizardStep(3)} className={`sketch-border px-5 py-2 rounded-lg font-bold ${wizValidPalette? 'bg-emerald-300 hover:bg-emerald-400':'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>Next</button>
                  </div>
                </div>
              </div>
            )}
            {wizardStep===3 && (
              <div className="space-y-5">
                <h4 className="text-black font-semibold">Brushes — pick up to 4 <span className="text-black/50 text-sm font-bold">({wizBrushIds.length}/4)</span></h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {allBrushPresets.map(b=>{
                    const checked = wizBrushIds.includes(b.id);
                    const disabled = !checked && wizBrushIds.length>=4;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        disabled={disabled}
                        onClick={()=>toggleWizBrush(b.id)}
                        aria-pressed={checked}
                        style={checked ? { backgroundColor: 'var(--ink)', color: 'var(--paper-bg)' } : undefined}
                        className={`sketch-border rounded-lg p-2 flex flex-col items-center gap-1.5 ${disabled?'opacity-40 cursor-not-allowed':'cursor-pointer'}`}
                      >
                        {/* The sample stroke has to invert too, or it vanishes into the ink fill. */}
                        <BrushPreview preset={b} color={checked ? '#FAF3E0' : '#1b1b1b'} />
                        <span className={`text-[11px] font-bold text-center leading-tight ${checked ? '' : 'text-black'}`}>{b.name}</span>
                        {checked && <span className="text-[9px] font-bold opacity-80">✓ selected</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="flex justify-between items-center">
                  <button onClick={()=>setWizardStep(2)} className="sketch-border px-4 py-2 rounded-md bg-white text-black hover:bg-black/5 text-sm font-semibold">Back</button>
                  <div className="flex gap-2">
                    <button onClick={resetWizard} className="sketch-border px-4 py-2 rounded-md bg-white text-black hover:bg-black/5 text-xs">Reset</button>
                    <button disabled={!wizardComplete || submitting || !currentUser} onClick={submitCombined} className={`sketch-border px-5 py-2 rounded-lg font-bold ${wizardComplete && !submitting && currentUser? 'bg-emerald-300 hover:bg-emerald-400':'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>{submitting? 'Creating...' : 'Publish bundle'}</button>
                  </div>
                </div>
                {!currentUser && <div className="sketch-border p-3 rounded-md bg-[#FAF3E0] text-black text-xs font-semibold">You must log in to publish a pitch.</div>}
              </div>
            )}
          </div>
        </section>
        <section>
          <h3 className="text-2xl font-bold text-black mb-4">Vote on pitches</h3>
          {combinedSets.length===0 ? (
            <div className="text-center py-10 text-black/60 text-sm sketch-border rounded-xl bg-white">No complete pitches yet.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
              {combinedSets.map(setObj=>{
                const totalVotes = setObj.theme.votes; // using theme vote as representative
                const isHouse = setObj.theme.data?.house === true || setObj.theme.proposedBy === 'kinora-app';
                const alreadyAll = hasUserVoted(setObj.theme) && hasUserVoted(setObj.palette) && hasUserVoted(setObj.brushes);
                const paletteColors: string[] = (Array.isArray(setObj.palette.data)? setObj.palette.data : setObj.palette.data?.colors) || [];
                // Show how each brush actually paints, not just its name. Both wizard and
                // house proposals carry ids; fall back to matching on name if one doesn't.
                const brushNames: string[] = (setObj.brushes.data?.names || []);
                const brushIds: string[] = (setObj.brushes.data?.ids || []);
                const brushKit = brushNames.map((name, i) => ({
                  name,
                  preset: allBrushPresets.find(p => p.id === brushIds[i]) || allBrushPresets.find(p => p.name === name),
                }));
                return (
                  <div key={setObj.groupId} className={`sketch-border rounded-2xl p-5 shadow-[4px_4px_0_0_#000] flex flex-col gap-4 ${isHouse? 'bg-[#FFF9EE]':'bg-white'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="text-lg font-bold text-black">{setObj.theme.title}</h4>
                          {isHouse && <span style={{ backgroundColor: 'var(--ink)', color: 'var(--paper-bg)' }} className="px-2 py-0.5 rounded-full sketch-border text-[10px] font-bold uppercase tracking-wide">Default</span>}
                        </div>
                        <div className="text-[11px] font-semibold text-black/70 mb-1">Director: <span className="text-black">u/{setObj.theme.proposedBy}</span></div>
                        <div className="flex items-center gap-2 flex-wrap mb-2">
                          {paletteColors.slice(0,6).map((c,i)=>(<span key={i} className="w-5 h-5 rounded-sm sketch-border-inner" style={{background:c}} />))}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {brushKit.map(({ name, preset }, i)=>(
                            <span key={i} className="flex items-center gap-1 pl-1 pr-2 py-0.5 rounded-full bg-[#FAF3E0] sketch-border text-[11px] font-semibold text-black/80">
                              {preset && <BrushPreview preset={preset} width={30} height={14} />}
                              {name}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 font-bold text-black"><span className="text-sm">Votes:</span><span className="text-xl">{totalVotes}</span></div>
                    </div>
                    <button
                      onClick={()=>voteCombined(setObj)}
                      disabled={!currentUser || alreadyAll}
                      style={alreadyAll ? undefined : { backgroundColor: 'var(--ink)', color: 'var(--paper-bg)' }}
                      className={`sketch-border w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-bold transition-all ${alreadyAll? 'bg-emerald-300 cursor-default':'hover:opacity-85'} ${!currentUser? 'opacity-50 cursor-not-allowed':''}`}
                    >
                      <span>{alreadyAll? 'Voted!' : 'Vote'}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
