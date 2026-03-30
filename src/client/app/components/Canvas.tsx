import React, { forwardRef, useRef, useEffect, useState } from 'react';
import type { BrushPreset } from '../brushes';

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
}

// Default fallback size (desktop)
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 640;

export const Canvas = forwardRef<HTMLCanvasElement, CanvasProps>(({
  activeColor, brushSize, brushSpacing, brushOpacity, isDrawing, setIsDrawing, disabled,
  brushPreset, tool = 'draw', onBeforeMutate, zoom: controlledZoom, onionImage, onionOpacity = 0.4, onDirty, restoreImage
}, ref) => {
  const internalRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = (ref as React.RefObject<HTMLCanvasElement>) || internalRef;
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const strokeProgressRef = useRef<number>(0); // distancia acumulada
  // Buffer para estabilización (line smoothing) tipo ventana móvil
  const smoothBuffer = useRef<Array<{x:number;y:number;t:number;pressure:number}>>([]);
  // Flag para evitar que el primer movimiento genere línea conectando con stroke previo
  const firstMoveRef = useRef<boolean>(false);
  // Guardamos la posición inicial para poder dibujar un "tap" como punto
  const strokeStartPosRef = useRef<{x:number;y:number}|null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Internal zoom state only used when no controlled zoom is supplied
  const [internalZoom] = useState(1);
  const zoom = controlledZoom ?? internalZoom;
  const penActionRef = useRef<'draw' | 'erase' | 'pan' | null>(null);
  const eraseRef = useRef(false);
  const activeDrawPointerIdRef = useRef<number | null>(null);
  const activePanPointerIdRef = useRef<number | null>(null);

    // Responsive size (full viewport on mobile)
    const [displaySize, setDisplaySize] = useState<{w:number;h:number}>({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
    const isMobile = () => window.innerWidth < 768;
    useEffect(() => {
      const update = () => {
        if (isMobile()) {
          // Use full visual viewport height if available (accounts for mobile URL bar)
          const vv = (window as any).visualViewport;
          const height = vv ? vv.height : window.innerHeight;
          setDisplaySize({ w: window.innerWidth, h: height });
        } else {
          setDisplaySize({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
        }
      };
      update();
      window.addEventListener('resize', update);
      if ((window as any).visualViewport) {
        (window as any).visualViewport.addEventListener('resize', update);
      }
      return () => {
        window.removeEventListener('resize', update);
        if ((window as any).visualViewport) {
          (window as any).visualViewport.removeEventListener('resize', update);
        }
      };
    }, []);

    // Initialize & resize canvas backing store when displaySize changes (only once content empty)
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1); // cap dpr for memory
      const logicalW = displaySize.w;
      const logicalH = displaySize.h;
      // Resize backing store; this clears content
      canvas.width = Math.round(logicalW * dpr);
      canvas.height = Math.round(logicalH * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1,0,0,1,0,0);
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, logicalW, logicalH);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }, [displaySize.w, displaySize.h]);

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

  const drawLine = (from: { x: number; y: number }, to: { x: number; y: number }, pressure: number) => {
      const canvas = canvasRef.current;
      if (!canvas || disabled) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // Resolve preset params with sensible defaults
  const baseOpacity = Math.max(0, Math.min(1, brushPreset?.opacity ?? 1));
  const opacityMul = Math.max(0, Math.min(1, (typeof brushOpacity === 'number' ? brushOpacity : baseOpacity)));
  const jitter = Math.max(0, Math.min(1, brushPreset?.jitter ?? 0.02));
  const taper = Math.max(0, Math.min(1, brushPreset?.taper ?? 0.6)); // legacy single end taper factor
  const taperStartEnabled = (brushPreset?.taperStart ?? (brushPreset?.taperStart === 0 ? 0 : undefined)) !== undefined ? (brushPreset?.taperStart ?? 0) > 0 : true; // default ON if dual not specified
  const taperEndEnabled = (brushPreset?.taperEnd ?? (brushPreset?.taperEnd === 0 ? 0 : undefined)) !== undefined ? (brushPreset?.taperEnd ?? 0) > 0 : true;   // default ON
  const taperStartFactorCfg = Math.max(0, Math.min(1, brushPreset?.taperStart ?? 1));
  const taperEndFactorCfg   = Math.max(0, Math.min(1, brushPreset?.taperEnd ?? 1));
  const taperStartLen = Math.max(4, brushPreset?.taperStartLength ?? 24);
  const taperEndLen   = Math.max(4, brushPreset?.taperEndLength ?? 28);
  const engine = brushPreset?.engine;
  const flow = Math.max(0, Math.min(1, brushPreset?.flow ?? opacityMul));
  const spacing = Math.max(0.5, (typeof brushSpacing === 'number' ? brushSpacing : (brushPreset?.spacing ?? 2)));
  const scatter = Math.max(0, brushPreset?.scatter ?? 0);
  const sizeJitter = Math.max(0, Math.min(1, brushPreset?.sizeJitter ?? 0));
  const opacityJitter = Math.max(0, Math.min(1, brushPreset?.opacityJitter ?? 0));
  const roundness = Math.max(0.05, Math.min(1, brushPreset?.roundness ?? 1));
  const angleDeg = brushPreset?.angle ?? 0;
  const angleJitter = Math.max(0, Math.min(1, brushPreset?.angleJitter ?? 0));
  const blendMode = brushPreset?.blendMode || 'normal';
  const smudgeStrength = Math.max(0, Math.min(1, brushPreset?.smudgeStrength ?? 0.5));
  // Simulación de presión: si device no da pressure, usamos velocidad inversa
  // Usar siempre el valor dinámico del slider (brushSize) como autoridad.
  // El tamaño del preset solo sirve como valor inicial cuando se selecciona (SidePanels ya hace setBrushSize(p.size)).
  const baseSize = brushSize; // antes: brushPreset?.size || brushSize (causaba que el slider no tuviera efecto cuando había preset)
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const speed = dist; // px por frame event
  const simulatedPressure = pressure && pressure > 0 ? pressure : Math.max(0.15, Math.min(1, 1 - speed / 40));
    // Taper aplicado según progreso de stroke (solo reducción final clásica)
  const progress = strokeProgressRef.current;
  const classicTaper = 1 - taper * Math.min(1, progress / (180 + baseSize * 14));
  // Nueva lógica dual‑taper: rampa inicial controlada + heurística final.
  // Start ramp: sube de 0.15 a 1 en taperStartLen px (si activado)
  const startRamp = taperStartEnabled ? (0.15 + 0.85 * Math.min(1, progress / taperStartLen)) : 1;
  const startFactor = 1 - (1 - startRamp) * taperStartFactorCfg; // aplicar fuerza configurada
  // End ramp heurística: si desacelera (speed bajo) y llevamos suficiente distancia, reducir.
  let endFactor = 1;
  if (taperEndEnabled && progress > taperEndLen) {
    const slow = Math.min(1, Math.max(0, (34 - speed) / 34)); // 0 rápido .. 1 muy lento
    // Cuando lento => reducir hacia 0.15, escalado por taperEndFactorCfg
    const target = 0.15 + (1 - slow * taperEndFactorCfg) * 0.85; // entre 0.15 y ~1
    endFactor = Math.max(0.15, Math.min(1, target));
  }
  const dualTaper = Math.min(startFactor, endFactor);
  // Usamos el mínimo entre classic (falloff progresivo) y dual para preservar afinamiento global.
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
        const steps = Math.max(1, Math.floor(dist / Math.max(1, baseSize * 0.35)));
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
            ctx.fillStyle = activeColor;
            ctx.arc(gx, gy, dotR, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        strokeProgressRef.current += dist;
        return;
      }
      else if (engine === 'acrylic') {
        // Enhanced acrylic: simulate multiple bristles leaving semi‑opaque paint with subtle grooves.
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / Math.max(1, baseSize * 0.6)));
        const dirX = (to.x - from.x) / steps;
        const dirY = (to.y - from.y) / steps;
        const dirLen = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const nx = -dirY / (dirLen/steps || 1); // local normal approx (not normalized strictly but fine for offset)
        const ny = dirX / (dirLen/steps || 1);
        const bristles = Math.max(4, Math.min(64, Math.floor((brushPreset?.bristleCount ?? 18))));
        const bristleSpread = Math.max(0.2, (brushPreset?.roundness ?? 0.7));
        const bristleJitter = Math.max(0, Math.min(1, brushPreset?.bristleJitter ?? 0.4));
        const wetness = Math.max(0, Math.min(1, brushPreset?.wetness ?? 0.35));
        const impasto = Math.max(0, Math.min(1, brushPreset?.impasto ?? 0.4));
        const texNoise = Math.max(0, Math.min(1, brushPreset?.strokeTextureNoise ?? 0.5));
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
              const img = ctx.getImageData(Math.round(cx - 1), Math.round(cy - 1), 2, 2);
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
            let col = activeColor;
            if (wetness > 0 && (blendR + blendG + blendB) > 0) {
              const sr = parseInt(activeColor.slice(1,3),16);
              const sg = parseInt(activeColor.slice(3,5),16);
              const sb = parseInt(activeColor.slice(5,7),16);
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
        strokeProgressRef.current += dist;
        return;
      }
      // Estilo manga (entintado): trazos vectoriales suavizados a partir de puntos bufferizados
  // Charcoal texture: treat for charcoal preset regardless of engine (supports legacy pencil)
  if (brushPreset?.texture === 'charcoal') {
        // Carbón: múltiples manchas/granos con opacidad variable, halo suave y acumulación rápida
        const steps = Math.max(1, Math.floor(dist / Math.max(1, baseSize * 0.45)));
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
            const a = (brushPreset?.opacity ?? 0.65) * (0.18 + 0.55 * Math.random()) * falloff;
            ctx.globalAlpha = Math.min(1, a);
            const dotR = Math.max(0.5, baseSize * 0.06 + Math.random() * (baseSize * 0.22));
            ctx.beginPath();
            ctx.fillStyle = activeColor;
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
        strokeProgressRef.current += dist;
        return;
  } else if (brushPreset?.texture === 'marker' && engine === 'mangaPen') {
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
          ctx.strokeStyle = activeColor;
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
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'airbrush') {
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / spacing));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * scatter * 0.3;
          const cy = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * scatter * 0.3;
          const jitterScale = 1 + (Math.random() * 2 - 1) * sizeJitter * 0.6;
          const r = Math.max(0.5, (baseSize * 0.4 + baseSize * 0.6 * simulatedPressure) * jitterScale * 0.5);
          ctx.globalAlpha = flow * (0.5 + 0.5 * Math.random());
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, activeColor);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'wash') {
        // Watercolor wash: simulate semi-transparent blooms, diffusion & edge darkening.
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / (spacing * 0.6)));
        const diffusion = Math.max(0, Math.min(1, brushPreset?.diffusion ?? 0.6));
        const bleed = Math.max(0, Math.min(1, brushPreset?.bleed ?? 0.5));
        const granulation = Math.max(0, Math.min(1, brushPreset?.granulation ?? 0.35));
        const edgeDarken = Math.max(0, Math.min(1, brushPreset?.edgeDarken ?? 0.65));
        const wetness = Math.max(0, Math.min(1, brushPreset?.wetness ?? 0.75));
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
            // Inner lighter pigment -> outer slightly darker edge pooling
            grad.addColorStop(0, activeColor);
            const edgeAlpha = Math.min(1, alpha * (0.4 + 0.9 * edgeDarken));
            // Darker ring via rgba using same hue but higher alpha (browser composites)
            grad.addColorStop(0.9, activeColor);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(cx, cy, lr, 0, Math.PI * 2);
            ctx.fill();
            // Edge darken stroke subtle
            if (edgeDarken > 0.05) {
              ctx.globalAlpha = edgeAlpha * 0.6;
              ctx.strokeStyle = activeColor;
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
                ctx.fillStyle = activeColor;
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
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'spray') {
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / spacing));
        const [pMin, pMax] = brushPreset?.particleSize || [1, 3];
        const densityMul = brushPreset?.density ?? 1;
        const basePresetSize = brushPreset?.size || baseSize;
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
            ctx.fillStyle = activeColor;
            ctx.arc(px, py, pr, 0, Math.PI * 2);
            ctx.fill();
            if (brushPreset?.drip && Math.random() < 0.01) {
              ctx.globalAlpha = opacityMul * 0.7;
              ctx.strokeStyle = activeColor;
              ctx.lineWidth = pr * 0.6;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(px + (Math.random() - 0.5) * 2, py + pr * (2 + Math.random() * 6));
              ctx.stroke();
            }
          }
        }
        ctx.globalAlpha = 1;
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'splatter') {
        const [pMin, pMax] = brushPreset?.particleSize || [4, 16];
        const blobs = Math.floor(3 + (dist / 10) * (brushPreset?.density ?? 1));
        const basePresetSize = brushPreset?.size || baseSize;
        const sizeScale = Math.max(0.2, Math.min(4, baseSize / basePresetSize));
        for (let i = 0; i < blobs; i++) {
          const t = Math.random();
          const cx = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * scatter;
            const cy = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * scatter;
            const r = (pMin + Math.random() * (pMax - pMin)) * sizeScale;
            ctx.globalAlpha = opacityMul * (0.5 + 0.5 * Math.random());
            ctx.beginPath();
            ctx.fillStyle = activeColor;
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'smudge') {
        const steps = Math.max(1, Math.floor(dist / spacing));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = from.x + (to.x - from.x) * t;
          const y = from.y + (to.y - from.y) * t;
          const sampleSize = Math.max(2, baseSize * 0.5);
          try {
            const img = ctx.getImageData(Math.max(0, x - sampleSize / 2), Math.max(0, y - sampleSize / 2), sampleSize, sampleSize);
            const d = img.data;
            let r = 0, g = 0, b = 0, c = 0;
            for (let p = 0; p < d.length; p += 4) { r += d[p]; g += d[p + 1]; b += d[p + 2]; c++; }
            if (c > 0) {
              r /= c; g /= c; b /= c;
              const sr = parseInt(activeColor.slice(1, 3), 16);
              const sg = parseInt(activeColor.slice(3, 5), 16);
              const sb = parseInt(activeColor.slice(5, 7), 16);
              const cr = Math.round(sr * smudgeStrength + r * (1 - smudgeStrength));
              const cg = Math.round(sg * smudgeStrength + g * (1 - smudgeStrength));
              const cb = Math.round(sb * smudgeStrength + b * (1 - smudgeStrength));
              ctx.globalAlpha = opacityMul * 0.9;
              ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
              const rad = baseSize * 0.5;
              ctx.beginPath();
              ctx.arc(x, y, rad, 0, Math.PI * 2);
              ctx.fill();
            }
          } catch {}
        }
        ctx.globalAlpha = 1;
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'calligraphy') {
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / spacing));
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
          ctx.fillStyle = activeColor;
          ctx.beginPath();
          ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'glow') {
        const prev = ctx.globalCompositeOperation;
        if (blendMode === 'add') ctx.globalCompositeOperation = 'lighter';
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / spacing));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = from.x + (to.x - from.x) * t;
          const cy = from.y + (to.y - from.y) * t;
          const r = baseSize * (0.4 + 0.6 * simulatedPressure) * (0.7 + Math.random() * 0.3);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, activeColor);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = opacityMul * (0.6 + 0.4 * Math.random());
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = prev;
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'pixel') {
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / spacing));
        const sizePx = Math.max(1, Math.round(baseSize * 0.4));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = Math.round(from.x + (to.x - from.x) * t);
          const cy = Math.round(from.y + (to.y - from.y) * t);
          const jitterScaleLocal = 1 + (Math.random() * 2 - 1) * sizeJitter * 0.5;
          const s = Math.max(1, Math.round(sizePx * jitterScaleLocal));
          ctx.globalAlpha = opacityMul * (0.8 + 0.2 * Math.random());
          ctx.fillStyle = activeColor;
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
        strokeProgressRef.current += dist;
        return;
      } else if (engine === 'multi') {
        const segLen = dist || 1;
        const steps = Math.max(1, Math.floor(segLen / spacing));
        const stamps = brushPreset?.stamps || ['★'];
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
          ctx.fillStyle = activeColor;
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
        strokeProgressRef.current += dist;
        return;
      } else {
        const p0 = jitterPoint(from);
        const p1 = jitterPoint(to);
        ctx.globalAlpha = opacityMul;
        ctx.strokeStyle = activeColor;
  const pressureScale = simulatedPressure * taperFactor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(0.5, baseSize * 0.4 + baseSize * 0.6 * pressureScale);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        strokeProgressRef.current += dist;
        ctx.globalAlpha = 1;
      }
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
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
  const w = canvas.width; // device px
  const h = canvas.height;
      // Logical -> device pixel coords
      const sx = Math.floor(x * dpr);
      const sy = Math.floor(y * dpr);
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
      const baseSize = Math.max(1, Math.floor(brushSize * dpr));
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
        const density = Math.max(600, Math.min(8000, Math.floor(area / 140))); // tuned for 480x640
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
      lastPointRef.current = pos;
      eraseRef.current = erase;
  // Reset smoothing buffer para no enlazar con stroke previo
  smoothBuffer.current = [{...pos, t: performance.now(), pressure: 0.5}];
      firstMoveRef.current = true; // primera mov después de pointerDown se salta
      strokeStartPosRef.current = pos;
      setIsDrawing(!erase);
    };

    const endStroke = () => {
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

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      
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
  const pos = { x: native.offsetX / zoom, y: native.offsetY / zoom };
      const buttons = e.buttons;

      // Fill tool: perform on primary click with mouse/pen. Touch remains pan-only by design.
  if (tool === 'fill' && e.pointerType !== 'touch') {
        if ((e.pointerType === 'mouse' && (buttons & 1)) || (e.pointerType === 'pen' && (buttons & 1))) {
      onBeforeMutate?.();
      floodFill(pos.x, pos.y);
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
      } else if (e.pointerType === 'touch') {
        // Si ya se está dibujando con pen/mouse, ignorar pan táctil
        if (penActionRef.current === 'draw' || penActionRef.current === 'erase') return;
        // Pan con un dedo (sin dibujar)
        penActionRef.current = 'pan';
        activePanPointerIdRef.current = e.pointerId;
        panState.current = { x: e.clientX, y: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop };
      }
    };

    // One-time restore of provided image
    const restoredRef = useRef(false);
    useEffect(() => {
      if (restoredRef.current) return;
      if (!restoreImage) return;
      const canvas = canvasRef.current; if (!canvas) return;
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      const img = new Image();
      img.onload = () => {
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        const logicalW = canvas.width / dpr;
        const logicalH = canvas.height / dpr;
        ctx.save();
        ctx.setTransform(1,0,0,1,0,0);
        ctx.scale(dpr, dpr);
    // Always paint a solid white underlay to avoid transparent regions when restoring
    ctx.clearRect(0,0,logicalW,logicalH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0,0,logicalW,logicalH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, 0, 0, logicalW, logicalH);
        ctx.restore();
        restoredRef.current = true;
      };
      img.src = restoreImage;
    }, [restoreImage]);

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
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
        const pos = { x: native.offsetX / zoom, y: native.offsetY / zoom };
        
        const nativePressure = (e.nativeEvent as any).pressure as number | undefined;
        const pressure = typeof nativePressure === 'number' ? nativePressure : 0;
        if (penActionRef.current === 'erase') {
          const ctx = canvasRef.current?.getContext('2d');
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
          }
        } else {
          // Saltar la primera actualización para evitar segmento conectivo inmediato
          if (firstMoveRef.current) {
            firstMoveRef.current = false;
            smoothBuffer.current.push({ ...pos, t: performance.now(), pressure });
            if (smoothBuffer.current.length > 6) smoothBuffer.current.shift();
            lastPointRef.current = pos; // solo actualizar referencia
            return;
          }
          // Smoothing: añadimos al buffer y usamos el punto anterior suavizado
          smoothBuffer.current.push({ ...pos, t: performance.now(), pressure });
          if (smoothBuffer.current.length > 6) smoothBuffer.current.shift();
          const pts = smoothBuffer.current;
          let fromPt = lastPointRef.current;
          let toPt = pos;
          if (pts.length >= 3) {
            // simple Chaikin midpoint smoothing
            const a = pts[pts.length - 3];
            const b = pts[pts.length - 2];
            const c = pts[pts.length - 1];
            const mid1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const mid2 = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
            fromPt = mid1;
            toPt = mid2;
          }
          drawLine(fromPt, toPt, pressure);
        }
        lastPointRef.current = pos;
      }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      // Liberar la captura del pointer (si no es touch)
      if (e.pointerType !== 'touch') {
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      
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
            className={`${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-crosshair'} absolute inset-0 canvas-paper sketch-outline select-none transition-opacity`}
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
        </div>
        {disabled && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <p className="text-sm font-semibold" style={{ color: '#111' }}>Inicia sesión para dibujar</p>
          </div>
        )}
      </div>
    );
  }
);