import React, { useEffect, useRef, useState } from 'react';

interface ChatMessage { id:string; user:string; body:string; ts:number; week:number; }
interface ChatProps { currentWeek:number; currentUser:string|null; }

export const Chat:React.FC<ChatProps> = ({ currentWeek, currentUser }) => {
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

  return (
    <div className="flex flex-col h-full max-h-[540px] bg-black/30 rounded-xl border border-white/10">
      <div className="px-4 py-2 border-b border-white/10 flex items-center gap-2">
  <h3 className="text-white font-semibold text-lg">Chat Semana {week}</h3>
  <span className={`text-xs ${connected? 'text-green-400':'text-yellow-400'}`}>{connected? 'en vivo':'conectando...'}</span>
  {username && <span className="text-xs text-white/50">tú: {username}</span>}
        {error && <span className="text-red-400 text-xs">{error}</span>}
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm">
        {messages.length===0 && <div className="text-white/40 text-center py-8">Sin mensajes aún</div>}
        {messages.map(m=> (
          <div key={m.id} className="bg-white/5 rounded-md px-3 py-1.5 leading-snug">
            <span className="text-white font-medium">{m.user}</span>{' '}
            <span className="text-white/90">{m.body}</span>
            <span className="text-white/30 text-[10px] ml-2">{new Date(m.ts).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
      <div className="p-3 border-t border-white/10 flex gap-2">
        <input
          value={input}
          // allow input even anon; server will tag as anon
          disabled={false}
          onChange={e=> setInput(e.target.value.slice(0,280))}
          onKeyDown={onKey}
          placeholder={'Escribe un mensaje y Enter'}
          className="flex-1 bg-white/10 rounded-md px-3 py-2 text-white placeholder-white/40 text-sm focus:outline-none"
        />
  <button onClick={send} disabled={!input.trim()} className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 text-white font-semibold px-4 rounded-md text-sm">Enviar</button>
      </div>
    </div>
  );
};
