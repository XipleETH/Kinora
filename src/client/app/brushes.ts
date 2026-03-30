// Available engines (extended). Existing ids kept for backward compatibility.
//  - mangaPen: clean inking with taper & jitter
//  - pencil: granular graphite style
//  - wash: semi-transparent watercolor diffusion
//  - acrylic: opaque soft-edged paint
//  - airbrush: continuous spray with flow & build-up (low spacing)
//  - spray: particle spray with density & scatter
//  - splatter: large random droplets & directional scatter
//  - smudge: color pick & smear along stroke
//  - calligraphy: angle-based width (flat nib) with pressure variation
//  - glow: additive luminous soft brush
//  - pixel: single‑pixel hard brush supporting size jitter (pixel art)
//  - multi: composite multi-stamp brush (e.g., stars/leaves); uses stamps array
export type BrushEngine =
  | 'mangaPen'
  | 'pencil'
  | 'wash'
  | 'acrylic'
  | 'airbrush'
  | 'spray'
  | 'splatter'
  | 'smudge'
  | 'calligraphy'
  | 'glow'
  | 'pixel'
  | 'multi';

export type BrushStyle = 'anime' | 'comic' | 'watercolor' | 'graffiti';

export interface BrushPreset {
  id: string;
  name: string;
  engine: BrushEngine;
  size: number; // default size
  opacity?: number; // 0..1
  hardness?: number; // 0..1 for soft
  taper?: number; // 0..1 amount of end taper for solid/fade
  // New dual‑taper controls (optional). If omitted we fallback to legacy single 'taper'.
  taperStart?: number; // 0..1 how much to taper at stroke beginning (1 = enable full start taper, 0 = none)
  taperEnd?: number;   // 0..1 how much to taper at stroke ending (1 = full end taper)
  taperStartLength?: number; // approximate pixel length over which to ramp up from tip to full width
  taperEndLength?: number;   // approximate pixel length over which to ramp down near the end (heuristic – real end unknown until pointer up)
  jitter?: number; // 0..1 positional jitter factor
  density?: number; // spray particles density multiplier
    // Watercolor / wash physical simulation parameters (optional)
    diffusion?: number;    // 0..1 lateral spread speed
    bleed?: number;        // 0..1 color bleed / feathering at edges
    granulation?: number;  // 0..1 pigment clustering intensity
    edgeDarken?: number;   // 0..1 dark edge accumulation factor
    wetness?: number;      // 0..1 initial wetness (affects diffusion & transparency)
  particleSize?: [number, number]; // spray particle radius range in px
  drip?: boolean; // graffiti drip effect for spray
  texture?: 'pencil' | 'marker' | 'rough' | 'charcoal' | 'wash' | 'acrylic' | 'none';
  // Extended properties for new engines
  flow?: number; // airbrush continuous flow 0..1
  spacing?: number; // distance between dabs in px (airbrush/pixel/multi)
  scatter?: number; // max scatter in px for particle style
  angle?: number; // base angle in degrees (calligraphy)
  angleJitter?: number; // 0..1 random angle variation
  roundness?: number; // 0..1 (1 = circle, <1 squashed) for calligraphy nib
  sizeJitter?: number; // 0..1 random size variance
  opacityJitter?: number; // 0..1 random opacity variance
  blendMode?: 'normal' | 'add' | 'multiply' | 'erase'; // local compositing hint
  smudgeStrength?: number; // 0..1 proportion of picked color to carry
  stamps?: string[]; // for multi engine (unicode / simple shape keys)
  // Acrylic / impasto specific experimental params
  bristleCount?: number; // number of parallel bristle filaments
  bristleJitter?: number; // 0..1 positional jitter among bristles
  acrylicWetness?: number; // 0..1 how much acrylic blends/smears longitudinally (renamed to avoid clash with watercolor wetness)
  impasto?: number; // 0..1 highlight thickness intensity
  strokeTextureNoise?: number; // 0..1 noise amplitude for ridges
}

// Preset inicial del pincel de tinta manga: líneas nítidas con ligera variación
// Ajustes futuros: dinámica de presión simulada y estabilizador configurable
export const brushKits: Record<BrushStyle, BrushPreset[]> = {
  anime: [
    {
      id: 'ink',
      name: 'Ink',
      engine: 'mangaPen',
      size: 6,
      opacity: 1,
      taper: 0.65, // legacy end taper factor (still used as global falloff)
      taperStart: 1, // activar afinado inicial
      taperEnd: 1,   // activar afinado final
      taperStartLength: 28, // px aproximados de rampa inicial
      taperEndLength: 34,   // px aproximados de rampa final (heurístico)
      jitter: 0.02, // mínima vibración orgánica
      texture: 'none'
    },
    {
      id: 'acrylic-paint', // renamed from previous 'acrilico'
      name: 'Acrylic Paint',
      engine: 'acrylic',
      size: 10,
      opacity: 0.95,
      taper: 0.15,
      jitter: 0.04,
      hardness: 0.7,
      texture: 'acrylic',
      bristleCount: 20,
      bristleJitter: 0.45,
  acrylicWetness: 0.38,
      impasto: 0.5,
      strokeTextureNoise: 0.55
    }
  ],
  comic: [
    {
      id: 'marker',
      name: 'Marker',
      engine: 'mangaPen',
      size: 9,
      opacity: 0.9,
      taper: 0.2, // marcador casi plano
      jitter: 0.01,
      texture: 'marker'
    },
    {
      id: 'charcoal',
      name: 'Charcoal',
      engine: 'pencil',
      size: 12,
      opacity: 0.65,
      taper: 0.15,
      jitter: 0.12,
      hardness: 0.4,
      texture: 'charcoal'
    }
  ],
  watercolor: [
    {
      id: 'watercolor-wash',
      name: 'Watercolor Wash',
      engine: 'wash',
      size: 18,
      opacity: 0.35,
      taper: 0.4,
      jitter: 0.1,
      hardness: 0.3,
      texture: 'wash',
      diffusion: 0.6,
      bleed: 0.5,
      granulation: 0.35,
      edgeDarken: 0.7,
      wetness: 0.75
    },
    {
      id: 'pencil',
      name: 'Pencil',
      engine: 'pencil',
      size: 5,
      opacity: 0.8,
      taper: 0.5,
      jitter: 0.06,
      hardness: 0.8,
      texture: 'pencil'
    }
  ],
  graffiti: [],
};

// Helper: lista plana de todos los presets
export const allBrushPresets: BrushPreset[] = [
  ...Object.values(brushKits).flat(),
  // New extended presets (English names) appended; can be proposed in voting
  {
    id: 'airbrush',
    name: 'Airbrush',
    engine: 'airbrush',
    size: 28,
    opacity: 0.15,
    flow: 0.18,
    spacing: 4,
    jitter: 0.02,
    hardness: 0.1,
    texture: 'none'
  },
  {
    id: 'spray-fine',
    name: 'Spray Fine',
    engine: 'spray',
    size: 18,
    opacity: 0.55,
    density: 1.0,
    particleSize: [0.8, 2.2],
    scatter: 6,
    spacing: 6,
    texture: 'none'
  },
  {
    id: 'spray-drip',
    name: 'Spray Drip',
    engine: 'spray',
    size: 24,
    opacity: 0.65,
    density: 1.3,
    particleSize: [1.2, 3.8],
    scatter: 9,
    drip: true,
    spacing: 5,
    texture: 'none'
  },
  {
    id: 'splatter-big',
    name: 'Splatter Big',
    engine: 'splatter',
    size: 34,
    opacity: 0.85,
    density: 0.9,
    particleSize: [4, 18],
    scatter: 22,
    spacing: 14,
    texture: 'none'
  },
  {
    id: 'smudge-soft',
    name: 'Smudge Soft',
    engine: 'smudge',
    size: 30,
    opacity: 0.9,
    smudgeStrength: 0.8,
    spacing: 2,
    hardness: 0.1,
    texture: 'none'
  },
  {
    id: 'calli-fine',
    name: 'Calligraphy Fine',
    engine: 'calligraphy',
    size: 18,
    opacity: 1,
    angle: 35,
    angleJitter: 0.08,
    roundness: 0.3,
    taper: 0.4,
    spacing: 3,
    texture: 'none'
  },
  {
    id: 'calli-broad',
    name: 'Calligraphy Broad',
    engine: 'calligraphy',
    size: 26,
    opacity: 0.95,
    angle: 15,
    roundness: 0.25,
    taper: 0.25,
    spacing: 4,
    texture: 'none'
  },
  {
    id: 'glow-soft',
    name: 'Glow Soft',
    engine: 'glow',
    size: 40,
    opacity: 0.25,
    flow: 0.2,
    spacing: 6,
    hardness: 0.05,
    blendMode: 'add'
  },
  {
    id: 'pixel-1',
    name: 'Pixel 1px',
    engine: 'pixel',
    size: 6,
    opacity: 1,
    spacing: 1,
    hardness: 1,
    texture: 'none'
  },
  {
    id: 'pixel-rect',
    name: 'Pixel Rectangle',
    engine: 'pixel',
    size: 12,
    opacity: 1,
    spacing: 1,
    roundness: 0.35,
    texture: 'none'
  },
  {
    id: 'multi-stars',
    name: 'Multi Stars',
    engine: 'multi',
    size: 32,
    opacity: 0.9,
    spacing: 16,
    scatter: 18,
    sizeJitter: 0.5,
    opacityJitter: 0.3,
    stamps: ['★','✦','✧'],
    texture: 'none'
  },
  {
    id: 'multi-leaves',
    name: 'Multi Leaves',
    engine: 'multi',
    size: 30,
    opacity: 0.85,
    spacing: 14,
    scatter: 16,
    sizeJitter: 0.45,
    angleJitter: 0.6,
    stamps: ['leaf','leaf2','dot'],
    texture: 'none'
  }
];
