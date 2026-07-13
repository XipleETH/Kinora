import React, { useEffect, useRef } from 'react';
import type { BrushPreset } from '../brushes';

// Renders a small, representative sample stroke for a brush preset so voters can see
// how each brush paints (character), not just its name. Not the exact drawing engine —
// a faithful stylized approximation per engine type.

export const BrushPreview: React.FC<{ preset: BrushPreset; color?: string; width?: number; height?: number }> = ({
  preset, color = '#1b1b1b', width = 104, height = 42,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const SS = 2;
    // Guard against a non-finite/zero size prop (e.g. a transient 0 from a responsive
    // container) — several gradient radii derive from H and would throw on 0/NaN.
    const W = Number.isFinite(width) && width > 0 ? width : 104;
    const H = Number.isFinite(height) && height > 0 ? height : 42;
    canvas.width = W * SS; canvas.height = H * SS;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(SS, SS);
    ctx.clearRect(0, 0, W, H); // transparent — blends with the card behind it
    drawSample(ctx, preset, color, W, H);
  }, [preset, color, width, height]);
  return <canvas ref={ref} style={{ width, height, borderRadius: 6, display: 'block' }} />;
};

// Deterministic-ish PRNG so previews are stable between renders.
function makeRng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

// Parse a #rrggbb / #rgb color into [r,g,b]; falls back to near-black on anything odd.
function parseRgb(color: string): [number, number, number] {
  const s = color.trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) { const n = parseInt(m[1]!, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16)];
  }
  return [27, 27, 27];
}

function drawSample(ctx: CanvasRenderingContext2D, preset: BrushPreset, color: string, W: number, H: number) {
  const rng = makeRng((preset.id || 'x').split('').reduce((s, c) => (s * 31 + c.charCodeAt(0)) | 0, 7));
  const cy = H / 2;
  const pts: { x: number; y: number }[] = [];
  const N = 44;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = 8 + t * (W - 16);
    const y = cy + Math.sin(t * Math.PI * 2) * (H * 0.16);
    pts.push({ x, y });
  }
  const size = Math.max(2, Math.min(H * 0.5, (preset.size || 8) * 0.45));
  const op = preset.opacity ?? 1;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const engine = preset.engine;
  const texture = preset.texture;

  const [cr, cg, cb] = parseRgb(color);
  const rgb = `${cr},${cg},${cb}`;

  const softDot = (x: number, y: number, r: number, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = a; ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };

  // ── Texture-driven presets that share an engine but must look distinct ──────────
  if (engine === 'mangaPen' && texture === 'marker') {
    // Marker: CONSTANT width, 3 semi-opaque passes offset along the normal, slight
    // perpendicular jitter. Overlap builds a denser core with lighter, banded edges.
    ctx.strokeStyle = color;
    const w = Math.max(1.5, size * 0.9);
    const passes = 3;
    for (let p = 0; p < passes; p++) {
      const offN = ((p - (passes - 1) / 2) / passes) * (w * 0.5); // -w/6, 0, +w/6
      ctx.globalAlpha = op * (0.5 + 0.22 * rng());  // translucent; overlaps accumulate
      ctx.lineWidth = w * (0.92 + rng() * 0.1);     // near-constant width, no taper
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)]!;
        const b = pts[Math.min(pts.length - 1, i + 1)]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;        // per-point normal
        const jit = (rng() - 0.5) * 0.8;            // slight perpendicular jitter
        const x = pts[i]!.x + nx * (offN + jit);
        const y = pts[i]!.y + ny * (offN + jit);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (texture === 'charcoal') {
    // Charcoal (engine 'pencil'): dense grain cloud, central-density falloff (dark
    // core, soft rim), larger grains than pencil, occasional soft halo splotches.
    ctx.fillStyle = color;
    const spread = size * 1.15;
    for (const p of pts) {
      const grains = 13 + Math.floor(rng() * 6); // ~2x pencil density
      for (let k = 0; k < grains; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = spread * Math.sqrt(rng());       // area-uniform disc sampling
        const gx = p.x + Math.cos(ang) * rad;
        const gy = p.y + Math.sin(ang) * rad * 0.85; // slight vertical flattening
        const edge = rad / spread;
        const falloff = 1 - edge * edge;             // dark core -> soft rim
        ctx.globalAlpha = Math.min(1, op * (0.22 + 0.5 * rng()) * falloff + 0.04);
        const dotR = 0.5 + rng() * (size * 0.26);    // larger grains than pencil
        ctx.beginPath(); ctx.arc(gx, gy, dotR, 0, Math.PI * 2); ctx.fill();
        if (rng() < 0.06) {
          softDot(gx, gy, dotR * (2.5 + rng() * 2), op * 0.2 * falloff);
          ctx.fillStyle = color; // softDot set a gradient fill — restore solid for grains
        }
      }
    }
  // ── Engine branches ─────────────────────────────────────────────────────────────
  } else if (engine === 'mangaPen') {
    // Clean smooth tapered ink line: quadratic through midpoints (matches the engine's
    // quadraticCurveTo), round caps, velocity-driven width (slow=thick, fast=thin) via
    // local curve speed, plus a thin ramp at both ends.
    ctx.strokeStyle = color;
    const last = pts.length - 1;
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const spd = (i: number) => {
      const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(last, i + 1)]!;
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    let sMin = Infinity, sMax = 0;
    for (let i = 0; i <= last; i++) { const s = spd(i); if (s < sMin) sMin = s; if (s > sMax) sMax = s; }
    const sRange = Math.max(1e-3, sMax - sMin);
    ctx.globalAlpha = op;
    for (let i = 1; i < last; i++) {
      const t = i / last;
      const ends = Math.min(1, Math.min(t, 1 - t) / 0.16);   // thin ramp at both ends
      const slow = 1 - (spd(i) - sMin) / sRange;              // 1 = slowest -> thickest
      ctx.lineWidth = Math.max(0.6, size * (0.7 + 0.3 * slow) * (0.35 + 0.65 * ends));
      const a = mid(pts[i - 1]!, pts[i]!), b = mid(pts[i]!, pts[i + 1]!);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, b.x, b.y); // genuine smooth curve
      ctx.stroke();
    }
  } else if (engine === 'pencil') {
    // Per-step cloud of hard grain dots in an X-compressed disk (rad = size·sqrt(rand)
    // -> even area density; x scaled 0.6 -> vertical grain oval), low variable alpha,
    // dot radius scaling with brush size.
    ctx.fillStyle = color;
    for (const p of pts) {
      for (let k = 0; k < 8; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = size * 0.9 * Math.sqrt(rng());        // even-density disk
        const jx = Math.cos(ang) * rad * 0.6;             // X-compressed -> vertical oval
        const jy = Math.sin(ang) * rad;
        ctx.globalAlpha = op * (0.2 + rng() * 0.45);      // low, variable per grain
        const dotR = Math.max(0.35, size * 0.1 + rng() * size * 0.18); // scales with size
        ctx.beginPath(); ctx.arc(p.x + jx, p.y + jy, dotR, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (engine === 'wash') {
    // Watercolor wash: layered translucent blooms with a DARKER EDGE RIM (edgeCol),
    // a darker edge ring, granulation speckles and a faint outward bleed halo.
    const edgeDarken = preset.edgeDarken ?? 0.65;
    const f = 1 - 0.45 * edgeDarken;
    const edgeCol = `rgb(${Math.round(cr * f)},${Math.round(cg * f)},${Math.round(cb * f)})`;
    for (let i = 0; i < pts.length; i += 5) {
      const p = pts[i]!;
      const r = Math.max(0.5, Math.min(H * 0.4, size * (0.9 + rng() * 0.35)));
      // 1) Faint outward bleed halo (underneath, soft feather).
      ctx.globalAlpha = op * 0.08; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.35, 0, Math.PI * 2); ctx.fill();
      // 2) Layered bloom: inner light pigment -> darker pooled rim at ~0.94.
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, color); g.addColorStop(0.72, color);
      g.addColorStop(0.94, edgeCol); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = op * (0.3 + rng() * 0.15); ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      // 3) Darker edge stroke ring (pooled pigment rim).
      ctx.globalAlpha = op * 0.5; ctx.strokeStyle = edgeCol;
      ctx.lineWidth = Math.max(0.5, r * 0.08);
      ctx.beginPath(); ctx.arc(p.x, p.y, r * (0.9 + 0.05 * rng()), 0, Math.PI * 2); ctx.stroke();
      // 4) Granulation speckles.
      ctx.fillStyle = edgeCol;
      for (let s = 0; s < 4; s++) {
        const ang = rng() * Math.PI * 2, rad = rng() * r * 0.85;
        ctx.globalAlpha = op * (0.2 + rng() * 0.25);
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(ang) * rad, p.y + Math.sin(ang) * rad, 0.5 + rng() * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (engine === 'acrylic') {
    // Bristle band: eased-clustered filaments (fat center, wispy edges) + occasional
    // white impasto highlight ridges for the wet-paint sparkle.
    ctx.strokeStyle = color;
    const bristles = 8;
    for (let b = 0; b < bristles; b++) {
      const tb = b / (bristles - 1) - 0.5;                       // -0.5..0.5
      const off = Math.sin(tb * Math.PI) * (size * 0.6);          // clusters toward center
      const centerFactor = Math.max(0.15, 1 - Math.abs(tb) * 1.8); // center fat, edges wispy
      const jit = (rng() - 0.5) * 1.0;
      ctx.globalAlpha = op * (0.55 + rng() * 0.4);
      ctx.lineWidth = 0.7 + size * 0.5 * centerFactor;
      ctx.beginPath();
      pts.forEach((p, i) => { const m = i === 0 ? 'moveTo' : 'lineTo'; (ctx as any)[m](p.x, p.y + off + jit + (rng() - 0.5) * 1.2); });
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let k = 2; k < pts.length; k += 4) {
      if (rng() < 0.45) {
        const p = pts[k]!;
        const hoff = Math.sin((rng() - 0.5) * Math.PI) * (size * 0.3);
        ctx.globalAlpha = op * (0.3 + rng() * 0.35);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + hoff, 1.3 + rng() * 1.0, 0.5 + rng() * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (engine === 'airbrush') {
    // Overlapping soft radial dabs -> a mottled, feathered cloud with flow-based low
    // alpha. Core dab + scattered satellite build spread & grain.
    const flow = op;
    for (const p of pts) {
      for (let k = 0; k < 2; k++) {
        const scatterAmt = k === 0 ? size * 0.35 : size * 1.15; // core tight, satellite feathers
        const ox = (rng() - 0.5) * scatterAmt;
        const oy = (rng() - 0.5) * scatterAmt;
        const r = size * (0.85 + rng() * 0.6);                  // per-dab size jitter
        const a = flow * (0.07 + rng() * 0.11);                 // low, per-dab flow-based alpha
        softDot(p.x + ox, p.y + oy, r, a);
      }
    }
  } else if (engine === 'spray') {
    // Crisp fine particle cloud; radii pulled from preset so Drip reads chunkier than
    // Fine, and preset.drip adds occasional downward graffiti streaks.
    ctx.fillStyle = color;
    const [pMin, pMax] = (preset.particleSize as [number, number]) || [0.8, 2.2];
    const per = preset.drip ? 12 : 9;
    for (const p of pts) {
      for (let k = 0; k < per; k++) {
        const a = rng() * Math.PI * 2, r = rng() * size * 1.2; // uniform-in-radius -> center-weighted
        const px = p.x + Math.cos(a) * r, py = p.y + Math.sin(a) * r;
        const pr = Math.max(0.3, (pMin + rng() * (pMax - pMin)) * 0.55);
        ctx.globalAlpha = op * (0.35 + rng() * 0.55);
        ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (preset.drip) {
      ctx.strokeStyle = color; ctx.lineCap = 'round';
      const drips = 3 + Math.floor(rng() * 3);
      for (let d = 0; d < drips; d++) {
        const p = pts[Math.floor(rng() * pts.length)]!;
        const sx = p.x + (rng() - 0.5) * size * 0.7;
        const sy = p.y + rng() * size * 0.3;
        const len = Math.min(H - sy - 2, size * (0.9 + rng() * 1.3));
        if (len <= 2) continue;
        const pr = pMin + rng() * (pMax - pMin);
        const ex = sx + (rng() - 0.5) * 1.5, ey = sy + len;
        ctx.globalAlpha = op * (0.55 + rng() * 0.35);
        ctx.lineWidth = Math.max(0.6, pr * 0.7);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.globalAlpha = op * 0.6; // running bead at the drip tail
        ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.8, pr * 0.85), 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (engine === 'splatter') {
    // A few large, hard-edged, sparse blobs: solid discs with a real minimum size (no
    // speckle dust), occasionally genuinely big, scattered off the centerline.
    ctx.fillStyle = color;
    const blobs = 8;
    const scat = size * 0.75;
    for (let k = 0; k < blobs; k++) {
      const p = pts[Math.floor(rng() * pts.length)]!;
      const bx = p.x + (rng() - 0.5) * scat * 2;
      const by = p.y + (rng() - 0.5) * scat * 1.4;
      const r = size * (0.18 + rng() * 0.5); // floored min, occasional BIG blob
      ctx.globalAlpha = op * (0.5 + rng() * 0.5);
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
    }
  } else if (engine === 'smudge') {
    // Soft feathered smear BAND: overlapping radial dabs with a solid inner core that
    // fades to a SAME-COLOR transparent rim (no dark halo), so edges read as blurred.
    const dab = (x: number, y: number, r: number, a: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},1)`);
      g.addColorStop(0.55, `rgba(${rgb},1)`); // solid core like the engine
      g.addColorStop(1, `rgba(${rgb},0)`);    // same-color feathered rim
      ctx.globalAlpha = a; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    };
    const rad = size * 1.05;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const drift = (rng() - 0.5) * size * 0.3; // cross-path drift -> dragged feel
      dab(p.x, p.y + drift, rad * (0.85 + rng() * 0.3), op * 0.5 * (0.6 + rng() * 0.4));
    }
  } else if (engine === 'calligraphy') {
    // Flat chisel nib = a stream of FIXED-ANGLE ellipse stamps (translate -> rotate ->
    // ellipse rx=w, ry=w*roundness). Overlap makes the ribbon thin ALONG the nib angle
    // and broad ACROSS it, with angled chisel edges + subtle jitter.
    const nib = (preset.angle ?? 30) * Math.PI / 180;
    const round = Math.max(0.12, Math.min(1, preset.roundness ?? 0.28));
    const rx = size * 0.95;        // broad half-width
    const ry = rx * round;         // thin half-width (defined, not a hairline)
    const aJit = (preset.angleJitter ?? 0) * Math.PI * 0.5;
    ctx.fillStyle = color;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const w = rx * (0.88 + rng() * 0.24);      // subtle size jitter
      const h = ry * (0.85 + rng() * 0.30);
      const a = nib + (rng() - 0.5) * aJit;      // slight angle wobble
      ctx.globalAlpha = op * (0.9 + rng() * 0.1);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } else if (engine === 'glow') {
    // Additive luminous halo + a thin bright defined core — mirrors the engine's
    // 'lighter' composite: stacked soft dabs plus a hot ~0.18*size centre line.
    const prevComp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of pts) {
      softDot(p.x, p.y, size * (1.5 + rng() * 0.5), op * (0.14 + rng() * 0.12));
      softDot(p.x, p.y, size * (0.7 + rng() * 0.3), op * (0.22 + rng() * 0.12));
    }
    ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const stroke = () => { ctx.beginPath(); pts.forEach((p, i) => { const m = i === 0 ? 'moveTo' : 'lineTo'; (ctx as any)[m](p.x, p.y); }); ctx.stroke(); };
    ctx.globalAlpha = Math.min(1, op * 1.2 + 0.15); // soft under-glow around the core
    ctx.lineWidth = Math.max(1.5, size * 0.34); stroke();
    ctx.globalAlpha = Math.min(1, op * 2.2 + 0.35); // crisp hot filament (~0.18*size)
    ctx.lineWidth = Math.max(1, size * 0.18); stroke();
    ctx.globalCompositeOperation = prevComp;
  } else if (engine === 'pixel') {
    // Hard blocky axis-aligned squares snapped to a pixel grid. Dense overlap in the
    // engine -> a CONNECTED chunky ribbon (fill the full cell, no mortar gap), with a
    // subtle per-stamp opacity flicker.
    ctx.fillStyle = color;
    const px = Math.max(3, size * 0.8);
    const seen = new Set<string>();
    for (const p of pts) {
      const gx = Math.round(p.x / px) * px, gy = Math.round(p.y / px) * px;
      const key = gx + ',' + gy; if (seen.has(key)) continue; seen.add(key);
      ctx.globalAlpha = op * (0.8 + 0.2 * rng()); // per-block flicker
      ctx.fillRect(gx - px / 2, gy - px / 2, px, px); // full cell -> connected staircase
    }
  } else if (engine === 'multi') {
    // Stamps are VECTOR shapes (unicode falls through to a 5-point star), each randomly
    // rotated + size/opacity varied + scattered off the path.
    const stamps = (preset.stamps && preset.stamps.length) ? preset.stamps : ['star'];
    const sizeJit = preset.sizeJitter ?? 0.5;
    const opJit = preset.opacityJitter ?? 0;
    const scat = Math.min(6, (preset.scatter ?? 0) * 0.22); // tame full-canvas scatter for swatch
    ctx.fillStyle = color;
    const drawStar = (R: number) => {
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
        if (k === 0) ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
        else ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        const a2 = a + Math.PI / 5;
        ctx.lineTo(Math.cos(a2) * R * 0.375, Math.sin(a2) * R * 0.375); // inner 6/16
      }
      ctx.closePath(); ctx.fill();
    };
    const drawLeaf = (R: number) => {
      ctx.beginPath();
      ctx.moveTo(0, -R);
      ctx.quadraticCurveTo(R * 0.88, -R * 0.25, 0, R);
      ctx.quadraticCurveTo(-R * 0.88, -R * 0.25, 0, -R);
      ctx.fill();
    };
    for (let i = 2; i < pts.length; i += 6) { // ~7 stamps, authentic overlap without going muddy
      const p = pts[i]!;
      const stamp = stamps[Math.floor(rng() * stamps.length)]!;
      const R = size * (0.5 + rng() * 0.45 * (1 + sizeJit));
      ctx.save();
      ctx.translate(p.x + (rng() - 0.5) * scat, p.y + (rng() - 0.5) * scat);
      ctx.rotate(rng() * Math.PI * 2);
      ctx.globalAlpha = op * (0.7 + 0.3 * rng() * (1 - opJit));
      if (stamp === 'dot') { ctx.beginPath(); ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2); ctx.fill(); }
      else if (stamp === 'leaf' || stamp === 'leaf2') drawLeaf(R);
      else drawStar(R); // ★ ✦ ✧ and any glyph -> vector star, exactly like the engine
      ctx.restore();
    }
  } else {
    // generic stroke fallback
    ctx.strokeStyle = color; ctx.globalAlpha = op; ctx.lineWidth = size;
    ctx.beginPath(); pts.forEach((p, i) => { const m = i === 0 ? 'moveTo' : 'lineTo'; (ctx as any)[m](p.x, p.y); }); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}