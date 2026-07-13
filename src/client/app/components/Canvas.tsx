import React, { forwardRef, useRef, useEffect, useState } from 'react';
import type { BrushPreset } from '../brushes';
import { paintSegment } from '../brushEngine';

interface CanvasProps {
  activeColor: string;
  brushSize: number;
  brushSpacing?: number; // global spacing override (user slider)
  brushOpacity?: number; // 0..1 override
  isDrawing: boolean;
  setIsDrawing: (drawing: boolean) => void;
  disabled?: boolean;
  // Único engine actual: mangaPen
  brushPreset?: BrushPreset; // se usará size/opacity/taper/jitter
  // Active tool selection
  tool?: 'draw' | 'erase' | 'fill';
  // Called once right before a mutating action (stroke start or fill)
  onBeforeMutate?: () => void;
  // Controlled zoom props (optional). If not provided, the component manages its own zoom internally.
  zoom?: number;
  // Onion skin (previous frame) overlay
  onionImage?: string;
  onionOpacity?: number; // 0..1
  // Called after a drawing mutation (end of stroke segment / fill) to allow external persistence
  onDirty?: () => void;
  // Optional image (dataURL) to restore onto a freshly mounted/cleared canvas
  restoreImage?: string | null;
  // Called when a two-finger pinch changes zoom (controlled zoom lives in the parent)
  onZoomChange?: (zoom: number) => void;
  // Desktop only: cap the displayed canvas height (px) so it ends level with the side
  // tool panels. The 9:16 aspect is preserved (width follows).
  maxHeight?: number;
  // Live spectator view: when `spectating`, the user is logged in but not the current
  // artist. Show `liveImage` (the artist's in-progress frame) fully over the canvas and
  // replace the dim "login to draw" overlay with a small LIVE chip. Reactive: updating
  // liveImage repaints without a remount.
  liveImage?: string | null;
  spectating?: boolean;
  liveLabel?: string;
  // Emitted per smoothed DRAW segment (artist only) so the parent can stream strokes to
  // spectators over realtime. Coords are LOGICAL; `w` is the approximate rendered width.
  onSegment?: (seg: {
    from: { x: number; y: number }; to: { x: number; y: number }; ctrl: { x: number; y: number };
    sid: number; erase: boolean; size: number;
    // draw-only (the spectator feeds these into the shared brush engine):
    preset?: BrushPreset; color?: string; opacity?: number; spacing?: number; dynamic?: number; velocity?: number;
  }) => void;
  // Called after a flood fill (artist only) with LOGICAL coords + color, so the parent can
  // stream the fill to spectators.
  onFill?: (x: number, y: number, color: string) => void;
}

// Default canvas size — 9:16 PORTRAIT (vertical, Reels/TikTok format)
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 640;
// Canvas aspect ratio (width / height). Portrait 9:16 so every stored frame keeps
// the same vertical shape and fills a phone screen.
const CANVAS_ASPECT = DEFAULT_WIDTH / DEFAULT_HEIGHT;

// --- FIXED CANONICAL RESOLUTION (device-independent) ---------------------------
// The drawing happens in a fixed LOGICAL coordinate space (360x640) where brush
// sizes live, so brush feel is identical on every device. The backing store is
// supersampled to LOGICAL*SUPERSAMPLE = 720x1280 (vertical), so EVERY exported
// frame is exactly 720x1280 regardless of screen size or devicePixelRatio. This
// keeps the weekly video coherent (the GIF encoder no longer drops mismatched
// frames) and makes onion-skin / restore geometry distortion-free across devices.
const LOGICAL_W = DEFAULT_WIDTH;   // 360
const LOGICAL_H = DEFAULT_HEIGHT;  // 640
const SUPERSAMPLE = 2;             // backing store = 720x1280

export const Canvas = forwardRef<HTMLCanvasElement, CanvasProps>(({
  activeColor, brushSize, brushSpacing, brushOpacity, isDrawing, setIsDrawing, disabled,
  brushPreset, tool = 'draw', onBeforeMutate, zoom: controlledZoom, onionImage, onionOpacity = 0.4, onDirty, restoreImage, onZoomChange, maxHeight,
  liveImage, spectating = false, liveLabel, onSegment, onFill
}, ref) => {
  const internalRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = (ref as React.RefObject<HTMLCanvasElement>) || internalRef;
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const strokeProgressRef = useRef<number>(0); // distancia acumulada
  const strokeIdRef = useRef<number>(0); // increments per stroke — lets spectators reset their own progress accumulator
  // Buffer para estabilización (line smoothing) tipo ventana móvil
  const smoothBuffer = useRef<Array<{x:number;y:number;t:number;pressure:number}>>([]);
  // Flag para evitar que el primer movimiento genere línea conectando con stroke previo
  const firstMoveRef = useRef<boolean>(false);
  // Guardamos la posición inicial para poder dibujar un "tap" como punto
  const strokeStartPosRef = useRef<{x:number;y:number}|null>(null);
  // --- Brush dynamics + input smoothing (device-independent) ---
  const smoothedPosRef = useRef<{x:number;y:number}|null>(null); // "pulled string" stabilizer anchor
  const emaSpeedRef = useRef<number>(0);       // smoothed speed, logical px/ms
  const emaPressureRef = useRef<number>(0.6);  // smoothed dynamic 0..1 (drives width/opacity)
  const lastMoveTimeRef = useRef<number>(0);   // ms timestamp of last processed move
  const strokePeakSpeedRef = useRef<number>(0.001);
  const containerRef = useRef<HTMLDivElement>(null);
  // Internal zoom state only used when no controlled zoom is supplied
  const [internalZoom] = useState(1);
  const zoom = controlledZoom ?? internalZoom;
  const penActionRef = useRef<'draw' | 'erase' | 'pan' | 'pinch' | null>(null);
  const eraseRef = useRef(false);
  const activeDrawPointerIdRef = useRef<number | null>(null);
  const activePanPointerIdRef = useRef<number | null>(null);
  // Touch gesture state: 1 finger draws, 2 fingers pinch-zoom + pan.
  const touchPtsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; cx: number; cy: number; zoom: number; scrollLeft: number; scrollTop: number } | null>(null);
  const pendingTouchRef = useRef<{ id: number; startX: number; startY: number; offX: number; offY: number } | null>(null);

    // Responsive size: fit the largest 16:9 canvas into the available layout box so
    // it fills the screen (width from the parent cell, height from the viewport).
    const [displaySize, setDisplaySize] = useState<{w:number;h:number}>({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
    useEffect(() => {
      const compute = () => {
        const vv = (window as any).visualViewport;
        const viewW = window.innerWidth;
        const viewH = vv ? vv.height : window.innerHeight;
        let availW: number;
        let availH: number;
        if (viewW < 768) {
          // Mobile: the canvas is the focus — fit the largest 16:9 into (almost) the
          // full width, leaving room for the top badge row and bottom nav bar.
          availW = viewW - 8;
          availH = Math.max(160, viewH - 96);
        } else {
          // Desktop: the portrait canvas is sized by available HEIGHT (width follows),
          // so it no longer depends on the flex cell width. This lets the tool panels
          // hug the canvas instead of being pushed to the screen edges.
          const fit = containerRef.current?.parentElement;
          const rect = fit?.getBoundingClientRect();
          const top = rect ? rect.top : 0;
          availH = Math.max(160, viewH - top - 12); // leave a little breathing room
          availW = Math.max(160, viewW - 140);      // generous; height is the real constraint for portrait
          // Cap to the side panels' height so the canvas ends level with them.
          if (maxHeight && maxHeight > 160) availH = Math.min(availH, maxHeight);
        }
        // Largest 16:9 that fits both dimensions
        let w = availW;
        let h = w / CANVAS_ASPECT;
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

    // Initialize the FIXED backing store once on mount (decoupled from the display
    // size, so resizing the window no longer clears the drawing). The element is
    // remounted per turn/frame via its `key`, so this re-runs with fresh content then.
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = LOGICAL_W * SUPERSAMPLE;   // 720
      canvas.height = LOGICAL_H * SUPERSAMPLE;  // 1280
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.setTransform(1,0,0,1,0,0);
      ctx.scale(SUPERSAMPLE, SUPERSAMPLE);      // draw in LOGICAL (640x360) space
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }, []);

  // mouse pos helper removed (pointer events compute directly)

  // touch drawing removed (single-finger pans, stylus uses pointer events)

  // hexToRgba removido (no necesario para mangaPen, fill usa blending directo)

    const hexToRgbTuple = (hex: string): [number, number, number, number] => {
      let h = hex.replace('#', '');
      if (h.length === 3) {
        h = h.split('').map(c => c + c).join('');
      }
      const bigint = parseInt(h, 16);
      const r = (bigint >> 16) & 255;
      const g = (bigint >> 8) & 255;
      const b = bigint & 255;
      return [r, g, b, 255];
    };

  // Thin wrapper over the shared brush engine (see ../brushEngine). Keeps the same
  // signature; the artist paints on its own canvas with its live refs.
  const drawLine = (from: { x: number; y: number }, to: { x: number; y: number }, pressure: number, control?: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    if (!canvas || disabled) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    paintSegment(ctx, from, to, control, brushPreset, activeColor, brushSize, brushOpacity, brushSpacing, pressure, emaSpeedRef.current, strokeProgressRef);
  };

  // Old mouse handlers removed; pointer events unify behavior

    // Single-finger: pan (no drawing). Two-finger: pinch zoom. Pen stylus: drawing.
    const panState = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);

  // Helper removed (no touch drawing with stylus now)

  // Touch events: let the browser handle scrolling for finger pan; no drawing on touch
  const handleTouchStart = (_e: React.TouchEvent<HTMLCanvasElement>) => {};
  const handleTouchMove = (_e: React.TouchEvent<HTMLCanvasElement>) => {};
  const handleTouchEnd = (_e: React.TouchEvent<HTMLCanvasElement>) => {};

  const floodFill = (x: number, y: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
  const w = canvas.width; // device px (fixed 720)
  const h = canvas.height; // fixed 1280
      // Logical (360x640) -> device pixel coords
      const sx = Math.floor(x * SUPERSAMPLE);
      const sy = Math.floor(y * SUPERSAMPLE);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data; // Uint8ClampedArray
      const idx = (sy * w + sx) * 4;
      const targetR = data[idx];
      const targetG = data[idx + 1];
      const targetB = data[idx + 2];
      const targetA = data[idx + 3];

  const [fillR, fillG, fillB] = hexToRgbTuple(activeColor);
  const opacityMul = Math.max(0, Math.min(1, brushPreset?.opacity ?? 1));
      const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
      const T = 16; // antialiasing tolerance
      const matchesTarget = (i: number) => near(data[i], targetR, T) && near(data[i + 1], targetG, T) && near(data[i + 2], targetB, T) && near(data[i + 3], targetA, T);

      // Build region mask via scanline flood fill
      const mask = new Uint8Array(w * h);
      let minX = sx, maxX = sx, minY = sy, maxY = sy;
      const stack: Array<[number, number]> = [[sx, sy]];
      while (stack.length) {
        const [px, py] = stack.pop()!;
        let nx = px;
        let m = py * w + nx;
        let i = m * 4;
        // move left to span start
        while (nx >= 0 && !mask[m] && matchesTarget(i)) {
          nx--;
          m--;
          i -= 4;
        }
        nx++;
        m++;
        i += 4;
        let spanUp = false;
        let spanDown = false;
        while (nx < w && !mask[m] && matchesTarget(i)) {
          // mark mask
          mask[m] = 1;
          if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
          // scan up
          if (py > 0) {
            const am = m - w; const ai = i - w * 4;
            if (!spanUp && !mask[am] && matchesTarget(ai)) {
              stack.push([nx, py - 1]);
              spanUp = true;
            } else if (spanUp && (mask[am] || !matchesTarget(ai))) {
              spanUp = false;
            }
          }
          // scan down
          if (py < h - 1) {
            const bm = m + w; const bi = i + w * 4;
            if (!spanDown && !mask[bm] && matchesTarget(bi)) {
              stack.push([nx, py + 1]);
              spanDown = true;
            } else if (spanDown && (mask[bm] || !matchesTarget(bi))) {
              spanDown = false;
            }
          }
          nx++;
          m++;
          i += 4;
        }
      }

      // Early out if trivial
      if (minX > maxX || minY > maxY) return;

      // Relleno simple monocolor para mangaPen (pixel blending)
      const blendPixel = (di: number, a: number) => {
        const inv = 1 - a;
        const dr = data[di];
        const dg = data[di + 1];
        const db = data[di + 2];
        const da = data[di + 3] / 255;
        const outA = a + da * inv;
        const outR = Math.round(fillR * a + dr * inv);
        const outG = Math.round(fillG * a + dg * inv);
        const outB = Math.round(fillB * a + db * inv);
        data[di] = outR;
        data[di + 1] = outG;
        data[di + 2] = outB;
        data[di + 3] = Math.round(outA * 255);
      };
      
      // If a brush texture is active, synthesize a textured fill instead of flat pixels
      const texture = brushPreset?.texture ?? 'none';
      const bboxW = maxX - minX + 1; // device px
      const bboxH = maxY - minY + 1;
      const baseSize = Math.max(1, Math.floor(brushSize * SUPERSAMPLE));
      const drawSolidFill = () => {
        for (let y0 = minY; y0 <= maxY; y0++) {
          let m = y0 * w + minX; let di = m * 4;
          for (let x0 = minX; x0 <= maxX; x0++, m++, di += 4) {
            if (!mask[m]) continue;
            if (opacityMul >= 0.999) { data[di] = fillR; data[di + 1] = fillG; data[di + 2] = fillB; data[di + 3] = 255; }
            else blendPixel(di, opacityMul);
          }
        }
        ctx.putImageData(imageData, 0, 0);
      };

      if (texture === 'none') {
        drawSolidFill();
        return;
      }

      // Offscreen texture buffer in device pixels
      const off = document.createElement('canvas');
      off.width = bboxW; off.height = bboxH;
      const octx = off.getContext('2d');
      if (!octx) { drawSolidFill(); return; }

      // Common helpers for textured fill
      const rand = Math.random;
      const drawDot = (xPx: number, yPx: number, rPx: number, a: number) => {
        if (rPx <= 0) return;
        octx.globalAlpha = Math.max(0, Math.min(1, a));
        octx.fillStyle = activeColor;
        octx.beginPath();
        octx.arc(xPx + 0.5, yPx + 0.5, rPx, 0, Math.PI * 2);
        octx.fill();
      };

      // 1) Charcoal: scatter grains and soft halos inside mask
      const fillCharcoal = () => {
        const area = bboxW * bboxH;
        const density = Math.max(600, Math.min(8000, Math.floor(area / 140))); // area-relative (scales with canvas size)
        const grains = Math.floor(density * (0.6 + 0.8 * (brushPreset?.density ?? 1)));
        const maxR = Math.max(1, Math.floor(baseSize * 0.22));
        for (let g = 0; g < grains; g++) {
          const rx = minX + Math.floor(rand() * bboxW);
          const ry = minY + Math.floor(rand() * bboxH);
          if (!mask[ry * w + rx]) continue;
          const rr = Math.max(1, Math.floor(0.5 + rand() * maxR));
          const edge = rr / (maxR + 0.0001);
          const falloff = 1 - edge * edge;
          const a = (brushPreset?.opacity ?? 0.65) * (0.25 + 0.55 * rand()) * falloff * opacityMul;
          drawDot(rx - minX, ry - minY, rr, a);
          if (rand() < 0.06) {
            octx.globalAlpha = a * 0.22;
            octx.beginPath();
            octx.arc(rx - minX + 0.5, ry - minY + 0.5, rr * (2 + rand() * 2), 0, Math.PI * 2);
            octx.fill();
          }
        }
        octx.globalAlpha = 1;
      };

      // 2) Marker: multiple parallel strokes with slight jitter, clipped to mask
      const fillMarker = () => {
        const passes = 3;
        const widthPx = Math.max(2, Math.floor(baseSize * 0.85));
        for (let p = 0; p < passes; p++) {
          const offset = Math.floor(((p - (passes - 1) / 2) / (passes)) * (widthPx * 0.5));
          for (let y0 = 0; y0 < bboxH; y0++) {
            const yy = y0 + offset;
            if (yy < 0 || yy >= bboxH) continue;
            // scan segments where mask is on for this scanline
            let x = 0;
            while (x < bboxW) {
              // advance to start of mask
              while (x < bboxW && !mask[(minY + yy) * w + (minX + x)]) x++;
              if (x >= bboxW) break;
              const start = x;
              while (x < bboxW && mask[(minY + yy) * w + (minX + x)]) x++;
              const end = x;
              octx.globalAlpha = opacityMul * (0.55 + 0.25 * rand());
              octx.strokeStyle = activeColor;
              octx.lineCap = 'round';
              octx.lineJoin = 'round';
              octx.lineWidth = Math.max(2, widthPx * (0.92 + rand() * 0.1));
              octx.beginPath();
              // small perpendicular jitter
              const j = Math.floor((rand() - 0.5) * Math.max(1, widthPx * 0.15));
              octx.moveTo(start, yy + j);
              octx.lineTo(end, yy + j);
              octx.stroke();
            }
          }
        }
        octx.globalAlpha = 1;
      };

      // 3) Pencil/Rough: fine grains with subtle randomness
      const fillPencil = () => {
        const area = bboxW * bboxH;
        // fewer grains than charcoal
        const grains = Math.max(500, Math.min(5000, Math.floor(area / 260)));
        for (let g = 0; g < grains; g++) {
          const rx = minX + Math.floor(rand() * bboxW);
          const ry = minY + Math.floor(rand() * bboxH);
          if (!mask[ry * w + rx]) continue;
          const rr = Math.max(0.5, baseSize * (0.06 + rand() * 0.12));
          const a = opacityMul * (0.20 + 0.55 * rand());
          drawDot(rx - minX, ry - minY, rr, a);
        }
        octx.globalAlpha = 1;
      };

      switch (texture) {
        case 'charcoal':
          fillCharcoal();
          break;
        case 'marker':
          fillMarker();
          break;
        case 'pencil':
        case 'rough':
          fillPencil();
          break;
        default:
          drawSolidFill();
          return;
      }

      // Composite offscreen texture onto main imageData (device px) using alpha blend per pixel
      const tex = octx.getImageData(0, 0, bboxW, bboxH);
      const tdata = tex.data;
      // Blend texture over existing pixels only where mask is set
      for (let y0 = 0; y0 < bboxH; y0++) {
        let m = (minY + y0) * w + minX;
        let di = m * 4;
        let ti = y0 * bboxW * 4;
        for (let x0 = 0; x0 < bboxW; x0++, m++, di += 4, ti += 4) {
          if (!mask[m]) continue;
          const a = (tdata[ti + 3] || 0) / 255;
          if (a <= 0) continue;
          blendPixel(di, a);
        }
      }
      ctx.putImageData(imageData, 0, 0);
    };

    const beginStroke = (pos: {x:number;y:number}, erase: boolean) => {
      // Snapshot once per mutation
      onBeforeMutate?.();
      strokeProgressRef.current = 0;
      strokeIdRef.current++;
      lastPointRef.current = pos;
      eraseRef.current = erase;
  // Reset smoothing buffer para no enlazar con stroke previo
  smoothBuffer.current = [{...pos, t: performance.now(), pressure: 0.5}];
      firstMoveRef.current = true; // sigue solo como discriminador de "tap" (sin movimiento)
      strokeStartPosRef.current = pos;
      // Reset device-independent dynamics + stabilizer for this stroke.
      smoothedPosRef.current = pos;
      emaSpeedRef.current = 0;
      emaPressureRef.current = 0.6; // start moderately thick
      lastMoveTimeRef.current = performance.now();
      strokePeakSpeedRef.current = 0.001;
      setIsDrawing(!erase);
    };

    const endStroke = () => {
      // Flush the final segment to the true up position so the ink reaches the finger
      // (the stabilizer anchor lags a few px behind the raw pointer).
      if (!firstMoveRef.current && !eraseRef.current && smoothedPosRef.current && lastPointRef.current) {
        const s = smoothedPosRef.current, r = lastPointRef.current;
        if (Math.hypot(r.x - s.x, r.y - s.y) > 0.5) {
          drawLine(s, r, Math.max(0.12, Math.min(1, emaPressureRef.current)));
        }
      }
      // Si no hubo movimiento (tap) dibujamos un punto corto
      if (firstMoveRef.current && strokeStartPosRef.current && !eraseRef.current) {
        const p = strokeStartPosRef.current;
        // Dibujar un punto mínimo reutilizando drawLine (desplazamiento ínfimo)
        drawLine(p, {x: p.x + 0.01, y: p.y + 0.01}, 0.7);
      }
      setIsDrawing(false);
      lastPointRef.current = null;
      eraseRef.current = false;
  // Mark dirty at end of stroke to ensure persistence captures final state
  onDirty?.();
      firstMoveRef.current = false;
      strokeStartPosRef.current = null;
    };

    // Map a pointer offset (CSS px within the rendered canvas element) to the fixed
    // LOGICAL drawing space (0..640 x 0..360). The element's rendered size is
    // displaySize*zoom, so dividing by zoom then scaling by LOGICAL/displaySize
    // yields device-independent coordinates.
    const toLogicalPos = (offX: number, offY: number) => {
      const sx = displaySize.w > 0 ? LOGICAL_W / displaySize.w : 1;
      const sy = displaySize.h > 0 ? LOGICAL_H / displaySize.h : 1;
      return { x: (offX / zoom) * sx, y: (offY / zoom) * sy };
    };

    // --- Touch gestures: 1 finger draws, 2 fingers pinch-zoom + pan --------------
    const TOUCH_DRAW_THRESHOLD = 4; // px of movement before a touch becomes a stroke

    const onTouchPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = containerRef.current!;
      touchPtsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPtsRef.current.size >= 2) {
        // Second finger -> pinch/pan. Cancel any single-finger stroke in progress
        // WITHOUT depositing a tap-dot: clear the tap-dot guards before endStroke so a
        // just-committed-but-un-inked stroke is discarded cleanly instead of leaving a dot.
        if (penActionRef.current === 'draw' || penActionRef.current === 'erase') {
          firstMoveRef.current = false;
          strokeStartPosRef.current = null;
          endStroke();
          activeDrawPointerIdRef.current = null;
        }
        pendingTouchRef.current = null;
        const vals = [...touchPtsRef.current.values()];
        const a = vals[0]!, b = vals[1]!;
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        pinchRef.current = { dist, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom, scrollLeft: c.scrollLeft, scrollTop: c.scrollTop };
        penActionRef.current = 'pinch';
        return;
      }
      if (penActionRef.current === 'pinch') return;
      const native = e.nativeEvent as PointerEvent & { offsetX: number; offsetY: number };
      if (tool === 'fill') {
        const pos = toLogicalPos(native.offsetX, native.offsetY);
        onBeforeMutate?.();
        floodFill(pos.x, pos.y);
        onFill?.(pos.x, pos.y, activeColor);
        onDirty?.();
        return;
      }
      // Defer drawing until the finger moves past a threshold, so a quickly-added
      // 2nd finger becomes a pinch with no stray mark. A pure tap becomes a dot on up.
      pendingTouchRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, offX: native.offsetX, offY: native.offsetY };
    };

    // Returns true if the move was fully handled (caller should return early).
    const onTouchPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
      const c = containerRef.current!;
      if (touchPtsRef.current.has(e.pointerId)) touchPtsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (penActionRef.current === 'pinch' && pinchRef.current && touchPtsRef.current.size >= 2) {
        const vals = [...touchPtsRef.current.values()];
        const a = vals[0]!, b = vals[1]!;
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const p = pinchRef.current;
        onZoomChange?.(Math.max(1, Math.min(4, p.zoom * (dist / p.dist))));
        c.scrollLeft = p.scrollLeft - (mx - p.cx);
        c.scrollTop = p.scrollTop - (my - p.cy);
        return true;
      }
      const pend = pendingTouchRef.current;
      if (pend && pend.id === e.pointerId) {
        const moved = Math.hypot(e.clientX - pend.startX, e.clientY - pend.startY);
        if (moved > TOUCH_DRAW_THRESHOLD) {
          const erase = tool === 'erase';
          penActionRef.current = erase ? 'erase' : 'draw';
          activeDrawPointerIdRef.current = e.pointerId;
          beginStroke(toLogicalPos(pend.offX, pend.offY), erase);
          pendingTouchRef.current = null;
        }
        return true;
      }
      // Active touch stroke: let the shared drawing block (below) run.
      if ((penActionRef.current === 'draw' || penActionRef.current === 'erase') && activeDrawPointerIdRef.current === e.pointerId) {
        return false;
      }
      return true;
    };

    const onTouchPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      touchPtsRef.current.delete(e.pointerId);
      if (penActionRef.current === 'pinch') {
        if (touchPtsRef.current.size < 2) {
          pinchRef.current = null; penActionRef.current = null;
        } else {
          // Still pinching with 2+ fingers: re-baseline from the remaining pair so
          // lifting a finger that was part of the baseline pair doesn't jump zoom/pan.
          const c = containerRef.current!;
          const vals = [...touchPtsRef.current.values()];
          const a = vals[0]!, b = vals[1]!;
          pinchRef.current = { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom, scrollLeft: c.scrollLeft, scrollTop: c.scrollTop };
        }
        return;
      }

      const pend = pendingTouchRef.current;
      if (pend && pend.id === e.pointerId) {
        // Tap with no movement -> place a dot.
        if (tool !== 'fill') {
          const erase = tool === 'erase';
          beginStroke(toLogicalPos(pend.offX, pend.offY), erase);
          endStroke();
        }
        pendingTouchRef.current = null;
        return;
      }
      if ((penActionRef.current === 'draw' || penActionRef.current === 'erase') && activeDrawPointerIdRef.current === e.pointerId) {
        endStroke();
        activeDrawPointerIdRef.current = null;
        penActionRef.current = null;
      }
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      // Touch is handled by its own gesture state machine (1 finger draws, 2 pinch).
      if (e.pointerType === 'touch') { onTouchPointerDown(e); return; }

      // Si ya estamos dibujando con otro puntero, ignorar nuevos punteros (evitar pan + draw simultáneos)
      if ((penActionRef.current === 'draw' || penActionRef.current === 'erase') && activeDrawPointerIdRef.current !== e.pointerId) {
        return;
      }

      // Capturar el pointer solo para mouse/pen, nunca para touch (gestión propia de pan)
      if (e.pointerType !== 'touch') {
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }
      
      // Clear any previous action
      penActionRef.current = null;
      panState.current = null;
      
  const container = containerRef.current!;
  const native = e.nativeEvent as PointerEvent & { offsetX: number; offsetY: number };
  const pos = toLogicalPos(native.offsetX, native.offsetY);
      const buttons = e.buttons;

      // Fill tool: perform on primary click with mouse/pen. Touch remains pan-only by design.
  if (tool === 'fill' && e.pointerType !== 'touch') {
        if ((e.pointerType === 'mouse' && (buttons & 1)) || (e.pointerType === 'pen' && (buttons & 1))) {
      onBeforeMutate?.();
      floodFill(pos.x, pos.y);
      onFill?.(pos.x, pos.y, activeColor);
      // Mark dirty after fill to persist
      onDirty?.();
          return; // no drawing state, single action
        }
      }
      
      if (e.pointerType === 'pen') {
        // Priority order: eraser > drawing > panning
        if ((buttons & 32) || (buttons & 4) || tool === 'erase') { // eraser button or middle button or active erase tool
          penActionRef.current = 'erase';
          activeDrawPointerIdRef.current = e.pointerId;
          beginStroke(pos, true);
        } else if (buttons & 1) { // pen tip (primary button) - drawing has priority over barrel button
          penActionRef.current = 'draw';
          activeDrawPointerIdRef.current = e.pointerId;
          beginStroke(pos, false);
        } else if (buttons & 2) { // barrel button only (secondary button) - pan only when not drawing
          penActionRef.current = 'pan';
          activePanPointerIdRef.current = e.pointerId;
          panState.current = { x: e.clientX, y: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop };
        }
      } else if (e.pointerType === 'mouse') {
        if (buttons & 2) { // right button - pan
          penActionRef.current = 'pan';
          activePanPointerIdRef.current = e.pointerId;
          panState.current = { x: e.clientX, y: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop };
    } else if (buttons & 1) { // left button - draw/erase based on tool
          if (tool === 'erase') {
            penActionRef.current = 'erase';
      activeDrawPointerIdRef.current = e.pointerId;
            beginStroke(pos, true);
          } else {
            penActionRef.current = 'draw';
            activeDrawPointerIdRef.current = e.pointerId;
            beginStroke(pos, false);
          }
        }
      }
    };

    // One-time restore of provided image
    const restoredRef = useRef(false);
    useEffect(() => {
      if (restoredRef.current) return;
      if (!restoreImage) return;
      const canvas = canvasRef.current; if (!canvas) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
      const img = new Image();
      // Remote (CDN) restore images must be CORS-enabled, or drawing them taints the canvas
      // and breaks the artist's toDataURL autosave. i.redd.it serves permissive CORS; if the
      // load fails we simply leave the canvas untouched (never tainted).
      if (/^https?:/i.test(restoreImage)) img.crossOrigin = 'anonymous';
      img.onerror = () => { /* load failed (e.g. CORS): keep the canvas as-is */ };
      img.onload = () => {
        // Reject Reddit's "image was probably deleted" placeholder (non 9:16) so a stale
        // pending URL never paints garbage over the resumed frame.
        const ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0;
        if (!ar || Math.abs(ar - CANVAS_ASPECT) > 0.1) return;
        ctx.save();
        ctx.setTransform(1,0,0,1,0,0);
        ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
    // Always paint a solid white underlay to avoid transparent regions when restoring
    ctx.clearRect(0,0,LOGICAL_W,LOGICAL_H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0,0,LOGICAL_W,LOGICAL_H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, 0, 0, LOGICAL_W, LOGICAL_H);
        ctx.restore();
        restoredRef.current = true;
      };
      img.src = restoreImage;
    }, [restoreImage]);

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      // Touch: pinch/pending handled here; an active touch stroke falls through to draw.
      if (e.pointerType === 'touch') { if (onTouchPointerMove(e)) return; }
  if (!penActionRef.current) return;
      
      const container = containerRef.current!;
      
  // Handle panning - only when explicitly in pan mode and for the same pointer
  if (penActionRef.current === 'pan' && panState.current && activePanPointerIdRef.current === e.pointerId) {
        const dx = e.clientX - panState.current.x;
        const dy = e.clientY - panState.current.y;
        container.scrollLeft = panState.current.scrollLeft - dx;
        container.scrollTop = panState.current.scrollTop - dy;
        return; // Early return to prevent any drawing action
      }
      
      // Handle drawing/erasing - only when explicitly in draw or erase mode
  if ((penActionRef.current === 'draw' || penActionRef.current === 'erase') && lastPointRef.current && activeDrawPointerIdRef.current === e.pointerId) {
        const native = e.nativeEvent as PointerEvent & { offsetX: number; offsetY: number };
        const pos = toLogicalPos(native.offsetX, native.offsetY);
        
        // Real pressure ONLY from a stylus; touchscreens report a constant value that
        // would freeze the velocity model, so treat mouse/touch as pressure-less here.
        const isPen = e.pointerType === 'pen';
        const nativePressure = (e.nativeEvent as any).pressure as number | undefined;
        const pressure = (isPen && typeof nativePressure === 'number' && nativePressure > 0) ? nativePressure : 0;
        if (penActionRef.current === 'erase') {
          const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            // Preserve opaque white base by painting with white instead of punching transparency
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = brushSize;
            ctx.beginPath();
            ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            ctx.restore();
            // Stream the erase as a WHITE stroke so spectators erase live too (the canvas
            // base is white, so a white stroke reads as an eraser).
            if (onSegment) {
              const lp = lastPointRef.current!;
              onSegment({ from: { x: lp.x, y: lp.y }, to: { x: pos.x, y: pos.y }, ctrl: { x: (lp.x + pos.x) / 2, y: (lp.y + pos.y) / 2 }, sid: strokeIdRef.current, erase: true, size: brushSize });
            }
          }
        } else {
          const last = lastPointRef.current!;
          // Decimate sub-pixel jitter so a near-still finger doesn't fuzz the line.
          const rawDist = Math.hypot(pos.x - last.x, pos.y - last.y);
          if (rawDist < 0.5) { lastPointRef.current = pos; return; }
          firstMoveRef.current = false; // a real move happened -> stroke, not a tap

          // Device-independent smoothed velocity (logical px/ms).
          const now = performance.now();
          const dt = Math.min(64, Math.max(4, now - (lastMoveTimeRef.current || now)));
          lastMoveTimeRef.current = now;
          const inst = rawDist / dt;
          emaSpeedRef.current += (inst - emaSpeedRef.current) * 0.35;
          const vNow = emaSpeedRef.current;
          strokePeakSpeedRef.current = Math.max(strokePeakSpeedRef.current * 0.98, vNow);

          // Dynamic (drives width/opacity): stylus pressure, else velocity (slow->thick,
          // fast->thin), smoothed so it doesn't flicker segment-to-segment.
          let dyn: number;
          if (pressure > 0) {
            dyn = Math.pow(Math.min(1, pressure), 0.6);
          } else {
            const x = Math.min(1, vNow / 1.8); // VREF*2, VREF ~0.9 logical px/ms
            const fast = x * x * (3 - 2 * x);  // smoothstep
            dyn = 1 - 0.85 * fast;
          }
          emaPressureRef.current += (dyn - emaPressureRef.current) * 0.4;
          const dynamic = Math.max(0.12, Math.min(1, emaPressureRef.current));

          // Position stabilizer ("pulled string"): heavier at low speed to kill tremor.
          const spPrev = smoothedPosRef.current || pos;
          const alpha = Math.max(0.35, Math.min(0.9, 0.35 + 0.5 * Math.min(1, vNow / 0.5)));
          const stab = { x: spPrev.x + (pos.x - spPrev.x) * alpha, y: spPrev.y + (pos.y - spPrev.y) * alpha };
          smoothedPosRef.current = stab;

          // Feed the STABILIZED point through Chaikin midpoint smoothing.
          smoothBuffer.current.push({ x: stab.x, y: stab.y, t: now, pressure: dynamic });
          if (smoothBuffer.current.length > 6) smoothBuffer.current.shift();
          const pts = smoothBuffer.current;
          let fromPt: {x:number;y:number} = last;
          let toPt: {x:number;y:number} = stab;
          let ctrlPt: {x:number;y:number} | undefined;
          if (pts.length >= 3) {
            const a = pts[pts.length - 3]!, b = pts[pts.length - 2]!, c = pts[pts.length - 1]!;
            fromPt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            toPt = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
            ctrlPt = { x: b.x, y: b.y }; // real sample point = quadratic control between the two midpoints
          }
          drawLine(fromPt, toPt, dynamic, ctrlPt);
          if (onSegment) {
            // Feed the spectator the exact inputs the shared brush engine needs to reproduce
            // the real effect: preset, color, size, opacity, spacing + this segment's dynamic
            // and velocity (width/taper). The keyframe reconciles any random-texture drift.
            const op = Math.max(0, Math.min(1, typeof brushOpacity === 'number' ? brushOpacity : (brushPreset?.opacity ?? 1)));
            onSegment({
              from: fromPt, to: toPt, ctrl: ctrlPt || { x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2 },
              sid: strokeIdRef.current, erase: false, size: brushSize,
              preset: brushPreset, color: activeColor, opacity: op, spacing: brushSpacing, dynamic, velocity: emaSpeedRef.current,
            });
          }
        }
        lastPointRef.current = pos;
      }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'touch') { onTouchPointerUp(e); return; }
      // Liberar la captura del pointer (si no es touch)
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      
      // Clean up based on current action
      if (penActionRef.current === 'pan' && activePanPointerIdRef.current === e.pointerId) {
        panState.current = null;
        activePanPointerIdRef.current = null;
      } else if (penActionRef.current === 'draw' || penActionRef.current === 'erase') {
        if (activeDrawPointerIdRef.current === e.pointerId) {
          endStroke();
          activeDrawPointerIdRef.current = null;
        }
      }
      
      // Clear action only if the finishing pointer matches
      if (penActionRef.current && ((penActionRef.current === 'pan' && activePanPointerIdRef.current === null) || (penActionRef.current !== 'pan' && activeDrawPointerIdRef.current === null))) {
        penActionRef.current = null;
      }
    };

  // Eliminado bloqueo global; confiamos en touch-action local del canvas para evitar desplazamientos.

    return (
      <div
        ref={containerRef}
        className="canvas-shell inline-block"
        style={{ width: displaySize.w, height: displaySize.h }}
      >
        <div
          className="relative"
          style={{ width: displaySize.w * zoom, height: displaySize.h * zoom }}
        >
          {onionImage && (
            <img
              src={onionImage}
              alt="previous frame"
              className="absolute inset-0 pointer-events-none canvas-paper"
              style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: 1 }}
            />
          )}
          <canvas
            ref={canvasRef}
            className={`${disabled ? (spectating ? 'cursor-default' : 'opacity-50 cursor-not-allowed') : 'cursor-crosshair'} absolute inset-0 canvas-paper sketch-outline select-none transition-opacity`}
            data-drawing={isDrawing ? 'true' : 'false'}
            style={{
              width: '100%',
              height: '100%',
              touchAction: 'none',
              opacity: onionImage ? (1 - Math.max(0, Math.min(1, onionOpacity))) : 1
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* Live spectator overlay: the artist's in-progress frame, painted fully on top
              and refreshed reactively as new snapshots arrive. */}
          {liveImage && (
            <img
              src={liveImage}
              alt="live drawing"
              className="absolute inset-0 pointer-events-none canvas-paper sketch-outline"
              style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: 1 }}
            />
          )}
        </div>
        {disabled && !spectating && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <p className="text-sm font-semibold" style={{ color: '#111' }}>Inicia sesión para dibujar</p>
          </div>
        )}
        {spectating && (
          <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 text-white text-[11px] font-bold pointer-events-none select-none">
            <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
            <span className="truncate max-w-[160px]">LIVE{liveLabel ? ` · u/${liveLabel}` : ''}</span>
          </div>
        )}
      </div>
    );
  }
);