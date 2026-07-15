import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface ChatMessage { id:string; user:string; body:string; ts:number; week:number; }
interface ChatProps {
  currentWeek:number;
  currentUser:string|null;
  /** Desktop draw view: render as a paper panel in the rail next to the canvas. */
  inline?:boolean;
  /** Which side of the canvas the inline panel sits on (mirrors the tools rail). */
  side?:'left'|'right';
  onToggleSide?:()=>void;
  /** Match the tools rail height so canvas / tools / chat end level. */
  maxHeight?:number;
}

export const Chat:React.FC<ChatProps> = ({ currentWeek, currentUser, inline, side='left', onToggleSide, maxHeight }) => {
  const [messages,setMessages] = useState<ChatMessage[]>([]);
  const [input,setInput] = useState('');
  const [connected,setConnected] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [username,setUsername] = useState<string|undefined>(currentUser ?? undefined);
  const [week,setWeek] = useState<number>(currentWeek);
  const listRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource|null>(null);

  // Auto scroll
  useEffect(()=>{ const el = listRef.current; if(el) el.scrollTop = el.scrollHeight; }, [messages]);

  // Try to resolve reddit username if not provided
  useEffect(()=>{
    if(!username){
      (async ()=>{
        try {
          const r = await fetch('/api/user');
          if(r.ok){ const j = await r.json(); if(j?.username){ setUsername(j.username); } }
        } catch {}
      })();
    }
  },[username]);

  // Sync real current week from server to avoid stale prop (e.g. showing 1 when server is 37)
  useEffect(()=>{
    let cancelled = false;
    (async ()=>{
      try { const r = await fetch('/api/week'); if(r.ok){ const j=await r.json(); if(!cancelled && j?.week && j.week !== week){ setWeek(j.week); } } } catch {}
    })();
    return ()=>{ cancelled = true; };
  },[week]);

  useEffect(()=>{
    let pollingId:number|undefined;
    const startPolling = () => {
      if(pollingId) return; console.debug('[chat] start polling');
      const poll = async ()=>{
        try {
          const r = await fetch(`/api/chat?week=${week}&_=${Date.now()}`);
          if(r.ok){
            const j=await r.json();
            if(Array.isArray(j.messages)){
              setMessages(j.messages);
              setConnected(true);
            }
          } else if(r.status===401){ setError('no auth'); setConnected(false); }
        } catch(e){ /* swallow */ }
      };
      poll(); pollingId = window.setInterval(poll, 5000);
    };
    esRef.current?.close();
    setConnected(false); setError(null);
    // initial fetch always
  (async ()=>{ try { const r=await fetch(`/api/chat?week=${week}`); if(r.ok){ const j=await r.json(); if(Array.isArray(j.messages)){ setMessages(j.messages); setConnected(true); } } else if(r.status===401){ setError('no auth'); } } catch{} })();
    const isDevvitHost = /devvit\.net/.test(location.hostname);
    let timeout = window.setTimeout(()=>{ if(!connected){ console.warn('[chat] SSE timeout -> polling'); startPolling(); } }, 3500);
    try {
      if(!isDevvitHost){
        const es = new EventSource(`/api/chat/stream?week=${week}`);
      esRef.current = es;
      es.addEventListener('init', (ev:any)=>{
        try { const data = JSON.parse(ev.data); if(Array.isArray(data)) setMessages(data); setConnected(true); console.debug('[chat] SSE init messages', data.length); } catch { setConnected(true); }
        clearTimeout(timeout);
      });
      es.addEventListener('message', (ev:any)=>{
        try { const msg = JSON.parse(ev.data); setMessages(prev=>[...prev, msg]); } catch {}
      });
      es.onerror = ()=>{ console.warn('[chat] SSE error -> fallback polling'); startPolling(); };
      } else {
        // Skip SSE entirely on devvit host (likely blocked / 401)
        startPolling();
      }
    } catch {
      startPolling();
    }
    return ()=>{ esRef.current?.close(); if(pollingId) window.clearInterval(pollingId); clearTimeout(timeout); };
  }, [week]);

  const send = async () => {
    const body = input.trim(); if(!body) return;
    setInput('');
    try {
      console.debug('[chat] sending', { body });
  const r = await fetch('/api/chat',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ body }) });
      if(!r.ok){
        setError('send failed');
        if(r.status===401){ setError('no auth'); }
      } else {
        // Force immediate refresh so user sees their message without waiting interval
        try {
          const gr = await fetch(`/api/chat?week=${week}&_=${Date.now()}`);
          if(gr.ok){ const j=await gr.json(); if(Array.isArray(j.messages)) setMessages(j.messages); }
        } catch{}
      }
    } catch(e){ setError('send failed'); }
  };
  const onKey = (e:React.KeyboardEvent<HTMLInputElement>)=>{ if(e.key==='Enter'){ e.preventDefault(); send(); } };

  // Both variants are the same paper panel; `inline` only tightens the chrome to rail scale
  // and adds the side toggle. Standalone fills its view, inline matches the rail height.
  return (
    <div
      className={`sketch-border panel-hatch rounded-xl overflow-hidden flex flex-col ${inline ? 'w-full' : 'h-[calc(100dvh-120px)] md:h-full md:max-h-[540px]'}`}
      style={inline ? { height: maxHeight ?? 540 } : undefined}
    >
      <div className={`border-b-2 border-black/70 flex items-center justify-between gap-1 ${inline ? 'px-2.5 py-1.5' : 'px-4 py-2.5'}`}>
        <div className="flex items-baseline gap-1.5 min-w-0">
          <h3 className={`font-semibold tracking-wide shrink-0 ${inline ? 'text-[13px]' : 'text-lg'}`}>
            {inline ? `Chat W${week}` : `Chat — Week ${week}`}
          </h3>
          <span className={`shrink-0 ${inline ? 'text-[10px]' : 'text-xs'} ${connected? 'text-green-700':'text-yellow-700'}`}>{connected? 'live':'connecting…'}</span>
          {username && <span className={`text-black/50 truncate ${inline ? 'text-[10px]' : 'text-xs'}`}>you: {username}</span>}
          {error && <span className={`text-red-700 shrink-0 ${inline ? 'text-[10px]' : 'text-xs'}`}>{error}</span>}
        </div>
        {inline && onToggleSide && (
          <button onClick={onToggleSide} className="p-1 rounded-md pencil-btn shrink-0" aria-label="Switch side" title="Switch side">
            {side === 'right' ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      <div ref={listRef} className={`flex-1 overflow-y-auto ${inline ? 'px-2 py-2 space-y-1.5 text-[13px]' : 'px-4 py-3 space-y-2 text-sm'}`}>
        {messages.length===0 && <div className={`text-black/40 text-center ${inline ? 'py-6 text-[12px]' : 'py-8'}`}>No messages yet</div>}
        {messages.map(m=> (
          <div key={m.id} className={`rounded-md border border-black/25 bg-[#FAF3E0] leading-snug break-words ${inline ? 'px-2 py-1.5' : 'px-3 py-2'}`}>
            <span className="font-semibold">{m.user}</span>{' '}
            <span className="text-black/80">{m.body}</span>
            {/* Fixed en-US: the default locale rendered "10:53:16 p. m." for Spanish users. */}
            <span className={`text-black/35 ml-1 ${inline ? 'text-[10px]' : 'text-[11px]'}`}>{new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
        ))}
      </div>
      <div className={`border-t-2 border-black/70 flex ${inline ? 'p-2 gap-1.5' : 'p-3 gap-2'}`}>
        <input
          value={input}
          // allow input even anon; server will tag as anon
          disabled={false}
          onChange={e=> setInput(e.target.value.slice(0,280))}
          onKeyDown={onKey}
          placeholder={inline ? 'Message + Enter' : 'Type a message and hit Enter'}
          className={`flex-1 min-w-0 rounded-md border-2 border-black bg-[#FAF3E0] placeholder-black/40 focus:outline-none ${inline ? 'px-2 py-1.5 text-[13px]' : 'px-3 py-2 text-sm'}`}
        />
        <button onClick={send} disabled={!input.trim()} className={`pencil-btn pencil-fill-indigo rounded-md font-semibold disabled:opacity-40 shrink-0 ${inline ? 'px-2.5 text-[12px]' : 'px-4 text-sm'}`}>Send</button>
      </div>
    </div>
  );
};
