// Scribble — procedural level generator.
//
// Produces level GEOMETRY only (ball spawn, goal, walls, spikes, ink budget) plus a
// heuristic starting guess for a winning stroke script. It never invents new physics —
// every shape it emits is built from the same primitives the hand-authored levels use
// (floating shelf segments, a goal "pocket" hugging the right wall, floor spikes), and
// every candidate it produces is meant to be handed to solver.js for real verification
// against physics.js before it is trusted.
//
// Archetype story (mirrors the escalation of the original 12 hand-built levels):
//   - "ramp"      : one long diagonal static stroke, spawn straight to the goal pocket.
//                   (this is exactly LEVELS[0]'s shape)
//   - "shelf"     : one or more floating platforms in between, each bridged by its own
//                   stroke — more strokes, more ink discipline, more places to fall short.
//   - "gauntlet"  : shelf chain plus floor spikes under every gap, so overshoot/undershoot
//                   both end in death, not just a miss.
//   - "needle"    : gauntlet with a shrunk goal radius and a tight ink ceiling — almost no
//                   room for a second attempt at any stroke.
//
// Difficulty escalates by tier (see TIERS below): more required strokes, tighter ink
// budgets relative to the geometric minimum, higher spike coverage, and a shrinking goal.

export const WORLD_W = 960;
export const WORLD_H = 600;
const WALL_L = [0, -400, 0, 900];
const WALL_R = [960, -400, 960, 900];

// ---------------------------------------------------------------- deterministic RNG

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---------------------------------------------------------------- archetype tiers
//
// idx is the level's position in the FULL 50-level table (0-based). Levels 0..11 are
// the original hand-authored set; the generator only ever runs for idx >= 12.

const ARCHETYPES = ['ramp', 'shelf', 'gauntlet', 'needle'];

export function archetypeFor(idx) {
  const d = clamp((idx - 12) / 37, 0, 1);
  if (d < 0.22) return 'ramp';
  if (d < 0.55) return 'shelf';
  if (d < 0.82) return 'gauntlet';
  return 'needle';
}

export function difficultyFor(idx) {
  return clamp((idx - 12) / 37, 0, 1);
}

/**
 * buildLevel(idx, seed, opts) -> { level, gaps }
 *   level : plain level object (no `solution` yet) in the same shape as levels.js
 *   gaps  : [{ from:{x,y}, to:{x,y} }, ...] — the spans a stroke needs to bridge, in
 *           left-to-right order. solver.js turns these into an initial stroke guess.
 * opts.noSpikes lets a caller retry the same seed without hazards if spikes keep
 * killing the ball in a spot the solver can't route around.
 */
export function buildLevel(idx, seed, opts = {}) {
  const rng = mulberry32(seed);
  const arche = archetypeFor(idx);
  const d = difficultyFor(idx);

  const nSegments = arche === 'ramp' ? 1
    : arche === 'shelf' ? 2 + Math.floor(rng() * 2)          // 2-3
    : arche === 'gauntlet' ? 2 + Math.floor(rng() * 3)       // 2-4
    : 3 + Math.floor(rng() * 2);                             // needle: 3-4

  const wantSpikes = arche === 'gauntlet' || arche === 'needle';
  const spikeChance = opts.noSpikes ? 0 : (wantSpikes ? 0.55 + d * 0.4 : 0.15 + d * 0.2);

  const ballX = Math.round(50 + rng() * 40);
  const ballY = Math.round(60 + rng() * 150);

  // goal pocket, right side of the world — same L-catch shape every hand-built level uses
  const pocketX2 = Math.round(780 + rng() * 90);
  const pocketFloorY = Math.round(480 + rng() * 90);
  const pocketShelfY = Math.round(pocketFloorY - (60 + rng() * 40));
  const pocketShelfX1 = Math.round(pocketX2 - (140 + rng() * 90));
  const goalR = Math.round(lerp(56, 44, d) - rng() * 4);
  const goalX = Math.round(pocketX2 + (960 - pocketX2) * (0.42 + rng() * 0.2));
  const goalY = Math.round(pocketFloorY - goalR * (0.5 + rng() * 0.15));

  const walls = [WALL_L, WALL_R];
  const spikes = [];

  // intermediate floating shelves. Consecutive connector strokes (previous shelf's
  // landing edge -> this shelf's takeoff edge) must stay well off vertical: a near-
  // vertical stroke reads as a ledge the ball can catch and rest dead on, rather than a
  // ramp it rolls down — a real physics trap, not a cosmetic issue, so the minimum
  // horizontal run between consecutive anchor points is enforced explicitly.
  const MIN_DX = 90;
  const shelves = [];
  let prevX2 = ballX;
  for (let i = 0; i < nSegments - 1; i++) {
    const tA = (i + 0.15) / nSegments, tB = (i + 0.85) / nSegments;
    let x1 = Math.round(lerp(ballX + 60, pocketShelfX1 - 40, tA) + (rng() - 0.5) * 24);
    if (x1 < prevX2 + MIN_DX) x1 = prevX2 + MIN_DX;
    const len = Math.round(90 + rng() * 90);
    const x2 = x1 + len;
    const y1 = Math.round(lerp(ballY + 130, pocketShelfY - 30, tB) + (rng() - 0.5) * 18);
    const y2 = y1 + Math.round(14 + rng() * 34);
    shelves.push({ x1, y1, x2, y2 });
    walls.push([x1, y1, x2, y2]);
    prevX2 = x2;
  }
  // the pocket's own takeoff edge must clear the same minimum from the last shelf, or
  // this draft is unusable — the caller (build driver) retries with a fresh seed.
  if (pocketShelfX1 < prevX2 + MIN_DX) {
    return { level: null, gaps: null, arche, minInk: 0 };
  }

  // the goal pocket itself
  walls.push([pocketShelfX1, pocketShelfY, pocketX2, pocketShelfY]);
  walls.push([pocketX2, pocketShelfY, pocketX2, pocketFloorY]);
  walls.push([pocketX2, pocketFloorY, 960, pocketFloorY]);

  // gaps a stroke must bridge: spawn -> shelf0 -> shelf1 -> ... -> pocket
  const chain = [{ x: ballX, y: ballY }, ...shelves.map((s) => ({ x: s.x1, y: s.y1, x2: s.x2, y2: s.y2 })),
    { x: pocketShelfX1, y: pocketShelfY }];
  const gaps = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const from = i === 0 ? chain[0] : { x: chain[i].x2, y: chain[i].y2 };
    const to = { x: chain[i + 1].x, y: chain[i + 1].y };
    gaps.push({ from, to });
    if (rng() < spikeChance) {
      const floorY = 566;
      const sx1 = Math.round(Math.min(from.x, to.x) - 20 + rng() * 15);
      const sx2 = Math.round(Math.max(from.x, to.x) + 20 - rng() * 15);
      if (sx2 - sx1 > 40) spikes.push([clamp(sx1, 20, 940), floorY, clamp(sx2, 20, 940), floorY]);
    }
  }

  // rough geometric minimum ink: straight-line length of every gap
  let minInk = 0;
  for (const g of gaps) minInk += Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y);
  minInk = Math.max(minInk, 40 * gaps.length);

  const tightness = lerp(1.6, 1.08, d);
  const ink = Math.ceil(minInk * tightness / 10) * 10;
  const par = Math.max(60, Math.round(minInk * 0.92));

  const level = {
    ink,
    par,
    ball: { x: ballX, y: ballY },
    goal: { x: clamp(goalX, 40, 940), y: clamp(goalY, 40, 560), r: goalR },
    walls,
    spikes,
  };

  return { level, gaps, arche, minInk };
}
