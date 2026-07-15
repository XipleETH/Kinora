import { forwardRef, useEffect, useRef, useState, useImperativeHandle } from 'react';
import { paintSegment } from '../brushEngine';

// Lightweight read-only canvas for LIVE spectating. It does NOT use the stateful brush
// engine — it repaints an authoritative keyframe (a real CDN render) as the base and
// draws incoming quadratic stroke segments on top for a sub-second live preview. Any
// per-engine texture divergence is corrected on the next keyframe.

const LOGICAL_W = 360;
const LOGICAL_H = 640;
const SUPERSAMPLE = 2; // backing store 720x1280 — identical geometry to the artist Canvas
const CANVAS_ASPECT = LOGICAL_W / LOGICAL_H;

export type SpectateStrokeMsg = { b?: any; segs: number[][] };
export type SpectatorHandle = {
  applyStroke: (msg: SpectateStrokeMsg) => void;
  setKeyframe: (url: string) => void;
  applyClear: () => void;
  applyFill: (x: number, y: number, color: string) => void;
};

function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h || '000000', 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Explicit `| undefined`: exactOptionalPropertyTypes is on and App forwards state straight through.
type Props = { maxHeight?: number | undefined; baseImage?: string | null | undefined };

export const SpectatorCanvas = forwardRef<SpectatorHandle, Props>(({ maxHeight, baseImage }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progRef = useRef<{ current: number }>({ current: 0 }); // spectator's own accumulated stroke length (per stroke)
  const lastSidRef = useRef<number>(-1);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number }>({ w: LOGICAL_W, h: LOGICAL_H });

  // Display sizing — mirrors Canvas.tsx so the spectator view lines up with the artist view.
  useEffect(() => {
    const compute = () => {
      const vv = (window as any).visualViewport;
      const viewW = window.innerWidth;
      const viewH = vv ? vv.height : window.innerHeight;
      let availW: number; let availH: number;
      if (viewW < 768) {
        availW = viewW - 8;
        availH = Math.max(160, viewH - 96);
      } else {
        const fit = containerRef.current?.parentElement;
        const rect = fit?.getBoundingClientRect();
        const top = rect ? rect.top : 0;
        availH = Math.max(160, viewH - top - 12);
        availW = Math.max(160, viewW - 140);
        if (maxHeight && maxHeight > 160) availH = Math.min(availH, maxHeight);
      }
      let w = availW; let h = w / CANVAS_ASPECT;
      if (h > availH) { h = availH; w = h * CANVAS_ASPECT; }
      w = Math.floor(w); h = Math.floor(h);
      setDisplaySize(prev => (prev.w === w && prev.h === h) ? prev : { w, h });
    };
    compute();
    const shell = containerRef.current;
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => compute()) : null;
    if (ro && shell?.parentElement) ro.observe(shell.parentElement);
    window.addEventListener('resize', compute);
    if ((window as any).visualViewport) (window as any).visualViewport.addEventListener('resize', compute);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', compute);
      if ((window as any).visualViewport) (window as any).visualViewport.removeEventListener('resize', compute);
    };
  }, [maxHeight]);

  // Fixed backing store, drawn in LOGICAL space (like the artist Canvas).
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    c.width = LOGICAL_W * SUPERSAMPLE; c.height = LOGICAL_H * SUPERSAMPLE;
    const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  }, []);

  const paintBase = (url: string) => {
    const c = canvasRef.current; if (!c || !url) return;
    const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
    const img = new Image();
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
    img.onerror = () => { /* keep current canvas on failure */ };
    img.onload = () => {
      // Reject Reddit's "image was probably deleted" placeholder (and any non-portrait
      // image): our frames are 9:16, so an off-aspect image is never our drawing and must
      // not wipe the live canvas.
      const ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0;
      if (!ar || Math.abs(ar - CANVAS_ASPECT) > 0.1) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
      ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      ctx.drawImage(img, 0, 0, LOGICAL_W, LOGICAL_H);
      ctx.restore();
    };
    img.src = url;
  };

  // Paint the initial base (last frame / first keyframe) once available.
  useEffect(() => { if (baseImage) paintBase(baseImage); }, [baseImage]);

  const clearWhite = () => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    ctx.restore();
  };

  useImperativeHandle(ref, () => ({
    setKeyframe: (url: string) => paintBase(url),
    applyClear: () => clearWhite(),
    applyFill: (x: number, y: number, color: string) => {
      // Approximate live flood fill (device px), mirroring the artist's scanline fill. The
      // spectator's canvas differs slightly, so the boundary is approximate; the periodic
      // keyframe corrects it. Skips if the tap pixel already matches the fill color.
      const c = canvasRef.current; if (!c) return;
      const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
      const W = c.width, H = c.height;
      const sx = Math.floor(x * SUPERSAMPLE), sy = Math.floor(y * SUPERSAMPLE);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
      const [fr, fg, fb] = hexToRgb(color);
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      const idx = (sy * W + sx) * 4;
      const tr = d[idx]!, tg = d[idx + 1]!, tb = d[idx + 2]!, ta = d[idx + 3]!;
      if (Math.abs(tr - fr) <= 2 && Math.abs(tg - fg) <= 2 && Math.abs(tb - fb) <= 2) return;
      const T = 16;
      const match = (i: number) => Math.abs(d[i]! - tr) <= T && Math.abs(d[i + 1]! - tg) <= T && Math.abs(d[i + 2]! - tb) <= T && Math.abs(d[i + 3]! - ta) <= T;
      const mask = new Uint8Array(W * H);
      const stack: Array<[number, number]> = [[sx, sy]];
      while (stack.length) {
        const [px, py] = stack.pop()!;
        let nx = px, m = py * W + nx, i = m * 4;
        while (nx >= 0 && !mask[m] && match(i)) { nx--; m--; i -= 4; }
        nx++; m++; i += 4;
        let up = false, down = false;
        while (nx < W && !mask[m] && match(i)) {
          mask[m] = 1;
          if (py > 0) { const am = m - W, ai = i - W * 4; if (!mask[am] && match(ai)) { if (!up) { stack.push([nx, py - 1]); up = true; } } else if (up) up = false; }
          if (py < H - 1) { const bm = m + W, bi = i + W * 4; if (!mask[bm] && match(bi)) { if (!down) { stack.push([nx, py + 1]); down = true; } } else if (down) down = false; }
          nx++; m++; i += 4;
        }
      }
      for (let p = 0; p < W * H; p++) { if (mask[p]) { const i = p * 4; d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255; } }
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.putImageData(img, 0, 0); ctx.restore();
    },
    applyStroke: (msg: SpectateStrokeMsg) => {
      const c = canvasRef.current; if (!c || !msg || !Array.isArray(msg.segs)) return;
      const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
      const b = msg.b || {};
      // New stroke -> reset the spectator's own progress accumulator (drives taper).
      if (b.sid !== lastSidRef.current) { lastSidRef.current = b.sid; progRef.current.current = 0; }
      if (b.e) {
        // Eraser: a plain white stroke (the base is white), matching the artist's eraser.
        ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(0.5, b.sz || 6);
        for (const s of msg.segs) {
          if (!Array.isArray(s) || s.length < 6) continue;
          ctx.beginPath(); ctx.moveTo(s[0]!, s[1]!); ctx.quadraticCurveTo(s[4]!, s[5]!, s[2]!, s[3]!); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        // Draw: run the SHARED brush engine so spectators see the REAL effect live.
        for (const s of msg.segs) {
          if (!Array.isArray(s) || s.length < 6) continue;
          paintSegment(ctx, { x: s[0]!, y: s[1]! }, { x: s[2]!, y: s[3]! }, { x: s[4]!, y: s[5]! }, b.p, b.c || '#1b1b1b', b.sz || 6, b.o, b.sp, s[6] ?? 0.6, s[7] ?? 0, progRef.current);
        }
      }
    },
  }), []);

  return (
    <div ref={containerRef} className="canvas-shell inline-block" style={{ width: displaySize.w, height: displaySize.h, position: 'relative' }}>
      <div className="relative" style={{ width: displaySize.w, height: displaySize.h }}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 canvas-paper sketch-outline select-none"
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
});
SpectatorCanvas.displayName = 'SpectatorCanvas';
