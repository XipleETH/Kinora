import { useState, useRef, useEffect, useCallback } from 'react';
import { Canvas } from './components/Canvas';
import { allBrushPresets, BrushPreset } from './brushes';
// import { ColorPalette } from './components/ColorPalette';
import { SidePanels, PanelKey } from './components/SidePanels';
import { Header } from './components/Header';
import { FrameGallery } from './components/FrameGallery';
import { VideoPlayer } from './components/VideoPlayer';
import { PaletteVoting } from './components/PaletteVoting';
import { Chat } from './components/Chat'; // <-- Import Chat component
// Header removed: navigation moved into SidePanels
import { ZoomIn, ZoomOut } from 'lucide-react';

// Simple onion icon (layered rings) replacing Layers icon
const OnionIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 3c0 3-2 4-3.5 6C6.8 11 6 12.5 6 15a6 6 0 0 0 12 0c0-2.5-.8-4-2.5-6C14 7 12 6 12 3Z" />
    <path d="M9.5 13c0 2 1.2 3.5 2.5 3.5s2.5-1.5 2.5-3.5" />
  </svg>
);
// Brush presets removed; no brush imports needed

export interface Frame {
  id: string; // unique id (could be key or generated)
  imageData: string; // public URL or data URL
  timestamp: number; // ms epoch
  artist: string; // placeholder if unknown
  paletteWeek: number;
  key?: string; // storage key (frames/...)
}

function App() {
  // Reddit-only build: always use relative /api/* endpoints served by Devvit proxy/server
  const prefixIfLocal = (url: string) => url;
  // Iframe embedding detection
  const [isEmbedded, setIsEmbedded] = useState<boolean>(() => {
    try { return typeof window !== 'undefined' && window.self !== window.top; } catch { return false; }
  });
  const [embedContext, setEmbedContext] = useState<string>('');

  useEffect(() => {
    try {
      const embedded = window.self !== window.top;
      setIsEmbedded(embedded);
      if (embedded) {
        try {
          const parentUrl = document.referrer || '';
          if (parentUrl.includes('reddit.com')) setEmbedContext('reddit'); else setEmbedContext('iframe');
        } catch { setEmbedContext('iframe'); }
      } else {
        setEmbedContext('');
      }
    } catch {}
  }, []);

  const [activeColor, setActiveColor] = useState('#FF6B6B');
  const [brushSize, setBrushSize] = useState(10);
  // Global spacing (distance between dabs / particles) override; seeded from preset on selection
  const [brushSpacing, setBrushSpacing] = useState<number>(4);
  // Global opacity override (painting transparency) seeded from preset.opacity (1 = fully opaque)
  const [brushOpacity, setBrushOpacity] = useState<number>(1);
  const [brushPresetId, setBrushPresetId] = useState<string>('ink'); // actualizado ID simple
  const [isDrawing, setIsDrawing] = useState(false);
  const [frames, setFrames] = useState<Frame[]>([]);
  // Local cache of hydrated image data by key to avoid refetching
  const hydratedCacheRef = useRef<Record<string, string>>({});
  // Frame temporal (solo cache local durante la sesión)
  const [pendingFrameDataUrl, setPendingFrameDataUrl] = useState<string | null>(null);
  // Shared pending frame (from server)
  const [sharedPending, setSharedPending] = useState<{ imageData: string; timestamp: number; etag?: string } | null>(null);
  // Estado para último error de subida
  // Removed upload error/debug state (no external uploads)
  const [currentView, setCurrentView] = useState<'draw' | 'gallery' | 'video' | 'voting' | 'chat'>('draw');
  const [timeLeft, setTimeLeft] = useState<number>(0); // seconds until current 2h window end
  const [sessionStartTs, setSessionStartTs] = useState<number | null>(null); // when current artist window started
  const [currentWeek,setCurrentWeek] = useState<number>(1);
  const [paletteSide, setPaletteSide] = useState<'left' | 'right'>('right');
  // Brush system disabled (presets & styles removed)
  const [panelsOrder, setPanelsOrder] = useState<PanelKey[]>(['actions','tools','brushSize','brushMode','palette']);
  const [tool, setTool] = useState<'draw' | 'erase' | 'fill'>('draw');
  const [zoom, setZoom] = useState(1);
  const [onionOpacity, setOnionOpacity] = useState(0.35);
  // Dynamic weekly tools from backend
  const [allowedBrushIds, setAllowedBrushIds] = useState<string[] | undefined>(undefined);
  const [paletteColors, setPaletteColors] = useState<string[] | undefined>(undefined);
  // Helper: map server list item to Frame (meta-first). Image data may be omitted; hydration will fill as needed.
  const mapServerItemToFrame = useCallback((o:any): Frame => {
    const wk = typeof o.week === 'number' ? o.week : (typeof o.key === 'string' && /week-(\d+)\//.test(o.key) ? parseInt(o.key.match(/week-(\d+)\//)![1],10) : currentWeek);
    const key = o.key || o.id || '';
    const cached = key ? hydratedCacheRef.current[key] : undefined;
    return {
      id: key || Math.random().toString(36).slice(2),
      key,
      // Prefer cached hydration, then server-provided stable src, then legacy url
      imageData: cached || o.src || o.url || '',
      timestamp: o.lastModified || o.timestamp || Date.now(),
      artist: o.artist || 'anonymous',
      paletteWeek: wk
    };
  }, [currentWeek]);

  // Fetch all frames metadata with pagination to avoid server size guard truncation
  const fetchAllFramesMeta = useCallback(async (): Promise<Frame[]> => {
    const pageSize = 200;
    const first = await fetch(`/api/list-frames?meta=1&page=1&pageSize=${pageSize}`);
    if (!first.ok) return [];
    const j = await first.json();
    const all: any[] = Array.isArray(j.frames) ? j.frames.slice() : [];
    const totalPages: number = j.totalPages || 1;
    if (totalPages > 1) {
      // Fetch the rest pages sequentially to avoid server overload
      for (let p = 2; p <= totalPages; p++) {
        try {
          const r = await fetch(`/api/list-frames?meta=1&page=${p}&pageSize=${pageSize}`);
          if (!r.ok) continue;
          const jj = await r.json();
          if (Array.isArray(jj.frames)) all.push(...jj.frames);
        } catch {}
      }
    }
    // Map to client frames, dedupe by key and sort by timestamp asc
    const byKey = new Map<string, Frame>();
    for (const o of all) {
      const f = mapServerItemToFrame(o);
      if (!f.key) continue;
      const prev = byKey.get(f.key);
      if (!prev || f.timestamp > prev.timestamp) byKey.set(f.key, f);
    }
    return Array.from(byKey.values()).sort((a,b)=>a.timestamp - b.timestamp);
  }, [mapServerItemToFrame]);

  // Auto-hydrate latest frame image so onion-skin and spectators show the newest image even if meta omitted url
  const hydrateLatestFrameIfNeeded = useCallback(async (list: Frame[]) => {
    if (!list.length) return list;
    const last = list[list.length - 1];
    if (!last.key) return list;
    // If any usable image src is present (data URL or stable /api/frame path), don't fetch again
    if (last.imageData) return list;
    // If we have cached hydration, apply it
    const cached = hydratedCacheRef.current[last.key];
    if (cached) {
      const updated = list.slice();
      updated[updated.length - 1] = { ...last, imageData: cached };
      return updated;
    }
    try {
      const r = await fetch(`/api/frame/${encodeURIComponent(last.key)}`);
      if (!r.ok) return list;
      const blob = await r.blob();
      const dataUrl: string = await new Promise((resolve) => { const fr = new FileReader(); fr.onload = ()=> resolve(fr.result as string); fr.readAsDataURL(blob); });
      hydratedCacheRef.current[last.key] = dataUrl;
      const updated = list.slice();
      updated[updated.length - 1] = { ...last, imageData: dataUrl };
      return updated;
    } catch { return list; }
  }, []);

  // Poll finalized frames periodically to keep spectators in sync using meta listing
  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const list = await fetchAllFramesMeta();
        const withHydration = await hydrateLatestFrameIfNeeded(list);
        setFrames(withHydration);
      } catch {}
    }, 20000);
    return () => window.clearInterval(interval);
  }, [fetchAllFramesMeta, hydrateLatestFrameIfNeeded]);
  const canvasCardRef = useRef<HTMLDivElement | null>(null);
  // Turn-based state
  const [currentUser, setCurrentUser] = useState<string>('anonymous');
  const [turnInfo, setTurnInfo] = useState<any>(null);
  // Track if this user explicitly started the current turn (prevents auto re-claim after finalize)
  const startedByMeRef = useRef<boolean>(false);
  // Add a short cooldown timestamp to suppress auto-resume right after finalize
  const lastFinalizeAtRef = useRef<number>(0);
  // lobbyActionLoading removed (buttons moved into side panel)
  // Artist readiness removed; first click claims turn
  // debugMode removed (fast forward no longer used)

  // fastForward removed
  
  // Default fallback palettes if backend isn't available yet
  const weeklyPalettes = [
    ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'],
    ['#E17055', '#FDCB6E', '#6C5CE7', '#A29BFE', '#FD79A8', '#E84393'],
    ['#00CEC9', '#55A3FF', '#FDCB6E', '#E17055', '#A29BFE', '#FD79A8']
  ];
  const currentPalette = paletteColors && paletteColors.length ? paletteColors : weeklyPalettes[currentWeek % weeklyPalettes.length];
  // No currentPreset while brushes are disabled

  const canvasRef = useRef<HTMLCanvasElement>(null);
  let currentBrushPreset: BrushPreset | undefined = allBrushPresets.find(p=>p.id===brushPresetId);
  if (!currentBrushPreset) {
    currentBrushPreset = allBrushPresets.find(p=>p.id==='ink') || allBrushPresets[0];
  }
  const [undoStack, setUndoStack] = useState<ImageData[]>([]);
  const [draftImage, setDraftImage] = useState<string | null>(null);

  // Draft persistence (localStorage + future server/Redis hook)
  const DRAFT_KEY = '12fps:current-draft';
  useEffect(() => {
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (stored) setDraftImage(stored);
    } catch {}
  }, []);

  // User identity derive from ?user= or localStorage
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const qUser = params.get('user');
      const stored = localStorage.getItem('12fps:user');
      const finalUser = qUser || stored || ('user'+Math.random().toString(36).slice(2,8));
      setCurrentUser(finalUser);
      localStorage.setItem('12fps:user', finalUser);
    } catch {}
  }, []);

  // Override with Reddit username when embedded in Reddit via Devvit endpoint
  useEffect(() => {
    if (!isEmbedded || embedContext !== 'reddit') return;
    let aborted = false;
    (async () => {
      try {
  const r = await fetch('/api/whoami'); // stays relative inside reddit embed
        if (!r.ok) return;
        const j = await r.json();
        if (!aborted && j && j.username) {
          setCurrentUser(j.username);
          try { localStorage.setItem('12fps:user', j.username); } catch {}
        }
      } catch {}
    })();
    return () => { aborted = true; };
  }, [isEmbedded, embedContext]);

  // Poll turn info every 15s
  useEffect(() => {
    let id: number | null = null;
    const fetchTurn = async () => {
      try {
  const r = await fetch(prefixIfLocal('/api/turn'), { headers: { 'X-User': currentUser } as any });
        if(!r.ok) return;
        const j = await r.json();
        setTurnInfo(j);
      } catch {}
    };
    fetchTurn();
    id = window.setInterval(fetchTurn, 15000);
    return () => { if(id) window.clearInterval(id); };
  }, [currentUser]);

  // Track artist window start timestamp
  useEffect(() => {
    if (!turnInfo) return;
    if (turnInfo.currentArtist) {
      setSessionStartTs(turnInfo.windowStart);
    }
  }, [turnInfo?.currentArtist, turnInfo?.windowStart]);

  // Auto-resume: if server says our user is the current artist but we haven't marked started, re-claim silently
  useEffect(() => {
    if (!turnInfo || !currentUser) return;
    const sinceFinalize = Date.now() - lastFinalizeAtRef.current;
    const inCooldown = sinceFinalize >= 0 && sinceFinalize < 3000; // 3s cooldown after finalize
    if (!inCooldown && startedByMeRef.current && turnInfo.currentArtist === currentUser && timeLeft > 0) {
      // Best-effort reassert claim so server can treat us as active (idempotent)
      (async () => {
        try {
          await fetch('/api/turn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ action: 'resume', user: currentUser }) });
        } catch {}
      })();
    }
  }, [turnInfo?.currentArtist, currentUser, timeLeft]);

  // Track artist window start timestamp
  useEffect(() => {
    if (!turnInfo) return;
    if (turnInfo.currentArtist) {
      setSessionStartTs(turnInfo.windowStart);
    }
  }, [turnInfo?.currentArtist, turnInfo?.windowStart]);

  // Auto-resume: if server says our user is the current artist but we haven't marked started, re-claim silently
  useEffect(() => {
    if (!turnInfo || !currentUser) return;
    const sinceFinalize = Date.now() - lastFinalizeAtRef.current;
    const inCooldown = sinceFinalize >= 0 && sinceFinalize < 3000; // 3s cooldown after finalize
    if (!inCooldown && startedByMeRef.current && turnInfo.currentArtist === currentUser && timeLeft > 0) {
      // Best-effort reassert claim so server can treat us as active (idempotent)
      (async () => {
        try {
          await fetch('/api/turn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ action: 'resume', user: currentUser }) });
        } catch {}
      })();
    }
  }, [turnInfo?.currentArtist, currentUser, timeLeft]);

  const persistDraft = useCallback(() => {
    if (!canvasRef.current) return;
    try {
      const dataUrl = canvasRef.current.toDataURL('image/png');
      localStorage.setItem(DRAFT_KEY, dataUrl);
      setDraftImage(dataUrl);
      // TODO: Optional: throttle + POST to a Devvit server endpoint to store in Redis for cross-device continuity.
    } catch {}
  }, []);

  // Countdown robust: use server windowEnd/timeToEndSeconds; correct drift periodically
  const countdownRef = useRef<{ targetMs: number; lastServerSync: number; lastDisplayed: number }>({ targetMs: 0, lastServerSync: 0, lastDisplayed: 0 });
  // Arm finalize only after a valid countdown has been established for me-as-artist
  const countdownArmedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!turnInfo) return;
    const now = Date.now();
    const isActive = Boolean(turnInfo.currentArtist) && Boolean(turnInfo.started) && (typeof turnInfo.windowEnd === 'number' && turnInfo.windowEnd > 0);
    if (!isActive) {
      // Idle: ensure timer stays at zero and target cleared
      countdownRef.current.targetMs = 0;
      countdownRef.current.lastServerSync = now;
      setTimeLeft(0);
      countdownArmedRef.current = false; // disarm when idle or not active
      return;
    }
    let target = 0;
    if (typeof turnInfo.windowEnd === 'number' && turnInfo.windowEnd > 0) {
      target = turnInfo.windowEnd;
    } else if (typeof turnInfo.timeToEndSeconds === 'number') {
      target = now + turnInfo.timeToEndSeconds * 1000;
    }
    if (target > 0) {
      countdownRef.current.targetMs = target;
      countdownRef.current.lastServerSync = now;
      // Only arm if I am the current artist
      countdownArmedRef.current = (turnInfo.currentArtist === currentUser);
    }
  }, [turnInfo?.windowEnd, turnInfo?.timeToEndSeconds, turnInfo?.currentArtist, turnInfo?.started, currentUser]);

  useEffect(() => {
    const tick = () => {
      const { targetMs } = countdownRef.current;
      if (!targetMs) {
        setTimeLeft(0);
        return;
      }
      const now = Date.now();
      let sec = Math.floor((targetMs - now) / 1000);
      if (sec < 0) sec = 0;
      // Drift correction: if local differs from server implied (turnInfo.timeToEndSeconds) by >5s right after sync window, rely on new sync
      setTimeLeft(sec);
      countdownRef.current.lastDisplayed = now;
    };
    const id = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(id);
  }, []);

  // Fetch dynamic weekly tools (palette, brushes) from backend and react to changes via toolsVersion
  useEffect(() => {
    let aborted = false;
    let interval: number | null = null;
    const applyConfig = (cfg: any) => {
      // Guard: ensure object
      if (!cfg || typeof cfg !== 'object') return;
      if (typeof cfg.currentWeek === 'number') setCurrentWeek(cfg.currentWeek);
  // toolsVersion display removed from debug bar; ignore cfg.toolsVersion
      // Prefer canonical tools object if present
      const colors: string[] | undefined = cfg?.tools?.palette?.colors || cfg.paletteColors;
  const rawBrushes = (cfg?.tools?.brushKit?.brushes || cfg.brushes) as any;

      if (Array.isArray(colors) && colors.length) {
        setPaletteColors(prev => {
          const changed = !prev || prev.length !== colors.length || prev.some((c, i) => c !== colors[i]);
          // If activeColor not in new palette, switch to the first
          if (changed) {
            if (!colors.includes(activeColor)) {
              setActiveColor(colors[0]);
            }
          }
          return colors;
        });
      }

      if (Array.isArray(rawBrushes) && rawBrushes.length) {
        const knownIds = new Set(allBrushPresets.map(p => p.id));
        // rawBrushes may be array of {id,name} or plain ids
        const normalized = rawBrushes.map((b:any) => {
          if (b && typeof b === 'object' && b.id) return String(b.id).toLowerCase();
          return String(b).toLowerCase();
        }).filter((id:string) => knownIds.has(id));
        if (normalized.length) {
          setAllowedBrushIds(prev => {
            const changed = !prev || prev.length !== normalized.length || prev.some((id, i) => id !== normalized[i]);
            if (changed) {
              if (!normalized.includes(brushPresetId)) {
                setBrushPresetId(normalized[0]);
                const preset = allBrushPresets.find(p => p.id === normalized[0]);
                if (preset) setBrushSize(preset.size);
              }
            }
            return normalized;
          });
        }
      }
    };
    const fetchConfig = async () => {
      try {
        const r = await fetch('/api/draw-config');
        if (!r.ok) return;
        const j = await r.json();
        if (!aborted) applyConfig(j);
      } catch {}
    };
    fetchConfig();
    // Poll periodically to catch week rollover and tools changes
    interval = window.setInterval(fetchConfig, 30000);
    return () => { aborted = true; if (interval) window.clearInterval(interval); };
  }, [brushPresetId, activeColor]);

  // Sube un dataURL al backend (con soporte interno Reddit /r2/upload-frame)
  // Removed legacy uploadDataUrlPNG (external uploads disabled).

  // Guardar dentro de la sesión: solo cache local, no subir
  const saveFrame = useCallback(() => {
    // Only artist can save
  if (!canvasRef.current || !(turnInfo && turnInfo.currentArtist === currentUser)) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    setPendingFrameDataUrl(dataUrl);
  // Clearing draft after an intentional save (we treat this as commit-in-progress but keep local draft in case finalize fails)
  persistDraft();
    // Fire-and-forget upload to shared pending endpoint
    (async () => {
      try {
  await fetch(prefixIfLocal('/api/pending-frame'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ dataUrl, user: currentUser }) });
      } catch {}
    })();
  }, [turnInfo, currentUser, persistDraft]);

  // Al finalizar la sesión se sube la última imagen cacheada
  // finalizingRef removed with legacy finalize code.
  // Removed legacy finalizeSessionUpload (external upload disabled). ForceEndSession now handles finalize.

  const forceEndSession = useCallback(() => {
    if (!(turnInfo && turnInfo.currentArtist === currentUser)) return;
    (async () => {
      try {
        // Immediately mark as ended and start cooldown to avoid any auto-resume race
        startedByMeRef.current = false;
        lastFinalizeAtRef.current = Date.now();
         // Capture current canvas into pending-frame first
         if (canvasRef.current) {
           try {
             const dataUrl = canvasRef.current.toDataURL('image/png');
             await fetch('/api/pending-frame', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ dataUrl, user: currentUser }) });
           } catch {}
         }
         await fetch('/api/finalize-turn', { method: 'POST' });
         const r = await fetch('/api/turn', { headers: { 'X-User': currentUser } as any });
         if (r.ok) setTurnInfo(await r.json());
         // Clear local pending caches
         setPendingFrameDataUrl(null);
         setSharedPending(null);
         // Clear draft (local) after finalize so next artist starts clean
         try { localStorage.removeItem(DRAFT_KEY); } catch {}
         setDraftImage(null);
         // Proactively clear canvas for local view
         if (canvasRef.current) {
           const ctx = canvasRef.current.getContext('2d');
           if (ctx) {
             ctx.save();
             ctx.setTransform(1,0,0,1,0,0);
             ctx.clearRect(0,0,canvasRef.current.width, canvasRef.current.height);
             ctx.fillStyle = '#ffffff';
             ctx.fillRect(0,0,canvasRef.current.width, canvasRef.current.height);
             ctx.restore();
           }
         }
         // Reload frames list (meta) to include newly finalized frame
         const updatedList = await fetchAllFramesMeta();
         const withHydration = await hydrateLatestFrameIfNeeded(updatedList);
         setFrames(withHydration);
      } catch {}
    })();
  }, [turnInfo, currentUser, currentWeek]);

  // Poll shared pending frame every 10s when drawing or viewing gallery
  useEffect(() => {
    let interval: number | null = null;
    const active = currentView === 'draw' || currentView === 'gallery';
    if (active) {
      const fetchPending = async () => {
        try {
          const r = await fetch(prefixIfLocal('/api/pending-frame'), { headers: { 'X-User': currentUser } as any });
          if (!r.ok) return;
          const j = await r.json();
          if (j && j.pending && j.pending.url) {
            const rawUrl: string = j.pending.url;
            const isData = rawUrl.startsWith('data:image/png');
            const effectiveUrl = isData ? rawUrl : (rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'v=' + (j.pending.etag || j.pending.lastModified || Date.now()));
            setSharedPending(prev => {
              if (prev && prev.imageData === effectiveUrl) return prev; // unchanged
              return { imageData: effectiveUrl, timestamp: j.pending.lastModified || Date.now(), etag: j.pending.etag };
            });
          } else {
            setSharedPending(null);
          }
        } catch {}
      };
      fetchPending();
      interval = window.setInterval(fetchPending, 10000);
    }
    return () => { if (interval) window.clearInterval(interval); };
  }, [currentView, currentUser]);

  // Auto finalize when window ends and we were the artist
  const prevArtistRef = useRef<string | null>(null);
  useEffect(() => {
    if (!turnInfo) return;
    // Only react when artist actually changes (avoid flicker each poll)
    if (prevArtistRef.current !== turnInfo.currentArtist) {
      const previous = prevArtistRef.current;
      prevArtistRef.current = turnInfo.currentArtist;
      if (previous === currentUser && turnInfo.currentArtist !== currentUser) {
        // We lost artist role: clear draft & canvas once
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        setDraftImage(null);
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext('2d');
          if (ctx) {
            ctx.save();
            ctx.setTransform(1,0,0,1,0,0);
            ctx.clearRect(0,0,canvasRef.current.width, canvasRef.current.height);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0,0,canvasRef.current.width, canvasRef.current.height);
            ctx.restore();
          }
        }
      }
    }
  }, [turnInfo?.currentArtist, currentUser]);

  useEffect(() => {
    // Guard: only auto-finalize if countdown truly ended and was armed for me
    if (!turnInfo || turnInfo.currentArtist !== currentUser) return;
    const target = countdownRef.current.targetMs;
    if (!target || !countdownArmedRef.current) return;
    const now = Date.now();
    const ended = now >= target - 250; // small drift tolerance
    if (ended && timeLeft === 0) {
      countdownArmedRef.current = false; // one-shot
      forceEndSession();
    }
  }, [timeLeft, turnInfo?.currentArtist, currentUser, forceEndSession]);

  // Cargar frames existentes desde el backend (Redis listing, meta + hydration)
  useEffect(() => {
    (async () => {
      try {
        const list = await fetchAllFramesMeta();
        const withHydration = await hydrateLatestFrameIfNeeded(list);
        setFrames(withHydration);
      } catch (e) {
        // silent
      }
    })();
  }, [currentWeek, fetchAllFramesMeta, hydrateLatestFrameIfNeeded]);

  const clearCanvas = () => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (ctx) {
  // Reset transform to clear in device pixels, then restore
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  // Repaint solid white background so repeated cleans keep a white canvas
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  ctx.restore();
    }
  };

  const snapshotCanvas = () => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const img = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
    setUndoStack(prev => {
      const next = prev.slice(-24); // cap to last 25 snapshots
      next.push(img);
      return next;
    });
  };

  const undo = () => {
    if (!canvasRef.current || undoStack.length === 0) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    ctx.putImageData(prev, 0, 0);
  };

  const themes = ['Anime Inking', 'Retro Comic', 'Soft Watercolor'];
  let storedBundleTheme: string | null = null;
  try {
    const wbRaw = localStorage.getItem('weekBundle_'+currentWeek);
    if (wbRaw) { const wb = JSON.parse(wbRaw); if (wb && typeof wb.theme === 'string') storedBundleTheme = wb.theme; }
  } catch {}
  const currentTheme = storedBundleTheme || themes[currentWeek % themes.length];
  const formatCountdown = (sec:number)=>{
    const h = Math.floor(sec/3600).toString().padStart(2,'0');
    const m = Math.floor((sec%3600)/60).toString().padStart(2,'0');
    const s = (sec%60).toString().padStart(2,'0');
    return `${h}:${m}:${s}`;
  };

  return (
  <div className={`min-h-screen pencil-theme ${isEmbedded ? 'embedded-mode' : ''}`}>
      {/* Deployment badge para verificar nuevo build en Reddit */}
      <div className="pointer-events-none select-none fixed top-1 right-2 z-[999] text-[10px] font-mono sketch-border px-2 py-1 rounded tracking-tight bg-[#FAF3E0] text-black shadow-[3px_3px_0_0_#000] flex items-center gap-2">
        <span className="font-semibold">Week {currentWeek}</span>
        <span className="opacity-70">{currentTheme}</span>
        <span className="opacity-50">|</span>
        <span className="flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 opacity-80"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span className="tabular-nums">{formatCountdown(timeLeft)}</span>
        </span>
        <span className="opacity-50">|</span>
        <span className="max-w-[130px] truncate font-semibold">{turnInfo?.currentArtist ? `u/${turnInfo.currentArtist}` : 'No artist'}</span>
      </div>
      {/* Minimal spacer (5px) below fixed debug bar */}
      <div style={{height:'5px'}} aria-hidden="true" />
      {/* Embedding indicator for Reddit */}
  {/* Reddit banner removed */}
      
  <Header currentView={currentView} setCurrentView={setCurrentView} />
  <div className="max-w-6xl mx-auto px-3 pb-4">
        {/* Turn / Lobby banner */}
  {/* Removed top status banner (User / Artist / Ends in) */}
        {currentView === 'draw' && (
          <div className={`w-full flex justify-center gap-6 ${paletteSide === 'left' ? 'flex-row' : 'flex-row-reverse'}`}>
            <SidePanels
              side={paletteSide}
              toggleSide={() => setPaletteSide(p => p === 'right' ? 'left' : 'right')}
              order={panelsOrder}
              setOrder={setPanelsOrder}
              tool={tool}
              setTool={setTool}
              brushSize={brushSize}
              setBrushSize={setBrushSize}
              brushSpacing={brushSpacing}
              setBrushSpacing={setBrushSpacing}
              brushOpacity={brushOpacity}
              setBrushOpacity={setBrushOpacity}
                brushPresetId={brushPresetId}
                setBrushPresetId={setBrushPresetId}
              colors={currentPalette}
              activeColor={activeColor}
              setActiveColor={setActiveColor}
              currentWeek={currentWeek}
              onSave={saveFrame}
              onClear={clearCanvas}
              onUndo={undo}
              disabled={!(turnInfo && turnInfo.currentArtist === currentUser) || timeLeft === 0}
              timeLeft={timeLeft}
              // After a successful start, mark explicit ownership to enable re-claim resilience if needed
              onStartTurn={async () => { try { await fetch('/api/turn',{ method:'POST', headers:{'Content-Type':'application/json','X-User': currentUser } as any, body: JSON.stringify({ action:'start', user: currentUser }) }); const r= await fetch('/api/turn', { headers: { 'X-User': currentUser } as any }); if(r.ok) { setTurnInfo(await r.json()); startedByMeRef.current = true; } } catch {} }}
              onFinalizeTurn={forceEndSession}
              canStart={Boolean(turnInfo && !turnInfo.currentArtist)}
              isArtist={Boolean(turnInfo && turnInfo.currentArtist === currentUser)}
              currentArtist={turnInfo?.currentArtist || null}
              allowedBrushIds={allowedBrushIds}
            />
            <div ref={canvasCardRef}>
              <div className="flex items-start gap-4">
                {paletteSide === 'right' && (
                  <div className="flex flex-col gap-2 pt-2">
                    <div className="sketch-border panel-hatch rounded-2xl p-3 flex flex-col items-center gap-3 select-none">
                      <div className="flex flex-col items-center gap-1">
                        <ZoomIn className="w-4 h-4 text-white/70" />
                        <input
                          type="range"
                          min={100}
                          max={400}
                          value={zoom*100}
                          onChange={(e) => setZoom(parseInt(e.target.value,10)/100)}
                          aria-label="Zoom level"
                          className="h-36 accent-white/80 cursor-pointer rotate-180"
                          style={{ writingMode: 'vertical-rl' as any }}
                        />
                        <ZoomOut className="w-4 h-4 text-white/70" />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <OnionIcon className="w-4 h-4 text-white/70" />
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(onionOpacity*100)}
                          onChange={(e) => (turnInfo && turnInfo.currentArtist === currentUser) ? setOnionOpacity(parseInt(e.target.value,10)/100) : undefined}
                          disabled={!(turnInfo && turnInfo.currentArtist === currentUser) || !frames.length}
                          aria-label="Onion opacity"
                          className="h-28 accent-white/70 cursor-pointer rotate-180"
                          style={{ writingMode: 'vertical-rl' as any }}
                        />
                      </div>
                    </div>
                  </div>
                )}
                <div className="inline-block">
                    <Canvas
                      key={`canvas-${turnInfo?.currentArtist || 'none'}-${frames.length ? frames[frames.length-1].key : 'empty'}`}
                      ref={canvasRef}
                      activeColor={activeColor}
                      brushSize={brushSize}
                      brushSpacing={brushSpacing}
                      brushOpacity={brushOpacity}
                      isDrawing={isDrawing}
                      setIsDrawing={setIsDrawing}
                      disabled={!(turnInfo && turnInfo.currentArtist === currentUser) || timeLeft === 0}
                      brushPreset={currentBrushPreset}
                      tool={tool}
                      onBeforeMutate={snapshotCanvas}
                      zoom={zoom}
                      // Only show onion (previous frame) to the active artist as a faint guide
                      onionImage={(turnInfo && turnInfo.currentArtist === currentUser && frames.length) ? frames[frames.length-1].imageData : undefined}
                      onionOpacity={onionOpacity}
                      onDirty={persistDraft}
                      // Spectators see the last finalized frame fully; artist sees their draft (if any)
                      restoreImage={(turnInfo && turnInfo.currentArtist === currentUser) ? draftImage : (frames.length ? frames[frames.length-1].imageData : null)}
                    />
                </div>
                {paletteSide === 'left' && (
                  <div className="flex flex-col gap-2 pt-2">
                    <div className="sketch-border panel-hatch rounded-2xl p-3 flex flex-col items-center gap-3 select-none">
                      <div className="flex flex-col items-center gap-1">
                        <ZoomIn className="w-4 h-4 text-white/70" />
                        <input
                          type="range"
                          min={100}
                          max={400}
                          value={zoom*100}
                          onChange={(e) => setZoom(parseInt(e.target.value,10)/100)}
                          aria-label="Zoom level"
                          className="h-36 accent-white/80 cursor-pointer rotate-180"
                          style={{ writingMode: 'vertical-rl' as any }}
                        />
                        <ZoomOut className="w-4 h-4 text-white/70" />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <OnionIcon className="w-4 h-4 text-white/70" />
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(onionOpacity*100)}
                          onChange={(e) => (turnInfo && turnInfo.currentArtist === currentUser) ? setOnionOpacity(parseInt(e.target.value,10)/100) : undefined}
                          disabled={!(turnInfo && turnInfo.currentArtist === currentUser) || !frames.length}
                          aria-label="Onion opacity"
                          className="h-28 accent-white/70 cursor-pointer rotate-180"
                          style={{ writingMode: 'vertical-rl' as any }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {currentView === 'gallery' && (
          <FrameGallery
            frames={frames}
            pendingFrame={(pendingFrameDataUrl || sharedPending) ? { imageData: pendingFrameDataUrl || sharedPending!.imageData, startedAt: sessionStartTs || sharedPending?.timestamp || Date.now() } : null}
          />
        )}
  {/* Upload debug panels removed */}

        {currentView === 'video' && (
          <VideoPlayer frames={frames} />
        )}

        {currentView === 'voting' && (
          <PaletteVoting />
        )}

        {currentView === 'chat' && (
          <Chat currentWeek={currentWeek} currentUser={currentUser} />
        )}
      </div>
    </div>
  );
}

export default App;