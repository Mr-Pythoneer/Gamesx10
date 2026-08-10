// Mirrorbind — procedural level generator.
//
// Produces candidate level specs (grid layouts) for the generate-verify-reject
// pipeline in tools/gen-levels.mjs. This module is pure and DOM-free — it only
// builds grid strings, it never simulates. Verification against the real physics
// happens via game.js's solve()/replay() in the build script, never here.
//
// Grid roles (matches the 10 hand-authored levels in levels.js):
//   row 0        — top wall
//   rows 1..4    — obstacle zone (ceiling blocks, pillars)
//   row (ROWS-2) — walk row: S, E, and any floor-level spikes live here
//   row (ROWS-1) — floor: solid, with optional gaps (chasms) carved into it
//
// World-2 (flipX) is always the exact horizontal mirror of world 1 — reversing
// every row string swaps S/E and every hazard to its mirrored column, which is
// exactly how the hand-authored mirrored worlds relate to their partner (verified
// against Bound/Gap/Offset/etc. in levels.js).
//
// World-3 (flipY, and optionally flipX too) is a 180-degree (or vertical-only)
// transform of world 1's rows: reversing row order moves the floor from the
// bottom to the top, matching how gravity now pulls up (see Upside/Inverted/
// Bindfast in levels.js).

export const COLS = 13;
export const ROWS = 7;
const WALK = ROWS - 2; // row 5
const FLOOR = ROWS - 1; // row 6

function blankGrid() {
  const g = [];
  for (let r = 0; r < ROWS; r++) {
    const row = new Array(COLS).fill('.');
    if (r === 0 || r === FLOOR) row.fill('#');
    row[0] = '#';
    row[COLS - 1] = '#';
    g.push(row);
  }
  return g;
}

function carveGaps(g, gaps) {
  for (const { start, width } of gaps) {
    for (let c = start; c < start + width; c++) {
      if (c > 0 && c < COLS - 1) g[FLOOR][c] = '.';
    }
  }
}

function placeSpikes(g, cols) {
  for (const c of cols) if (c > 0 && c < COLS - 1) g[WALK][c] = '^';
}

function placeCeilings(g, blocks) {
  for (const { start, width, row } of blocks) {
    for (let c = start; c < start + width; c++) {
      if (c > 0 && c < COLS - 1) g[row][c] = '#';
    }
  }
}

function placePillars(g, pillars) {
  for (const { col, r0, r1 } of pillars) {
    for (let r = r0; r <= r1; r++) g[r][col] = '#';
  }
}

function placePlatforms(g, plats) {
  // Floating mid-air platform segments (used by the "stair" template).
  for (const { start, width, row } of plats) {
    for (let c = start; c < start + width; c++) {
      if (c > 0 && c < COLS - 1) g[row][c] = '#';
    }
  }
}

/** Build world 1's grid from a feature spec. Always writes S at col1, E at col(COLS-2). */
export function buildGrid(spec) {
  const g = blankGrid();
  placePlatforms(g, spec.platforms || []);
  placeCeilings(g, spec.ceilings || []);
  placePillars(g, spec.pillars || []);
  carveGaps(g, spec.gaps || []);
  placeSpikes(g, spec.spikes || []);
  g[WALK][1] = 'S';
  g[WALK][COLS - 2] = 'E';
  return g.map((row) => row.join(''));
}

export function mirrorX(grid) {
  return grid.map((row) => row.split('').reverse().join(''));
}

/** 180-degree rotation (flipX + flipY) or a pure vertical flip (flipY only). */
export function flipY(grid, alsoFlipX) {
  const rows = grid.slice().reverse();
  return alsoFlipX ? rows.map((row) => row.split('').reverse().join('')) : rows;
}

// ---------------------------------------------------------------- templates
//
// Each template takes a 0..1 difficulty knob and an RNG, and returns a feature
// spec consumed by buildGrid(). Column choices stay inside [2, COLS-3] so hazards
// never sit on the border wall or directly on S/E.

const MAXC = COLS - 3; // 10
const MINC = 2;

function pick(rng, lo, hi) { return lo + Math.floor(rng.next() * (hi - lo + 1)); }

function tGapSingle(knob, rng) {
  const width = 2 + (knob > 0.55 ? 1 : 0); // 2 or 3 tiles
  const start = pick(rng, 4, MAXC - width);
  return { gaps: [{ start, width }] };
}

function tGapDouble(knob, rng) {
  const w1 = 2, w2 = knob > 0.6 ? 3 : 2;
  const start1 = pick(rng, 3, 5);
  const start2 = pick(rng, start1 + w1 + 2, MAXC - w2);
  return { gaps: [{ start: start1, width: w1 }, { start: start2, width: w2 }] };
}

function tSpikeRow(knob, rng) {
  const n = 1 + Math.round(knob * 3); // 1..4
  const cols = [];
  let c = pick(rng, 3, 5);
  for (let i = 0; i < n; i++) {
    cols.push(c);
    c += pick(rng, 2, 3);
    if (c > MAXC) break;
  }
  return { spikes: cols };
}

function tGapPlusSpike(knob, rng) {
  const width = 2;
  const start = pick(rng, 3, 6);
  const spike = start + width + pick(rng, 1, 2);
  return { gaps: [{ start, width }], spikes: [Math.min(spike, MAXC)] };
}

function tCeilingLowGap(knob, rng) {
  const width = 3;
  const start = pick(rng, 4, MAXC - width);
  const ceilRow = knob > 0.7 ? 3 : 2; // lower ceiling = tighter arc, harder
  return {
    gaps: [{ start, width }],
    ceilings: [{ start: start - 1, width: width + 2, row: ceilRow }],
  };
}

function tPillarSpike(knob, rng) {
  const col = pick(rng, 5, 8);
  return {
    pillars: [{ col, r0: 2, r1: knob > 0.6 ? 4 : 3 }],
    spikes: [col],
  };
}

function tStairPlatforms(knob, rng) {
  // Two short floating platforms plus a floor gap, forcing a hop-hop-clear sequence.
  const p1 = { start: 3, width: 2, row: 4 };
  const p2 = { start: 6, width: 2, row: 3 };
  const gapStart = 9, gapWidth = 2;
  return {
    platforms: [p1, p2],
    gaps: [{ start: gapStart, width: gapWidth }],
    spikes: knob > 0.65 ? [MAXC] : [],
  };
}

function tCombo(knob, rng) {
  const width = 2 + (knob > 0.5 ? 1 : 0);
  const start = pick(rng, 4, MAXC - width);
  const spikeCol = Math.max(2, start - 2);
  const ceilStart = start - 1;
  return {
    gaps: [{ start, width }],
    spikes: [spikeCol],
    ceilings: [{ start: ceilStart, width: width + 2, row: 2 }],
  };
}

export const TEMPLATES = [
  tGapSingle, tSpikeRow, tGapDouble, tGapPlusSpike,
  tCeilingLowGap, tPillarSpike, tStairPlatforms, tCombo,
];

/** Small, safe feature spec for a third (inverted) world — kept modest so 3-world search stays tractable. */
function tMinor(knob, rng) {
  if (knob < 0.3) return {};
  if (rng.bool(0.5)) return { gaps: [{ start: pick(rng, 4, 8), width: 2 }] };
  return { spikes: [pick(rng, 4, 8)] };
}

/**
 * Build a full candidate level (2 or 3 worlds) for difficulty index `i` (10..49),
 * given an RNG. `variant` lets the caller retry the same index with different
 * random choices when the first candidate turns out unsolvable.
 */
export function generateCandidate(i, rng, { nWorlds, knob } = {}) {
  const template = TEMPLATES[(i - 10) % TEMPLATES.length];
  const spec = template(knob, rng);
  const grid1 = buildGrid(spec);
  const grid2 = mirrorX(grid1);
  const worlds = [
    { flipX: false, grid: grid1 },
    { flipX: true, grid: grid2 },
  ];
  if (nWorlds >= 3) {
    const alsoFlipX = rng.bool(0.5);
    const spec3 = tMinor(knob, rng);
    const base3 = buildGrid(spec3);
    const grid3 = flipY(base3, alsoFlipX);
    worlds.push({ flipX: alsoFlipX, flipY: true, grid: grid3 });
  }
  return { worlds };
}
