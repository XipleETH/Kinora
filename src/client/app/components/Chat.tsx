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
        setError('falló enviar');
        if(r.status===401){ setError('no auth'); }
      } else {
        // Force immediate refresh so user sees their message without waiting interval
        try {
          const gr = await fetch(`/api/chat?week=${week}&_=${Date.now()}`);
          if(gr.ok){ const j=await gr.json(); if(Array.isArray(j.messages)) setMessages(j.messages); }
        } catch{}
      }
    } catch(e){ setError('falló enviar'); }
  };
  const onKey = (e:React.KeyboardEvent<HTMLInputElement>)=>{ if(e.key==='Enter'){ e.preventDefault(); send(); } };

  // Inline = paper panel matching the tools rail; standalone = the existing full-width view.
  return (
    <div
      className={inline
        ? 'sketch-border panel-hatch rounded-xl overflow-hidden flex flex-col w-full'
        : 'flex flex-col h-[calc(100dvh-120px)] md:h-full md:max-h-[540px] bg-black/30 rounded-xl border border-white/10'}
      style={inline ? { height: maxHeight ?? 540 } : undefined}
    >
      <div className={inline
        ? 'px-2.5 py-1.5 border-b-2 border-black/70 flex items-center justify-between gap-1'
        : 'px-4 py-2 border-b border-white/10 flex items-center gap-2'}>
        <div className="flex items-baseline gap-1.5 min-w-0">
          {inline
            ? <h3 className="text-[13px] font-semibold tracking-wide shrink-0">Chat W{week}</h3>
            : <h3 className="text-white font-semibold text-lg">Chat Semana {week}</h3>}
          <span className={inline
            ? `text-[10px] shrink-0 ${connected? 'text-green-700':'text-yellow-700'}`
            : `text-xs ${connected? 'text-green-400':'text-yellow-400'}`}>{connected? 'en vivo':'conectando...'}</span>
          {username && <span className={inline ? 'text-[10px] text-black/50 truncate' : 'text-xs text-white/50'}>tú: {username}</span>}
          {error && <span className={inline ? 'text-[10px] text-red-700 shrink-0' : 'text-red-400 text-xs'}>{error}</span>}
        </div>
        {inline && onToggleSide && (
          <button onClick={onToggleSide} className="p-1 rounded-md pencil-btn shrink-0" aria-label="Switch side" title="Switch side">
            {side === 'right' ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      <div ref={listRef} className={inline
        ? 'flex-1 overflow-y-auto px-2 py-2 space-y-1.5 text-[13px]'
        : 'flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm'}>
        {messages.length===0 && <div className={inline ? 'text-black/40 text-center py-6 text-[12px]' : 'text-white/40 text-center py-8'}>Sin mensajes aún</div>}
        {messages.map(m=> (
          <div key={m.id} className={inline
            ? 'rounded-md border border-black/25 bg-[#FAF3E0] px-2 py-1.5 leading-snug break-words'
            : 'bg-white/5 rounded-md px-3 py-1.5 leading-snug'}>
            <span className={inline ? 'font-semibold' : 'text-white font-medium'}>{m.user}</span>{' '}
            <span className={inline ? 'text-black/80' : 'text-white/90'}>{m.body}</span>
            <span className={inline ? 'text-black/35 text-[10px] ml-1' : 'text-white/30 text-[10px] ml-2'}>{new Date(m.ts).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
      <div className={inline
        ? 'p-2 border-t-2 border-black/70 flex gap-1.5'
        : 'p-3 border-t border-white/10 flex gap-2'}>
        <input
          value={input}
          // allow input even anon; server will tag as anon
          disabled={false}
          onChange={e=> setInput(e.target.value.slice(0,280))}
          onKeyDown={onKey}
          placeholder={inline ? 'Mensaje + Enter' : 'Escribe un mensaje y Enter'}
          className={inline
            ? 'flex-1 min-w-0 rounded-md border-2 border-black bg-[#FAF3E0] px-2 py-1.5 text-[13px] placeholder-black/40 focus:outline-none'
            : 'flex-1 bg-white/10 rounded-md px-3 py-2 text-white placeholder-white/40 text-sm focus:outline-none'}
        />
        <button onClick={send} disabled={!input.trim()} className={inline
          ? 'pencil-btn pencil-fill-indigo rounded-md px-2.5 text-[12px] font-semibold disabled:opacity-40 shrink-0'
          : 'bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 text-white font-semibold px-4 rounded-md text-sm'}>Enviar</button>
      </div>
    </div>
  );
};
