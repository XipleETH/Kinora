// Shared brush rendering engine. The per-engine stroke renderer was extracted verbatim
// from Canvas.tsx so BOTH the artist (Canvas) and the live spectator (SpectatorCanvas)
// render the EXACT same brush effects. Canvas-agnostic (takes a ctx); the only state is
// the caller-owned progress accumulator (progressRef.current = accumulated stroke length).
// Random-textured engines (spray/charcoal/etc.) will not be pixel-identical across clients
// but produce the correct effect; the periodic keyframe reconciles the exact pixels.
import type { BrushPreset } from './brushes';

export const LOGICAL_W = 360;
export const LOGICAL_H = 640;
export const SUPERSAMPLE = 2;

export function paintSegment(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  control: { x: number; y: number } | undefined,
  preset: BrushPreset | undefined,
  color: string,
  brushSize: number,
  brushOpacity: number | undefined,
  brushSpacing: number | undefined,
  pressure: number,
  velocity: number,
  progressRef: { current: number },
): void {
      // Resolve preset params with sensible defaults
  const baseOpacity = Math.max(0, Math.min(1, preset?.opacity ?? 1));
  const opacityMul = Math.max(0, Math.min(1, (typeof brushOpacity === 'number' ? brushOpacity : baseOpacity)));
  const jitter = Math.max(0, Math.min(1, preset?.jitter ?? 0.02));
  const taper = Math.max(0, Math.min(1, preset?.taper ?? 0.6)); // legacy single end taper factor
  const taperStartEnabled = (preset?.taperStart ?? (preset?.taperStart === 0 ? 0 : undefined)) !== undefined ? (preset?.taperStart ?? 0) > 0 : true; // default ON if dual not specified
  const taperEndEnabled = (preset?.taperEnd ?? (preset?.taperEnd === 0 ? 0 : undefined)) !== undefined ? (preset?.taperEnd ?? 0) > 0 : true;   // default ON
  const taperStartFactorCfg = Math.max(0, Math.min(1, preset?.taperStart ?? 1));
  const taperEndFactorCfg   = Math.max(0, Math.min(1, preset?.taperEnd ?? 1));
  const taperStartLen = Math.max(4, preset?.taperStartLength ?? 24);
  const taperEndLen   = Math.max(4, preset?.taperEndLength ?? 28);
  const engine = preset?.engine;
  const flow = Math.max(0, Math.min(1, preset?.flow ?? opacityMul));
  const spacing = Math.max(0.5, (typeof brushSpacing === 'number' ? brushSpacing : (preset?.spacing ?? 2)));
  const scatter = Math.max(0, preset?.scatter ?? 0);
  const sizeJitter = Math.max(0, Math.min(1, preset?.sizeJitter ?? 0));
  const opacityJitter = Math.max(0, Math.min(1, preset?.opacityJitter ?? 0));
  const roundness = Math.max(0.05, Math.min(1, preset?.roundness ?? 1));
  const angleDeg = preset?.angle ?? 0;
  const angleJitter = Math.max(0, Math.min(1, preset?.angleJitter ?? 0));
  const blendMode = preset?.blendMode || 'normal';
  const smudgeStrength = Math.max(0, Math.min(1, preset?.smudgeStrength ?? 0.5));
  // Simulación de presión: si device no da pressure, usamos velocidad inversa
  // Usar siempre el valor dinámico del slider (brushSize) como autoridad.
  // El tamaño del preset solo sirve como valor inicial cuando se selecciona (SidePanels ya hace setBrushSize(p.size)).
  const baseSize = brushSize; // antes: preset?.size || brushSize (causaba que el slider no tuviera efecto cuando había preset)
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  // Hard cap on substeps so a single fast/long segment can't explode into thousands of
  // dabs (perf + keeps dab density bounded regardless of stroke speed).
  const MAX_STEPS = 96;
  // `pressure` is ALREADY the smoothed, device-independent dynamic computed in
  // handlePointerMove (or a tap value). Velocity comes from the shared EMA ref (px/ms).
  const v = velocity;
  const simulatedPressure = Math.max(0.12, Math.min(1, pressure > 0 ? pressure : 1));
  const progress = progressRef.current;
  // Gentler length-based falloff (before: any long stroke lost up to `taper` of its width).
  const classicTaper = 1 - taper * 0.5 * Math.min(1, progress / (260 + baseSize * 16));
  const startRamp = taperStartEnabled ? (0.2 + 0.8 * Math.min(1, progress / taperStartLen)) : 1;
  const startFactor = 1 - (1 - startRamp) * taperStartFactorCfg;
  // End taper fires only near a GENUINE slow-down (velocity in px/ms), so steady drawing
  // keeps a consistent width instead of thinning everywhere.
  let endFactor = 1;
  if (taperEndEnabled && progress > taperEndLen) {
    const slow = Math.min(1, Math.max(0, (0.14 - v) / 0.14)); // 0 moving .. 1 near still
    endFactor = Math.max(0.15, 1 - slow * 0.85 * taperEndFactorCfg);
  }
  const dualTaper = Math.min(startFactor, endFactor);
  const taperFactor = Math.min(classicTaper, dualTaper);

      // Helper para jitter mínimo orgánico
      const jitterPoint = (pt: {x:number;y:number}) => {
        if (jitter <= 0) return pt;
        const r = baseSize * jitter;
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * r;
        return { x: pt.x + Math.cos(a) * d, y: pt.y + Math.sin(a) * d };
      };
  if (engine === 'pencil') {
        // Lápiz: múltiples micro trazos puntuales dentro de un óvalo con textura aleatoria
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(dist / Math.max(1, baseSize * 0.35))));
        const dirX = (to.x - from.x) / steps;
        const dirY = (to.y - from.y) / steps;
        const grainCountBase = 4 + Math.floor(baseSize * 0.6);
        const localOpacity = opacityMul * 0.9;
        for (let i = 0; i <= steps; i++) {
          const cx = from.x + dirX * i;
          const cy = from.y + dirY * i;
          const grains = grainCountBase + Math.floor(Math.random() * 3);
          for (let g = 0; g < grains; g++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = (baseSize * 0.5) * Math.sqrt(Math.random());
            const gx = cx + Math.cos(ang) * rad * 0.6;
            const gy = cy + Math.sin(ang) * rad;
            const a = localOpacity * (0.25 + Math.random() * 0.55) * (pressure || simulatedPressure);
            ctx.globalAlpha = Math.min(1, a);
            const dotR = Math.max(0.4, baseSize * 0.08 + Math.random() * (baseSize * 0.15));
            ctx.beginPath();
            ctx.fillStyle = color;
            ctx.arc(gx, gy, dotR, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      }
      else if (engine === 'acrylic') {
        // Enhanced acrylic: simulate multiple bristles leaving semi‑opaque paint with subtle grooves.
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / Math.max(1, baseSize * 0.6))));
        const dirX = (to.x - from.x) / steps;
        const dirY = (to.y - from.y) / steps;
        const dirLen = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const nx = -dirY / (dirLen/steps || 1); // local normal approx (not normalized strictly but fine for offset)
        const ny = dirX / (dirLen/steps || 1);
        const bristles = Math.max(4, Math.min(64, Math.floor((preset?.bristleCount ?? 18))));
        const bristleSpread = Math.max(0.2, (preset?.roundness ?? 0.7));
        const bristleJitter = Math.max(0, Math.min(1, preset?.bristleJitter ?? 0.4));
        const wetness = Math.max(0, Math.min(1, preset?.wetness ?? 0.35));
        const impasto = Math.max(0, Math.min(1, preset?.impasto ?? 0.4));
        const texNoise = Math.max(0, Math.min(1, preset?.strokeTextureNoise ?? 0.5));
        // Precompute per‑bristle offset
        const offsets: number[] = [];
        for (let b = 0; b < bristles; b++) {
          const t = (b / (bristles - 1)) - 0.5; // -0.5..0.5
          // Distribute wider near center (ease)
            const eased = Math.sin(t * Math.PI);
          const spread = (baseSize * 0.6) * bristleSpread * eased;
          const jitterOff = (Math.random() - 0.5) * baseSize * 0.15 * bristleJitter;
          offsets.push(spread + jitterOff);
        }
        // Paint along small substeps to create continuous fill
        for (let s = 0; s <= steps; s++) {
          const cx = from.x + dirX * s;
          const cy = from.y + dirY * s;
          // Sample underlying color for wet blend if enabled
          let blendR = 0, blendG = 0, blendB = 0;
          if (wetness > 0 && s % 2 === 0) {
            try {
              const img = ctx.getImageData(Math.round((cx - 1) * SUPERSAMPLE), Math.round((cy - 1) * SUPERSAMPLE), 2 * SUPERSAMPLE, 2 * SUPERSAMPLE);
              const d = img.data; let c = 0;
              for (let i = 0; i < d.length; i += 4) { blendR += d[i]; blendG += d[i+1]; blendB += d[i+2]; c++; }
              if (c) { blendR/=c; blendG/=c; blendB/=c; }
            } catch {}
          }
          for (let b = 0; b < bristles; b++) {
            const off = offsets[b];
            const ox = cx + nx * off + (Math.random() - 0.5) * texNoise * 0.6;
            const oy = cy + ny * off + (Math.random() - 0.5) * texNoise * 0.6;
            // Local thickness varies with simulated pressure and bristle index
            const centerFactor = 1 - Math.abs((b / (bristles - 1)) - 0.5) * 1.8;
            const thickness = Math.max(0.4, baseSize * 0.12 + baseSize * 0.55 * simulatedPressure * centerFactor);
            // Blend toward picked background if wetness >0
            let col = color;
            if (wetness > 0 && (blendR + blendG + blendB) > 0) {
              const sr = parseInt(color.slice(1,3),16);
              const sg = parseInt(color.slice(3,5),16);
              const sb = parseInt(color.slice(5,7),16);
              const mix = wetness * 0.55;
              const rr = Math.round(sr*(1-mix) + blendR*mix);
              const rg = Math.round(sg*(1-mix) + blendG*mix);
              const rb = Math.round(sb*(1-mix) + blendB*mix);
              col = `rgb(${rr},${rg},${rb})`;
            }
            ctx.globalAlpha = opacityMul * (0.85 + 0.15 * Math.random());
            ctx.fillStyle = col;
            ctx.beginPath();
            // Slight elongated ellipse / rectangle dab
            ctx.ellipse(ox, oy, thickness * (0.6 + Math.random()*0.4), thickness * (0.35 + Math.random()*0.4), 0, 0, Math.PI*2);
            ctx.fill();
            // Impasto highlight: small lighter ridge randomly for subset of bristles
            if (impasto > 0 && Math.random() < 0.08) {
              ctx.globalAlpha = opacityMul * impasto * 0.6;
              ctx.fillStyle = 'rgba(255,255,255,0.9)';
              ctx.beginPath();
              ctx.ellipse(ox + thickness*0.1, oy - thickness*0.1, thickness*0.3, thickness*0.18, 0, 0, Math.PI*2);
              ctx.fill();
            }
          }
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      }
      // Estilo manga (entintado): trazos vectoriales suavizados a partir de puntos bufferizados
  // Charcoal texture: treat for charcoal preset regardless of engine (supports legacy pencil)
  if (preset?.texture === 'charcoal') {
        // Carbón: múltiples manchas/granos con opacidad variable, halo suave y acumulación rápida
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(dist / Math.max(1, baseSize * 0.45))));
        const dirX = (to.x - from.x) / steps;
        const dirY = (to.y - from.y) / steps;
        const grainCountBase = 10 + Math.floor(baseSize * 1.1);
        for (let i = 0; i <= steps; i++) {
          const cx = from.x + dirX * i;
          const cy = from.y + dirY * i;
          const grains = grainCountBase + Math.floor(Math.random() * 6);
          for (let g = 0; g < grains; g++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = (baseSize * 0.65) * Math.sqrt(Math.random());
            const gx = cx + Math.cos(ang) * rad;
            const gy = cy + Math.sin(ang) * rad * 0.85;
            // Densidad central mayor; bordes más suaves
            const edge = rad / (baseSize * 0.65);
            const falloff = 1 - edge * edge;
            const a = (preset?.opacity ?? 0.65) * (0.18 + 0.55 * Math.random()) * falloff;
            ctx.globalAlpha = Math.min(1, a);
            const dotR = Math.max(0.5, baseSize * 0.06 + Math.random() * (baseSize * 0.22));
            ctx.beginPath();
            ctx.fillStyle = color;
            ctx.arc(gx, gy, dotR, 0, Math.PI * 2);
            ctx.fill();
            // Halo suave: trazo semitransparente grande para cohesión
            if (Math.random() < 0.07) {
              ctx.globalAlpha = a * 0.25;
              ctx.beginPath();
              ctx.arc(gx, gy, dotR * (2 + Math.random() * 2), 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
  } else if (preset?.texture === 'marker' && engine === 'mangaPen') {
        // Simulación marcador: ancho constante, relleno múltiple de pasadas semi-opacas con leve ruido perpendicular
        const passes = 3;
        const width = Math.max(1, baseSize * 0.85);
        const dirX = to.x - from.x;
        const dirY = to.y - from.y;
        const len = Math.hypot(dirX, dirY) || 1;
        const nx = -dirY / len; // normal
        const ny = dirX / len;
        for (let p = 0; p < passes; p++) {
          const offset = ((p - (passes - 1) / 2) / (passes)) * (width * 0.5);
          ctx.globalAlpha = opacityMul * (0.55 + 0.25 * Math.random());
          ctx.strokeStyle = color;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = width * (0.92 + Math.random() * 0.1);
          ctx.beginPath();
          const jf = jitterPoint({ x: from.x + nx * offset, y: from.y + ny * offset });
          const jt = jitterPoint({ x: to.x + nx * offset, y: to.y + ny * offset });
          ctx.moveTo(jf.x, jf.y);
          ctx.lineTo(jt.x, jt.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'airbrush') {
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / spacing)));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * scatter * 0.3;
          const cy = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * scatter * 0.3;
          const jitterScale = 1 + (Math.random() * 2 - 1) * sizeJitter * 0.6;
          const r = Math.max(0.5, (baseSize * 0.4 + baseSize * 0.6 * simulatedPressure) * jitterScale * 0.5);
          ctx.globalAlpha = flow * (0.5 + 0.5 * Math.random());
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, color);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'wash') {
        // Watercolor wash: simulate semi-transparent blooms, diffusion & edge darkening.
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / (spacing * 0.6))));
        const diffusion = Math.max(0, Math.min(1, preset?.diffusion ?? 0.6));
        const bleed = Math.max(0, Math.min(1, preset?.bleed ?? 0.5));
        const granulation = Math.max(0, Math.min(1, preset?.granulation ?? 0.35));
        const edgeDarken = Math.max(0, Math.min(1, preset?.edgeDarken ?? 0.65));
        const wetness = Math.max(0, Math.min(1, preset?.wetness ?? 0.75));
        // Pre-darkened pigment for the outer ring — the signature watercolor edge pooling.
        const edgeCol = (() => {
          const m = /^#([0-9a-f]{6})$/i.exec(color);
          if (!m) return color;
          const n = parseInt(m[1]!, 16);
          const f = 1 - 0.45 * edgeDarken;
          return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`;
        })();
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = from.x + (to.x - from.x) * t;
          const cy = from.y + (to.y - from.y) * t;
          // Base radius grows with diffusion and simulated pressure
          const localPressure = simulatedPressure * (0.7 + 0.3 * Math.random());
          const baseR = baseSize * (0.8 + 0.6 * localPressure) * (0.6 + diffusion * 0.9);
          const layers = 2 + Math.floor(2 * diffusion); // multiple translucent blooms
          for (let L = 0; L < layers; L++) {
            const lr = baseR * (0.55 + 0.75 * (L / layers)) * (1 + (Math.random() - 0.5) * 0.15 * (1 + diffusion));
            const fade = 1 - L / (layers + 1);
            const alpha = opacityMul * wetness * (0.28 + 0.5 * fade) * (0.6 + Math.random() * 0.4);
            ctx.globalAlpha = alpha;
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, lr);
            // Inner lighter pigment -> outer darker edge pooling (real rim, not same hue).
            grad.addColorStop(0, color);
            const edgeAlpha = Math.min(1, alpha * (0.4 + 0.9 * edgeDarken));
            grad.addColorStop(0.72, color);
            grad.addColorStop(0.94, edgeCol);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(cx, cy, lr, 0, Math.PI * 2);
            ctx.fill();
            // Edge darken stroke subtle
            if (edgeDarken > 0.05) {
              ctx.globalAlpha = edgeAlpha * 0.6;
              ctx.strokeStyle = edgeCol;
              ctx.lineWidth = Math.max(0.5, lr * 0.07 * edgeDarken);
              ctx.beginPath();
              ctx.arc(cx, cy, lr * (0.92 + 0.05 * Math.random()), 0, Math.PI * 2);
              ctx.stroke();
            }
            // Granulation speckles
            if (granulation > 0.01) {
              const speckles = Math.floor(6 + lr * 0.6 * granulation);
              for (let s = 0; s < speckles; s++) {
                if (Math.random() > granulation) continue;
                const ang = Math.random() * Math.PI * 2;
                const rad = Math.random() * lr;
                const sx = cx + Math.cos(ang) * rad * (0.9 + 0.2 * Math.random());
                const sy = cy + Math.sin(ang) * rad * (0.9 + 0.2 * Math.random());
                const dotR = Math.max(0.4, baseSize * 0.08 * (0.5 + Math.random()));
                ctx.globalAlpha = alpha * 0.5 * (0.4 + 0.6 * Math.random());
                ctx.beginPath();
                ctx.fillStyle = color;
                ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
                ctx.fill();
              }
            }
            // Bleed feather: faint outward transparent halo
            if (bleed > 0.05) {
              const bleedR = lr * (1 + bleed * 0.6);
              ctx.globalAlpha = alpha * 0.25 * bleed;
              ctx.beginPath();
              ctx.arc(cx, cy, bleedR, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'spray') {
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / spacing)));
        const [pMin, pMax] = preset?.particleSize || [1, 3];
        const densityMul = preset?.density ?? 1;
        const basePresetSize = preset?.size || baseSize;
        const sizeScale = Math.max(0.2, Math.min(4, baseSize / basePresetSize));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const baseX = from.x + (to.x - from.x) * t;
          const baseY = from.y + (to.y - from.y) * t;
          const particles = Math.floor(6 + baseSize * 0.8 * densityMul);
          for (let k = 0; k < particles; k++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = Math.random() * scatter;
            const px = baseX + Math.cos(ang) * rad;
            const py = baseY + Math.sin(ang) * rad;
            const pr = (pMin + Math.random() * (pMax - pMin)) * sizeScale;
            ctx.globalAlpha = opacityMul * (0.4 + 0.6 * Math.random());
            ctx.beginPath();
            ctx.fillStyle = color;
            ctx.arc(px, py, pr, 0, Math.PI * 2);
            ctx.fill();
            if (preset?.drip && Math.random() < 0.01) {
              ctx.globalAlpha = opacityMul * 0.7;
              ctx.strokeStyle = color;
              ctx.lineWidth = pr * 0.6;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(px + (Math.random() - 0.5) * 2, py + pr * (2 + Math.random() * 6));
              ctx.stroke();
            }
          }
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'splatter') {
        const [pMin, pMax] = preset?.particleSize || [4, 16];
        const blobs = Math.floor(3 + (dist / 10) * (preset?.density ?? 1));
        const basePresetSize = preset?.size || baseSize;
        const sizeScale = Math.max(0.2, Math.min(4, baseSize / basePresetSize));
        for (let i = 0; i < blobs; i++) {
          const t = Math.random();
          const cx = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * scatter;
            const cy = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * scatter;
            const r = (pMin + Math.random() * (pMax - pMin)) * sizeScale;
            ctx.globalAlpha = opacityMul * (0.5 + 0.5 * Math.random());
            ctx.beginPath();
            ctx.fillStyle = color;
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'smudge') {
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(dist / spacing)));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = from.x + (to.x - from.x) * t;
          const y = from.y + (to.y - from.y) * t;
          const sampleSize = Math.max(2, baseSize * 0.5);
          try {
            const dev = Math.max(1, Math.round(sampleSize * SUPERSAMPLE));
            const img = ctx.getImageData(Math.max(0, Math.round((x - sampleSize / 2) * SUPERSAMPLE)), Math.max(0, Math.round((y - sampleSize / 2) * SUPERSAMPLE)), dev, dev);
            const d = img.data;
            let r = 0, g = 0, b = 0, c = 0;
            for (let p = 0; p < d.length; p += 4) { r += d[p]; g += d[p + 1]; b += d[p + 2]; c++; }
            if (c > 0) {
              r /= c; g /= c; b /= c;
              const sr = parseInt(color.slice(1, 3), 16);
              const sg = parseInt(color.slice(3, 5), 16);
              const sb = parseInt(color.slice(5, 7), 16);
              const cr = Math.round(sr * smudgeStrength + r * (1 - smudgeStrength));
              const cg = Math.round(sg * smudgeStrength + g * (1 - smudgeStrength));
              const cb = Math.round(sb * smudgeStrength + b * (1 - smudgeStrength));
              // Soft, feathered dab so the picked color blends outward instead of stamping a hard disc.
              const rad = baseSize * 0.55;
              const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
              gr.addColorStop(0, `rgb(${cr},${cg},${cb})`);
              gr.addColorStop(0.55, `rgb(${cr},${cg},${cb})`);
              gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
              ctx.globalAlpha = opacityMul * 0.8;
              ctx.fillStyle = gr;
              ctx.beginPath();
              ctx.arc(x, y, rad, 0, Math.PI * 2);
              ctx.fill();
            }
          } catch {}
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'calligraphy') {
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / spacing)));
        const baseAngle = (angleDeg * Math.PI) / 180;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = from.x + (to.x - from.x) * t;
          const cy = from.y + (to.y - from.y) * t;
          const pressureScaleLocal = simulatedPressure * (0.6 + 0.4 * Math.random());
          const w = baseSize * (1 + (Math.random() * 2 - 1) * sizeJitter * 0.4) * pressureScaleLocal;
          const h = w * roundness;
          const a = baseAngle + (Math.random() * 2 - 1) * angleJitter * Math.PI;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(a);
          ctx.globalAlpha = opacityMul * (0.8 + 0.2 * Math.random());
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'glow') {
        const prev = ctx.globalCompositeOperation;
        if (blendMode === 'add') ctx.globalCompositeOperation = 'lighter';
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / spacing)));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = from.x + (to.x - from.x) * t;
          const cy = from.y + (to.y - from.y) * t;
          const r = baseSize * (0.4 + 0.6 * simulatedPressure) * (0.7 + Math.random() * 0.3);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, color);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = opacityMul * (0.6 + 0.4 * Math.random());
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        // Bright solid core so the glow reads as a defined light line, not just a haze.
        ctx.globalAlpha = Math.min(1, opacityMul * 0.9);
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1, baseSize * (0.16 + 0.14 * simulatedPressure));
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        if (control) ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
        else ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = prev;
        progressRef.current += dist;
        return;
      } else if (engine === 'pixel') {
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / spacing)));
        const sizePx = Math.max(1, Math.round(baseSize * 0.4));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = Math.round(from.x + (to.x - from.x) * t);
          const cy = Math.round(from.y + (to.y - from.y) * t);
          const jitterScaleLocal = 1 + (Math.random() * 2 - 1) * sizeJitter * 0.5;
          const s = Math.max(1, Math.round(sizePx * jitterScaleLocal));
          ctx.globalAlpha = opacityMul * (0.8 + 0.2 * Math.random());
          ctx.fillStyle = color;
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else if (engine === 'multi') {
        const segLen = dist || 1;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.floor(segLen / spacing)));
        const stamps = preset?.stamps || ['★'];
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * scatter;
          const cy = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * scatter;
          const s = baseSize * (0.5 + Math.random() * 0.5 * (1 + sizeJitter));
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(Math.random() * Math.PI * 2);
          ctx.scale(s / 32, s / 32);
          ctx.globalAlpha = opacityMul * (0.7 + 0.3 * Math.random() * (1 - opacityJitter));
          ctx.fillStyle = color;
          const stamp = stamps[Math.floor(Math.random() * stamps.length)];
          if (stamp === 'leaf' || stamp === 'leaf2') {
            ctx.beginPath();
            ctx.moveTo(0, -16);
            ctx.quadraticCurveTo(14, -4, 0, 16);
            ctx.quadraticCurveTo(-14, -4, 0, -16);
            ctx.fill();
          } else if (stamp === 'dot') {
            ctx.beginPath();
            ctx.arc(0, 0, 8, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * Math.PI * 2;
              const r1 = 16;
              const x1 = Math.cos(a) * r1;
              const y1 = Math.sin(a) * r1;
              if (k === 0) ctx.moveTo(x1, y1); else ctx.lineTo(x1, y1);
              const a2 = a + Math.PI / 5;
              const r2 = 6;
              ctx.lineTo(Math.cos(a2) * r2, Math.sin(a2) * r2);
            }
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        progressRef.current += dist;
        return;
      } else {
        const p0 = jitterPoint(from);
        const p1 = jitterPoint(to);
        ctx.globalAlpha = opacityMul;
        ctx.strokeStyle = color;
        const pressureScale = simulatedPressure * taperFactor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(0.5, baseSize * 0.4 + baseSize * 0.6 * pressureScale);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        if (control) {
          // Quadratic through the buffer midpoints (control = the real sampled point) so the
          // inked line is a genuine smooth curve, not a chain of straight chords.
          ctx.quadraticCurveTo(control.x, control.y, p1.x, p1.y);
        } else {
          ctx.lineTo(p1.x, p1.y);
        }
        ctx.stroke();
        progressRef.current += dist;
        ctx.globalAlpha = 1;
      }
}
