import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Canvas } from './components/Canvas';
import { SpectatorCanvas, type SpectatorHandle } from './components/SpectatorCanvas';
import { useSpectate } from './hooks/useSpectate';
import { allBrushPresets, BrushPreset } from './brushes';
// import { ColorPalette } from './components/ColorPalette';
import { SidePanels, PanelKey } from './components/SidePanels';
import { Header } from './components/Header';
import { FrameGallery } from './components/FrameGallery';
import { VideoPlayer } from './components/VideoPlayer';
import { PaletteVoting } from './components/PaletteVoting';
import { Chat } from './components/Chat'; // <-- Import Chat component
// Header removed: navigation moved into SidePanels
import { ZoomIn, ZoomOut, PencilRuler, X, Palette, Play, Image as ImgIcon, Vote, MessageCircle, MessageCircleOff } from 'lucide-react';

// Inline chat column geometry, kept in sync with chatInlineNode's min/max classes. The column
// grows into whatever the draw row has left over, so a ~1024px iPad in desktop mode still gets a
// chat; under CHAT_MIN_WIDTH there is no room for one. COLUMN_GAP mirrors the row's md:gap-4.
const CHAT_MIN_WIDTH = 210;
const COLUMN_GAP = 16;

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
  // Inline chat sits opposite the tools rail by default.
  const [chatSide, setChatSide] = useState<'left' | 'right'>('left');
  // Brush system disabled (presets & styles removed)
  const [panelsOrder, setPanelsOrder] = useState<PanelKey[]>(['actions','tools','brushSize','brushMode','palette']);
  const [tool, setTool] = useState<'draw' | 'erase' | 'fill'>('draw');
  const [zoom, setZoom] = useState(1);
  const [onionOpacity, setOnionOpacity] = useState(0.35);
  // Mobile responsive layout + right-side tools drawer
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    try { return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 767px)').matches; } catch { return false; }
  });
  const [toolsDrawerOpen, setToolsDrawerOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setIsMobile(mq.matches);
    on();
    try { mq.addEventListener('change', on); } catch { (mq as any).addListener(on); }
    return () => { try { mq.removeEventListener('change', on); } catch { (mq as any).removeListener(on); } };
  }, []);
  // Inline chat auto-shows only when the draw row has real room left over for it. Measured
  // rather than keyed off a breakpoint: the Reddit frame, fullscreen and iPad desktop mode all
  // report widths that a fixed min-width guesses wrong. `chatOverride` lets the user win.
  const drawRowRef = useRef<HTMLDivElement | null>(null);
  const [chatFits, setChatFits] = useState<boolean>(false);
  const [chatOverride, setChatOverride] = useState<boolean | null>(null);
  // Fit the desktop side-panels rail to the viewport, then let the canvas match it.
  // The canvas caps its own height to the viewport (see Canvas.tsx), but the rail's height is
  // content-driven, so a rail taller than the screen would hang past the canvas and clip the
  // palette — which is what browser zoom and short iPad viewports used to do. Scale it down to
  // fit instead; `panelsHeight` is then the on-screen height both canvas and chat line up with.
  const sidePanelsRef = useRef<HTMLDivElement>(null);
  const sidePanelsInnerRef = useRef<HTMLDivElement>(null);
  const [panelsHeight, setPanelsHeight] = useState<number | undefined>(undefined);
  const [panelsScale, setPanelsScale] = useState<number>(1);
  const [panelsWidth, setPanelsWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (isMobile) { setPanelsHeight(undefined); setPanelsScale(1); setPanelsWidth(undefined); return; }
    const wrap = sidePanelsRef.current;
    const inner = sidePanelsInnerRef.current;
    if (!wrap || !inner || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      // offsetHeight is the layout size, so it ignores the scale we apply below and can't feed back.
      const naturalH = inner.offsetHeight;
      const naturalW = inner.offsetWidth;
      if (!naturalH) return;
      const top = wrap.getBoundingClientRect().top;
      const availH = Math.max(160, window.innerHeight - top - 12); // mirrors Canvas.tsx
      const s = Math.min(1, availH / naturalH);
      setPanelsScale(s);
      setPanelsHeight(naturalH * s);
      setPanelsWidth(naturalW * s);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(inner);
    // The rail's own size doesn't change when the window gets shorter, so the observer alone
    // would never see a viewport-only resize.
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [isMobile]);
  // Dynamic weekly tools from backend
  const [allowedBrushIds, setAllowedBrushIds] = useState<string[] | undefined>(undefined);
  const [paletteColors, setPaletteColors] = useState<string[] | undefined>(undefined);
  const [serverTheme, setServerTheme] = useState<string | null>(null);
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
  // How much room does the draw row have left beside canvas + tools? Remeasured on any of the
  // three resizing. None of the measured widths depend on the chat being mounted, so showing it
  // can't feed back and flip this.
  useEffect(() => {
    if (isMobile || currentView !== 'draw') { setChatFits(false); return; }
    const row = drawRowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rowW = row.getBoundingClientRect().width;
      const canvasW = canvasCardRef.current?.getBoundingClientRect().width ?? 0;
      const toolsW = sidePanelsRef.current?.getBoundingClientRect().width ?? 0;
      setChatFits(rowW - canvasW - toolsW - COLUMN_GAP >= CHAT_MIN_WIDTH);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(row);
    if (canvasCardRef.current) ro.observe(canvasCardRef.current);
    if (sidePanelsRef.current) ro.observe(sidePanelsRef.current);
    return () => ro.disconnect();
    // panelsHeight drives the canvas size, so remeasure when it lands rather than waiting on
    // the observer — the first pass runs before the canvas has settled.
  }, [isMobile, currentView, panelsHeight]);
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

  // Draft persistence (localStorage + shared server pending frame for cross-device resume)
  const DRAFT_KEY = 'kinora:current-draft';
  const DRAFT_META_KEY = 'kinora:current-draft-meta'; // { ts, windowStart, user } to compare freshness across devices
  useEffect(() => {
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (stored) setDraftImage(stored);
    } catch {}
  }, []);
  // Mirror draftImage in a ref so the resume effect can read the current value without
  // re-running every time the draft changes mid-stroke.
  const draftImageRef = useRef<string | null>(null);
  useEffect(() => { draftImageRef.current = draftImage; }, [draftImage]);
  // Bumped once per turn when we resolve the resume image, forcing the Canvas to remount
  // and paint it (the restore is a one-time draw guarded inside Canvas).
  const [resumeNonce, setResumeNonce] = useState(0);
  const resumedTurnRef = useRef<number>(-1);

  // User identity derive from ?user= or localStorage
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const qUser = params.get('user');
      const stored = localStorage.getItem('kinora:user');
      const finalUser = qUser || stored || ('user'+Math.random().toString(36).slice(2,8));
      setCurrentUser(finalUser);
      localStorage.setItem('kinora:user', finalUser);
    } catch {}
  }, []);

  // Always try to resolve Reddit username via Devvit server API
  // (works in both iframe embeds AND native mobile app WebViews)
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
  const r = await fetch('/api/whoami');
        if (!r.ok) return;
        const j = await r.json();
        if (!aborted && j && j.username) {
          setCurrentUser(j.username);
          try { localStorage.setItem('kinora:user', j.username); } catch {}
        }
      } catch {}
    })();
    return () => { aborted = true; };
  }, []);

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
      // Stamp the draft with the current turn + time so we can (a) tell whether a stored
      // local draft belongs to THIS turn and (b) compare its freshness against the shared
      // server copy when resuming on another device.
      try { localStorage.setItem(DRAFT_META_KEY, JSON.stringify({ ts: Date.now(), windowStart: turnInfo?.windowStart || 0, user: currentUser })); } catch {}
      setDraftImage(dataUrl);
    } catch {}
  }, [turnInfo?.windowStart, currentUser]);

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
      // Set server-authoritative theme
      if (cfg.theme && typeof cfg.theme === 'string') setServerTheme(cfg.theme);
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

  // --- Live spectating (Phase 1: throttled snapshot streaming) ---------------------
  // True when the user is logged in but someone ELSE holds the drawing turn.
  const isSpectating = Boolean(turnInfo?.currentArtist && currentUser && turnInfo.currentArtist !== currentUser);
  // While the artist draws, push a fresh snapshot of the canvas to the shared pending
  // endpoint at most every ~2.5s (trailing), so spectators see near-live progress
  // instead of only the last manual Save.
  const lastShareRef = useRef<number>(0);
  const shareTimerRef = useRef<number | null>(null);
  const shareLivePending = useCallback(() => {
    if (!canvasRef.current || !(turnInfo && turnInfo.currentArtist === currentUser)) return;
    const doUpload = () => {
      lastShareRef.current = Date.now();
      try {
        const dataUrl = canvasRef.current!.toDataURL('image/png');
        fetch(prefixIfLocal('/api/pending-frame'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ dataUrl, user: currentUser }) }).catch(() => {});
      } catch {}
    };
    const since = Date.now() - lastShareRef.current;
    if (since >= 2500) { doUpload(); }
    else if (shareTimerRef.current == null) {
      shareTimerRef.current = window.setTimeout(() => { shareTimerRef.current = null; doUpload(); }, 2500 - since);
    }
  }, [turnInfo, currentUser]);
  // Immediate (throttle-bypassing) keyframe push — used after undo/fill so spectators
  // reconcile to the authoritative frame quickly.
  const shareLivePendingNow = useCallback(() => {
    if (!canvasRef.current || !(turnInfo && turnInfo.currentArtist === currentUser)) return;
    if (shareTimerRef.current != null) { clearTimeout(shareTimerRef.current); shareTimerRef.current = null; }
    lastShareRef.current = Date.now();
    try {
      const dataUrl = canvasRef.current.toDataURL('image/png');
      fetch(prefixIfLocal('/api/pending-frame'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ dataUrl, user: currentUser }) }).catch(() => {});
    } catch {}
  }, [turnInfo, currentUser]);
  // Relay a discrete canvas event (clear / fill) to spectators over realtime.
  const postSpectateEvent = useCallback((body: any) => {
    if (!(turnInfo && turnInfo.currentArtist === currentUser)) return;
    fetch(prefixIfLocal('/api/spectate'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ ...body, user: currentUser }) }).catch(() => {});
  }, [turnInfo, currentUser]);

  // Combined onDirty: keep the local draft AND stream a live snapshot to spectators.
  const handleCanvasDirty = useCallback(() => { persistDraft(); shareLivePending(); }, [persistDraft, shareLivePending]);

  // Cross-device turn resume: when we ARE the current artist, pick the freshest in-progress
  // image between the local draft (this device) and the shared server pending frame
  // (whatever device drew last) and restore it, so the turn continues seamlessly across
  // devices / after the app is closed. Runs once per turn (keyed by windowStart).
  useEffect(() => {
    if (!turnInfo || !currentUser) return;
    const ws = turnInfo.windowStart || 0;
    const isArtist = turnInfo.currentArtist === currentUser;
    if (!isArtist || !ws) return;
    if (resumedTurnRef.current === ws) return; // already resolved for this turn
    resumedTurnRef.current = ws;
    let cancelled = false;
    (async () => {
      // Local candidate — only if the stored draft belongs to THIS turn (avoids leaking a
      // previous turn's work into a new frame).
      let local: { url: string; ts: number } | null = null;
      try {
        const metaRaw = localStorage.getItem(DRAFT_META_KEY);
        const draft = localStorage.getItem(DRAFT_KEY);
        if (metaRaw && draft) {
          const meta = JSON.parse(metaRaw);
          if (meta && meta.windowStart === ws && meta.user === currentUser) local = { url: draft, ts: meta.ts || 0 };
        }
      } catch {}
      // Server candidate — the shared pending frame. The server only exposes a pending
      // frame for the current turn's artist, so if present it is safely ours.
      let server: { url: string; ts: number } | null = null;
      try {
        const r = await fetch(prefixIfLocal('/api/pending-frame'), { headers: { 'X-User': currentUser } as any });
        if (r.ok) {
          const j = await r.json();
          const p = j && j.pending;
          if (p && p.url && (!p.artist || p.artist === currentUser)) {
            const raw: string = p.url;
            const url = raw.startsWith('data:') ? raw : raw + (raw.includes('?') ? '&' : '?') + 'v=' + (p.lastModified || Date.now());
            server = { url, ts: p.lastModified || 0 };
          }
        }
      } catch {}
      if (cancelled) return;
      // Prefer whichever is newer; server wins ties (it's the cross-device source of truth).
      const best = (local && server) ? (server.ts >= local.ts ? server : local) : (server || local);
      if (best && best.url !== draftImageRef.current) {
        setDraftImage(best.url);
        setResumeNonce(n => n + 1); // remount Canvas so restoreImage(best) paints once
      } else if (!best && draftImageRef.current) {
        // Fresh turn with no in-progress work anywhere (any local draft belongs to an old,
        // unfinalized turn) — start on a clean frame instead of inheriting stale content.
        setDraftImage(null);
        setResumeNonce(n => n + 1);
      }
    })();
    return () => { cancelled = true; };
  }, [turnInfo?.currentArtist, turnInfo?.windowStart, currentUser]);

  // --- Phase 2: realtime live strokes ---------------------------------------------
  // Artist side: coalesce smoothed segments and POST them ~every 150ms; the server
  // relays each batch to spectators over realtime.
  const strokeBatchRef = useRef<{ b: any; segs: number[][] } | null>(null);
  const strokeTimerRef = useRef<number | null>(null);
  const flushStrokes = useCallback(() => {
    if (strokeTimerRef.current != null) { clearTimeout(strokeTimerRef.current); strokeTimerRef.current = null; }
    const batch = strokeBatchRef.current;
    strokeBatchRef.current = null;
    if (!batch || !batch.segs.length) return;
    fetch(prefixIfLocal('/api/stroke'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': currentUser } as any, body: JSON.stringify({ b: batch.b, segs: batch.segs, user: currentUser }) }).catch(() => {});
  }, [currentUser]);
  const handleArtistSegment = useCallback((seg: any) => {
    const cur = strokeBatchRef.current;
    if (cur && cur.b.sid !== seg.sid) flushStrokes(); // new stroke -> flush the previous one
    if (!strokeBatchRef.current) {
      strokeBatchRef.current = {
        b: seg.erase
          ? { sid: seg.sid, e: 1, sz: seg.size }
          : { sid: seg.sid, e: 0, p: seg.preset, c: seg.color, sz: seg.size, o: seg.opacity, sp: seg.spacing },
        segs: [],
      };
    }
    const r = Math.round;
    strokeBatchRef.current.segs.push(seg.erase
      ? [r(seg.from.x), r(seg.from.y), r(seg.to.x), r(seg.to.y), r(seg.ctrl.x), r(seg.ctrl.y)]
      : [r(seg.from.x), r(seg.from.y), r(seg.to.x), r(seg.to.y), r(seg.ctrl.x), r(seg.ctrl.y), Math.round((seg.dynamic || 0) * 100) / 100, Math.round((seg.velocity || 0) * 1000) / 1000]);
    if (strokeBatchRef.current.segs.length >= 24) { flushStrokes(); return; }
    if (strokeTimerRef.current == null) strokeTimerRef.current = window.setTimeout(flushStrokes, 150);
  }, [flushStrokes]);
  // Artist fill: relay it live (spectators flood-fill approximately) + a keyframe correction.
  const handleArtistFill = useCallback((x: number, y: number, color: string) => {
    postSpectateEvent({ t: 'fill', x: Math.round(x), y: Math.round(y), c: color });
    shareLivePendingNow();
  }, [postSpectateEvent, shareLivePendingNow]);

  // Spectator side: subscribe to the realtime channel and paint live strokes.
  const spectatorRef = useRef<SpectatorHandle | null>(null);
  useSpectate({
    active: isSpectating,
    spectatorRef,
    onTurn: () => {
      // A turn started/ended — refetch authoritative turn state so the LIVE badge and the
      // artist/spectator split update immediately instead of waiting for the 15s poll.
      fetch(prefixIfLocal('/api/turn'), { headers: { 'X-User': currentUser } as any })
        .then(r => (r.ok ? r.json() : null)).then(j => { if (j) setTurnInfo(j); }).catch(() => {});
    },
  });

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
         try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(DRAFT_META_KEY); } catch {}
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
      // Poll fast while spectating a live turn so the canvas feels live; slow otherwise.
      interval = window.setInterval(fetchPending, isSpectating && currentView === 'draw' ? 2500 : 10000);
    }
    return () => { if (interval) window.clearInterval(interval); };
  }, [currentView, currentUser, isSpectating]);

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
    // Tell spectators to clear too (instant + exact).
    postSpectateEvent({ t: 'clear' });
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
    // Reconcile spectators to the undone state via an immediate keyframe (the already-sent
    // live strokes can't be un-sent, so the authoritative snapshot corrects them).
    shareLivePendingNow();
  };

  // Frames from the current week only — used for onion skin and spectator view
  // so that new weeks start with a blank canvas
  const currentWeekFrames = useMemo(() => frames.filter(f => f.paletteWeek === currentWeek), [frames, currentWeek]);

  const themes = ['Anime Inking', 'Retro Comic', 'Soft Watercolor'];
  // Server theme takes priority; localStorage bundle is only for next-week preview
  const currentTheme = serverTheme || (currentWeek === 1 ? 'Moving Lines' : themes[currentWeek % themes.length]);
  const formatCountdown = (sec:number)=>{
    const h = Math.floor(sec/3600).toString().padStart(2,'0');
    const m = Math.floor((sec%3600)/60).toString().padStart(2,'0');
    const s = (sec%60).toString().padStart(2,'0');
    return `${h}:${m}:${s}`;
  };

  // SidePanels shared by the desktop inline rail and the mobile right drawer.
  // On mobile, picking a tool / color / brush closes the drawer so the canvas is clear.
  const sidePanelsNode = (
    <SidePanels
      side={paletteSide}
      toggleSide={() => setPaletteSide(p => p === 'right' ? 'left' : 'right')}
      order={panelsOrder}
      setOrder={setPanelsOrder}
      tool={tool}
      setTool={(t) => { setTool(t); setToolsDrawerOpen(false); }}
      brushSize={brushSize}
      setBrushSize={setBrushSize}
      brushSpacing={brushSpacing}
      setBrushSpacing={setBrushSpacing}
      brushOpacity={brushOpacity}
      setBrushOpacity={setBrushOpacity}
      brushPresetId={brushPresetId}
      setBrushPresetId={(id) => { setBrushPresetId(id); setToolsDrawerOpen(false); }}
      colors={currentPalette}
      activeColor={activeColor}
      setActiveColor={(c) => { setActiveColor(c); setToolsDrawerOpen(false); }}
      currentWeek={currentWeek}
      onSave={saveFrame}
      onClear={clearCanvas}
      onUndo={undo}
      disabled={!(turnInfo && turnInfo.currentArtist === currentUser) || timeLeft === 0}
      timeLeft={timeLeft}
      onStartTurn={async () => { try { await fetch('/api/turn',{ method:'POST', headers:{'Content-Type':'application/json','X-User': currentUser } as any, body: JSON.stringify({ action:'start', user: currentUser }) }); const r= await fetch('/api/turn', { headers: { 'X-User': currentUser } as any }); if(r.ok) { setTurnInfo(await r.json()); startedByMeRef.current = true; } } catch {} }}
      onFinalizeTurn={forceEndSession}
      canStart={Boolean(turnInfo && !turnInfo.currentArtist)}
      isArtist={Boolean(turnInfo && turnInfo.currentArtist === currentUser)}
      currentArtist={turnInfo?.currentArtist || null}
      allowedBrushIds={allowedBrushIds}
    />
  );

  // Draw-view columns. Each carries a flex `order` instead of being re-parented, so flipping
  // a side is pure CSS and never remounts the column (the chat would drop its state otherwise).
  // Desktop inline tools rail — on mobile the tools live in the right drawer.
  // shrink-0 + justify-center keeps the panels hugging the (narrow portrait) canvas.
  const toolsRailNode = !isMobile ? (
    <div
      ref={sidePanelsRef}
      className="shrink-0"
      style={{ order: paletteSide === 'left' ? -1 : 1, width: panelsWidth, height: panelsHeight }}
    >
      <div ref={sidePanelsInnerRef} className="w-max" style={{ transform: `scale(${panelsScale})`, transformOrigin: 'top left' }}>
        {sidePanelsNode}
      </div>
    </div>
  ) : null;
  // Inline chat: desktop only. Auto when it fits, but an explicit show/hide always wins.
  const showChat = !isMobile && (chatOverride ?? chatFits);
  // Width is left to flexbox (grow into the leftover, clamped): CSS tracks the real space
  // continuously, where a measured pixel width would go stale between resizes.
  const chatInlineNode = showChat ? (
    <div className="flex-1 min-w-[210px] max-w-[288px]" style={{ order: chatSide === 'left' ? -2 : 2 }}>
      <Chat
        currentWeek={currentWeek}
        currentUser={currentUser}
        inline
        side={chatSide}
        onToggleSide={() => setChatSide(s => s === 'right' ? 'left' : 'right')}
        maxHeight={panelsHeight}
      />
    </div>
  ) : null;

  // Zoom / onion / chat-toggle rail that sits between the canvas and the tools panels.
  const zoomRailNode = (
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
        <div className="flex flex-col items-center gap-1 border-t-2 border-black/30 pt-2 w-full">
          <button
            onClick={() => setChatOverride(!showChat)}
            aria-label={showChat ? 'Hide chat' : 'Show chat'}
            title={showChat ? 'Hide chat' : 'Show chat'}
            className="p-1.5 rounded-full pencil-btn transition"
          >
            {showChat ? <MessageCircleOff className="w-4 h-4" /> : <MessageCircle className="w-4 h-4" />}
          </button>
          <span className="text-[8px] leading-none tracking-tight text-black/75 select-none">Chat</span>
        </div>
      </div>
    </div>
  );

  // Compact bottom navigation for mobile (replaces the hidden 60px left rail).
  const mobileNav = ([
    { key: 'draw', label: 'Draw', Icon: Palette },
    { key: 'gallery', label: 'Gallery', Icon: ImgIcon },
    { key: 'video', label: 'Video', Icon: Play },
    { key: 'voting', label: 'Vote', Icon: Vote },
    { key: 'chat', label: 'Chat', Icon: MessageCircle },
  ] as const);

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
        <span className="max-w-[150px] truncate font-semibold flex items-center gap-1">
          {turnInfo?.currentArtist ? (
            <>
              {isSpectating && <span className="kinora-blink inline-block w-2.5 h-2.5 rounded-full bg-red-600 shrink-0" aria-hidden="true" />}
              <span className="truncate">u/{turnInfo.currentArtist}{isSpectating ? ' · LIVE' : ''}</span>
            </>
          ) : 'No artist'}
        </span>
      </div>
      {/* Minimal spacer (5px) below fixed debug bar */}
      <div style={{height:'5px'}} aria-hidden="true" />
      {/* Embedding indicator for Reddit */}
  {/* Reddit banner removed */}
      
  <Header currentView={currentView} setCurrentView={setCurrentView} />
  {/* No left padding for the fixed nav rail here: body already reserves its 60px (index.css),
      and padding it twice cost ~68px that the chat column needs on narrower desktops/iPads. */}
  <div className={currentView === 'draw' ? 'w-full px-1 md:pr-3 pb-4' : 'max-w-6xl mx-auto px-3 pb-4'}>
        {/* Turn / Lobby banner */}
  {/* Removed top status banner (User / Artist / Ends in) */}
        {currentView === 'draw' && (
          <div ref={drawRowRef} className="w-full flex flex-row items-start justify-center gap-2 md:gap-4">
            {chatInlineNode}
            {toolsRailNode}
            <div ref={canvasCardRef} className="shrink-0" style={{ order: 0 }}>
              <div className="flex items-start gap-2 md:gap-4">
                {!isMobile && paletteSide === 'right' && zoomRailNode}
                <div className="flex justify-center">
                    {isSpectating ? (
                    <SpectatorCanvas
                      ref={spectatorRef}
                      maxHeight={!isMobile ? panelsHeight : undefined}
                      baseImage={sharedPending?.imageData || (currentWeekFrames.length ? currentWeekFrames[currentWeekFrames.length-1]?.imageData : null)}
                    />
                    ) : (
                    <Canvas
                      key={`canvas-${turnInfo?.currentArtist || 'none'}-${frames.length ? frames[frames.length-1].key : 'empty'}-${resumeNonce}`}
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
                      onZoomChange={setZoom}
                      maxHeight={!isMobile ? panelsHeight : undefined}
                      // Only show onion (previous frame) to the active artist as a faint guide
                      // Filter to current week so new weeks start with a blank canvas
                      onionImage={(turnInfo && turnInfo.currentArtist === currentUser && currentWeekFrames.length) ? currentWeekFrames[currentWeekFrames.length-1]?.imageData : undefined}
                      onionOpacity={onionOpacity}
                      onDirty={handleCanvasDirty}
                      // Spectators see the last finalized frame fully; artist sees their draft (if any)
                      restoreImage={(turnInfo && turnInfo.currentArtist === currentUser) ? draftImage : (currentWeekFrames.length ? currentWeekFrames[currentWeekFrames.length-1]?.imageData : null)}
                      // Live spectator: overlay the artist's in-progress frame, refreshed ~2.5s
                      onSegment={handleArtistSegment}
                      onFill={handleArtistFill}
                    />
                    )}
                </div>
                {!isMobile && paletteSide === 'left' && zoomRailNode}
              </div>
            </div>
          </div>
        )}

        {/* MOBILE: floating tools button + right slide-in drawer (auto-closes on tool pick) */}
        {isMobile && currentView === 'draw' && !toolsDrawerOpen && (
          <button
            onClick={() => setToolsDrawerOpen(true)}
            aria-label="Open tools"
            style={{ position: 'fixed', right: '8px', top: '50%', transform: 'translateY(-50%)' }}
            className="z-40 sketch-border rounded-full p-3 bg-[#FAF3E0] text-black shadow-[2px_2px_0_0_#000]"
          >
            <PencilRuler className="w-5 h-5" />
          </button>
        )}
        {isMobile && currentView === 'draw' && toolsDrawerOpen && (
          <div className="fixed inset-0 z-50" onClick={() => setToolsDrawerOpen(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <div
              className="absolute right-0 top-0 h-full max-w-[88%] overflow-y-auto p-3 pt-10 bg-[#FAF3E0] border-l-2 border-black shadow-[-4px_0_0_0_rgba(0,0,0,0.35)]"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setToolsDrawerOpen(false)}
                aria-label="Close tools"
                style={{ position: 'absolute', top: '8px', right: '8px' }}
                className="z-10 sketch-border rounded-full p-1.5 bg-white text-black"
              >
                <X className="w-4 h-4" />
              </button>
              {/* Onion opacity (mobile) — the desktop slider column is hidden here */}
              {frames.length > 0 && (
                <div className="mb-3 flex items-center gap-2 sketch-border rounded-xl p-2 bg-white/60">
                  <OnionIcon className="w-4 h-4 text-black shrink-0" />
                  <input
                    type="range" min={0} max={100}
                    value={Math.round(onionOpacity*100)}
                    onChange={(e) => (turnInfo && turnInfo.currentArtist === currentUser) ? setOnionOpacity(parseInt(e.target.value,10)/100) : undefined}
                    disabled={!(turnInfo && turnInfo.currentArtist === currentUser) || !frames.length}
                    aria-label="Onion opacity"
                    className="flex-1 accent-black cursor-pointer"
                  />
                </div>
              )}
              {sidePanelsNode}
            </div>
          </div>
        )}

        {currentView === 'gallery' && (
          <FrameGallery
            frames={frames}
            currentWeek={currentWeek}
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

      {/* MOBILE: bottom navigation bar (replaces the hidden 60px left rail) */}
      {isMobile && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-stretch justify-around h-[52px] bg-[#FAF3E0] panel-hatch border-t-2 border-black">
          {mobileNav.map(({ key, label, Icon }) => {
            const active = currentView === key;
            return (
              <button
                key={key}
                onClick={() => setCurrentView(key as any)}
                aria-label={label}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${active ? 'text-black' : 'text-black/50'}`}
              >
                <Icon className="w-5 h-5" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

export default App;