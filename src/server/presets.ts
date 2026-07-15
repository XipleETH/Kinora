// src/server/presets.ts
// -----------------------------------------------------------------------------
// HOUSE PRESETS — guarantee a weekly bundle (Theme + Palette + Brushes + Director)
// even when nobody proposes or votes, so the weekly post / voting is never empty.
//
//  - Theme name: curated 100-item English list (rotates by week; Week 1 keeps
//    the signature "Moving Lines").
//  - Palette & Brushes: generated with a deterministic per-week PRNG so the same
//    week always yields the same "random-looking" bundle. This keeps the seeded
//    ballot proposal and the never-empty safety-net winner perfectly in sync.
//  - Director: the house account ("kinora-app").
//
// The house bundle is seeded onto the ballot with a single vote and is votable
// like any human pitch. It loses vote ties to human bundles (see house tie-break
// in pickWinner in index.ts), so an equal vote count always goes to the humans.
// -----------------------------------------------------------------------------

export const HOUSE_DIRECTOR = 'kinora-app';

// Week 1 keeps this signature name; weeks >= 2 rotate through THEME_NAMES.
export const WEEK1_THEME = 'Moving Lines';

// 100 curated, family-friendly English theme names (10 per genre bucket).
export const THEME_NAMES: string[] = [
  'Misty Pine Forest', 'Rolling Ocean Waves', 'Snowy Mountain Peaks', 'Golden Desert Dunes',
  'Blooming Wildflower Meadow', 'Rushing River Rapids', 'Coral Reef Garden', 'Sunlit Waterfall Pool',
  'Windswept Grassy Hills', 'Tide Pool Creatures',
  'Dancing Northern Lights', 'Twirling Ringed Planet', 'Falling Star Shower', 'Bouncing Little Astronaut',
  'Swirling Purple Nebula', 'Blinking Constellation Lines', 'Zooming Rocket Trail', 'Curious Alien Friend',
  'Spinning Galaxy Whirl', 'Gentle Solar Flare',
  'Neon Skyline', 'Roller Disco', 'Arcade Blast', 'Chrome Diner', 'Rubber Hose Dance',
  'Golden Gramophone', 'Cassette Rewind', 'Sunset Grid', 'Marquee Lights', 'Vinyl Spin',
  'Floating On Clouds', 'Paper Boat Wishes', 'Bubbles And Giggles', 'Rainy Window Daydreams',
  'Chasing Falling Leaves', 'First Snow Hush', 'Whispering Starlight', 'Home For Tea',
  'Balloon Set Free', 'Lantern Lit Nights',
  'Neon Rain Alley', 'Rooftop Sunrise', 'Subway Rush Hour', 'Chalk Wall Colors', 'Night Market Glow',
  'Puddle Reflections', 'Street Food Steam', 'Corner Newsstand', 'Rooftop Kite Flight', 'Fire Escape Garden',
  'Sleeping Dragon', "Wizard's Hat", 'Floating Castle', 'Baby Griffin', 'Glowing Mushroom Grove',
  'Talking Owl', 'Crystal Cave', 'Friendly Sea Serpent', 'Wandering Phoenix', 'Mermaid Lagoon',
  'First Spring Buds', 'Melting Icicles', 'Petals On Wind', 'Summer Heat Shimmer', 'Chasing Fireflies',
  'Sudden Rain Shower', 'Morning Frost Patterns', 'Rainbow After Rain', 'Frozen Pond Skate', 'Falling Autumn Leaves',
  'Spinning Tops', 'Twirling Ribbons', 'Fluttering Wings', 'Tumbling Dominoes', 'Dancing Flames',
  'Springy Slinky', 'Drifting Bubbles', 'Galloping Herd', 'Wobbling Jelly', 'Whirling Kites',
  'Spinning Spirals', 'Kaleidoscope Bloom', 'Endless Staircase', 'Growing Fractals', 'Mirror Symmetry',
  'Melting Checkerboard', 'Pulsing Polygons', 'Woven Lines', 'Nesting Squares', 'Rolling Hexagons',
  'Bouncing Gumdrops', 'Wind-Up Robots', 'Marshmallow Clouds', 'Tiny Teacup Town', 'Rubber Duck Parade',
  'Sock Puppet Circus', 'Balloon Animal Zoo', 'Pillow Fort Kingdom', 'Dancing Lollipops', 'Snail Mail Express',
];

// Brush pool mirrors the client `allBrushPresets` ids/names (engine-supported).
type BrushRef = { id: string; name: string };
const CORE_LINE_BRUSHES: BrushRef[] = [
  { id: 'ink', name: 'Ink' },
  { id: 'marker', name: 'Marker' },
  { id: 'pencil', name: 'Pencil' },
];
const EXTRA_BRUSHES: BrushRef[] = [
  { id: 'acrylic-paint', name: 'Acrylic Paint' },
  { id: 'charcoal', name: 'Charcoal' },
  { id: 'watercolor-wash', name: 'Watercolor Wash' },
  { id: 'airbrush', name: 'Airbrush' },
  { id: 'spray-fine', name: 'Spray Fine' },
  { id: 'spray-drip', name: 'Spray Drip' },
  { id: 'splatter-big', name: 'Splatter Big' },
  { id: 'smudge-soft', name: 'Smudge Soft' },
  { id: 'calli-fine', name: 'Calligraphy Fine' },
  { id: 'calli-broad', name: 'Calligraphy Broad' },
  { id: 'glow-soft', name: 'Glow Soft' },
  { id: 'pixel-1', name: 'Pixel 1px' },
  { id: 'pixel-rect', name: 'Pixel Rectangle' },
  { id: 'multi-stars', name: 'Multi Stars' },
  { id: 'multi-leaves', name: 'Multi Leaves' },
];

// --- deterministic PRNG (mulberry32) --------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// HSL (h:0..360, s/l:0..100) -> #RRGGBB
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

// Generate 6 harmonious colors using a random color scheme.
function generatePalette(rng: () => number): string[] {
  const baseHue = Math.floor(rng() * 360);
  const schemes = ['analogous', 'complementary', 'triadic', 'tetradic', 'splitComp'] as const;
  const scheme = schemes[Math.floor(rng() * schemes.length)];
  let deltas: number[];
  switch (scheme) {
    case 'analogous':
      deltas = [-40, -20, 0, 20, 40, 60];
      break;
    case 'complementary':
      deltas = [0, 15, 30, 180, 195, 210];
      break;
    case 'triadic':
      deltas = [0, 20, 120, 140, 240, 260];
      break;
    case 'tetradic':
      deltas = [0, 90, 180, 270, 30, 210];
      break;
    case 'splitComp':
    default:
      deltas = [0, 20, 150, 170, 190, 210];
      break;
  }
  return deltas.map((d) => {
    const hue = (((baseHue + d) % 360) + 360) % 360;
    const sat = 55 + Math.floor(rng() * 30); // 55..85
    const light = 42 + Math.floor(rng() * 28); // 42..70
    return hslToHex(hue, sat, light);
  });
}

// Always one core line brush + 2..3 distinct extras (total 3..4).
function pickBrushes(rng: () => number): BrushRef[] {
  const core = CORE_LINE_BRUSHES[Math.floor(rng() * CORE_LINE_BRUSHES.length)] ?? CORE_LINE_BRUSHES[0]!;
  const pool = [...EXTRA_BRUSHES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  const extrasCount = 2 + Math.floor(rng() * 2); // 2 or 3
  return [core, ...pool.slice(0, extrasCount)];
}

export type HouseBundle = {
  theme: { name: string };
  palette: { name: string; colors: string[] };
  brushKit: { name: string; ids: string[]; names: string[] };
  director: string;
};

// Deterministic per-week house bundle.
export function getHouseBundle(week: number): HouseBundle {
  const rng = mulberry32(Math.imul(week || 1, 2654435761) >>> 0);
  const themeName = week <= 1 ? WEEK1_THEME : (THEME_NAMES[(week - 2) % THEME_NAMES.length] ?? WEEK1_THEME);
  const colors = generatePalette(rng);
  const brushes = pickBrushes(rng);
  return {
    theme: { name: themeName },
    palette: { name: `${themeName} Palette`, colors },
    brushKit: {
      name: brushes.map((b) => b.name).join(' + '),
      ids: brushes.map((b) => b.id),
      names: brushes.map((b) => b.name),
    },
    director: HOUSE_DIRECTOR,
  };
}

// Winner-shaped object (matches how index.ts extracts winners into draw config).
export function houseWinnersForWeek(week: number) {
  const b = getHouseBundle(week);
  const id = `house-w${week}`;
  return {
    palette: {
      id: `${id}-pal`, type: 'palette', title: b.palette.name,
      data: { colors: b.palette.colors }, proposedBy: b.director, proposedAt: 0, votes: 1, house: true,
    },
    theme: {
      id: `${id}-thm`, type: 'theme', title: b.theme.name,
      data: { value: b.theme.name, description: b.theme.name }, proposedBy: b.director, proposedAt: 0, votes: 1, house: true,
    },
    brushKit: {
      id: `${id}-brk`, type: 'brushKit', title: b.brushKit.name,
      data: { ids: b.brushKit.ids, names: b.brushKit.names }, proposedBy: b.director, proposedAt: 0, votes: 1, house: true,
    },
  };
}

// Proposal-shaped objects to seed the ballot: visible in voting, votable, and
// grouped so the client renders them as a single bundle. One vote each, and
// marked `house: true` so a tied human bundle overtakes them.
export function buildHouseProposals(week: number, proposedAtMs: number) {
  const b = getHouseBundle(week);
  const groupId = `house_w${week}`;
  const base = {
    proposedBy: b.director,
    proposedAt: proposedAtMs,
    votes: 1,
    voters: [b.director],
    week,
    house: true,
  };
  return [
    { id: `${groupId}_thm`, type: 'theme', title: b.theme.name, data: { value: b.theme.name, description: b.theme.name, groupId, house: true }, ...base },
    { id: `${groupId}_pal`, type: 'palette', title: b.palette.name, data: { colors: b.palette.colors, groupId, house: true }, ...base },
    { id: `${groupId}_brk`, type: 'brushKit', title: b.brushKit.name, data: { ids: b.brushKit.ids, names: b.brushKit.names, groupId, house: true }, ...base },
  ];
}
