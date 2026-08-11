// Afterimage — procedural level generator + greedy scripted solver.
//
// Archetype: "chain". A level is a single-corridor-height room split into `par`
// sequential segments by full-height walls, each wall pierced only by a door tile
// at the walk row (every other row of that column is solid '#' — no ceiling gap,
// so a closed door can never be jumped or fallen over/under; this is the exact
// geometry rule that fixed the original single-life-exploit bug). Each segment has
// exactly one plate, matched 1:1 to the door in the following wall. The plate sits
// in a shallow alcove one row above the main corridor (mirrors the hand-designed
// "Two Hands" / "Three of a Kind" levels): you jump up into it from the corridor,
// land on top of it (one-way tile), and it becomes solid ground — so a ghost that
// stops there rests OUTSIDE the corridor's collision band and never blocks the
// live player's path back through. Segments may also contain 1-2 spike tiles in
// the corridor that must be hopped.
//
// Because each door requires a ghost standing exactly on its own plate, and a
// single live run can only ever occupy one column at a time, no chain level is
// completable single-life by construction. Every generated level is still verified
// against the real sim (both the winning multi-run solve AND a randomized
// single-life exploit search) before being accepted — belt and suspenders.
//
// difficulty index `idx` (0-based, 0..74) maps to a target `par` (required ghosts,
// 1..6, non-decreasing) and scales corridor length / spike density so levels
// escalate smoothly without repeating the same shape.

import {
  TILE, PW, PH, M_LEFT, M_RIGHT, M_JUMP,
  makeSim, stepSim, retryRun, replaySolution,
} from './sim.js';

const DT = 1 / 60;
const PLATE_CH = '123456';
const DOOR_CH = 'abcdef';
const ALCOVE_W = 3; // columns wide, gives the descending jump landing margin

// ---------------------------------------------------------------- seeded RNG

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- difficulty curve

export function parForIndex(idx) {
  return Math.min(6, 1 + Math.floor(idx / 12));
}

function tierOf(idx) {
  if (idx < 15) return 'intro';
  if (idx < 40) return 'combo';
  return 'gauntlet';
}

// ---------------------------------------------------------------- grid construction

// 5 rows: 0 ceiling, 1 alcove headroom, 2 alcove/plate band, 3 main corridor
// (walk row), 4 floor.
// Lays `len` open floor columns with AT MOST one hazard checkpoint in the whole
// stretch — same spirit as the original single-spike-per-run, just placed at a
// randomized position instead of always right after the lead-in, and occasionally a
// 2-tile cluster instead of always one (gauntlet-tier only — the scripted solver's
// spikeHop hold-through-landing logic is proven to clear a run of 2, so this stays
// inside its verified envelope). A per-column coin flip instead of one placement roll
// was tried first and produced 3-4 spikes per stretch on average at gauntlet density —
// unclearable by the solver's single-hazard state machine, hence "at most one."
function layFloor(walk, len, chance, allowCluster, rng) {
  const cluster = allowCluster && len >= 4 && rng() < 0.2;
  const hazardLen = cluster ? 2 : 1;
  const hasHazard = len >= hazardLen + 2 && rng() < chance;
  const at = hasHazard ? 1 + Math.floor(rng() * (len - hazardLen - 1)) : -1;
  for (let i = 0; i < len; i++) {
    walk.push(hasHazard && i >= at && i < at + hazardLen ? '^' : '.');
  }
}

export function buildGrid(par, idx, rng) {
  const tier = tierOf(idx);
  const walk = []; // row3 chars
  walk.push('#'); walk[0] = 'S'; // will overwrite border below; col0 is border+spawn

  const spikeChance = tier === 'intro' ? 0.10 : tier === 'combo' ? 0.18 : 0.25;
  const allowCluster = tier === 'gauntlet';
  // A pacing "beat" per segment, reused for both halves, so a level reads as having a
  // rhythm (tight-tight-tight, or long-short-long) rather than every segment being the
  // same length rolled from the same narrow range. This is the main lever against
  // every level feeling identical — length variety is felt far more than spike count.
  const BEATS = ['tight', 'long', 'even', 'sprint'];

  const alcoveCols = []; // { start, seg }
  const doorCols = []; // column index per segment

  for (let seg = 0; seg < par; seg++) {
    const extra = Math.floor(idx / 15);
    const beat = BEATS[Math.floor(rng() * BEATS.length)];
    const preBase = beat === 'tight' ? 2 : beat === 'sprint' ? 3 : beat === 'long' ? 7 : 4;
    const preSpread = beat === 'long' ? 5 : 3;
    const preLen = preBase + Math.floor(rng() * preSpread) + extra;
    layFloor(walk, preLen, spikeChance, allowCluster, rng);
    // gap before alcove so the jump has a clean run-up
    const gap2 = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < gap2; i++) walk.push('.');

    const alcoveStart = walk.length;
    for (let i = 0; i < ALCOVE_W; i++) walk.push('.'); // row3 stays open under alcove
    alcoveCols.push({ start: alcoveStart, seg });

    const postBase = beat === 'tight' ? 3 : beat === 'long' ? 6 : 4;
    const postLen = postBase + Math.floor(rng() * 3);
    layFloor(walk, postLen, tier === 'intro' ? spikeChance * 0.4 : spikeChance * 0.7, allowCluster, rng);
    for (let i = 0; i < 2; i++) walk.push('.');

    doorCols.push(walk.length);
    walk.push(DOOR_CH[seg]);
  }
  const tail = 5 + Math.floor(rng() * 5);
  for (let i = 0; i < tail; i++) walk.push('.');
  walk.push('G');
  walk.push('#');

  const totalCols = walk.length;
  const rows = [];
  rows.push('#'.repeat(totalCols)); // row0 ceiling
  // row1: open air everywhere except border/door columns
  // row2: alcove plate band — plate chars at each alcove's columns, else open,
  //        except border/door columns which stay solid (full-height wall).
  const isWallCol = new Array(totalCols).fill(false);
  isWallCol[0] = true; isWallCol[totalCols - 1] = true;
  for (const dc of doorCols) isWallCol[dc] = true;

  let row1 = '', row2 = '';
  for (let c = 0; c < totalCols; c++) {
    if (isWallCol[c]) { row1 += '#'; row2 += '#'; continue; }
    row1 += '.';
    const alc = alcoveCols.find((a) => c >= a.start && c < a.start + ALCOVE_W);
    row2 += alc ? PLATE_CH[alc.seg] : '.';
  }
  rows.push(row1, row2, walk.join(''), '#'.repeat(totalCols));
  return { grid: rows, cols: totalCols, alcoveCols, doorCols };
}

// ---------------------------------------------------------------- greedy scripted solver

// Steers the live player rightward toward an x target, optionally hopping onto an
// alcove plate along the way. Records an RLE input script. `climb`, if given, is
// { triggerCol, plateColStart } — press jump once the player nears triggerCol,
// then stop steering horizontally once it lands somewhere elevated (on the plate).
export function steerTo(sim, level, targetCol, climb, maxFrames, leadWait = 0) {
  const rle = [];
  let curMask = -1, curRun = 0;
  function push(mask) {
    if (mask === curMask) { curRun++; return; }
    if (curRun > 0) rle.push([curRun, curMask]);
    curMask = mask; curRun = 1;
  }
  // Every run starts back at spawn, which re-plays every previously archived ghost
  // in lockstep from frame 0. If this run's own path overlaps a ghost still mid-
  // transit, the (one-directional) rigid collision can trail the live player behind
  // it indefinitely. Waiting here first lets every existing ghost exhaust its
  // recorded inputs and come to rest off to the side (on its plate) before the live
  // player starts moving, so the corridor is guaranteed static.
  for (let w = 0; w < leadWait; w++) {
    push(0);
    stepSim(sim, 0, DT);
    if (sim.dead) return { ok: false, rle: (() => { if (curRun > 0) rle.push([curRun, curMask]); return rle; })() };
  }
  const targetX = targetCol * TILE + TILE / 2;
  let phase = climb ? 'approach' : 'run'; // approach -> jumping -> landed -> run
  let settleFrames = 0;
  const corridorY = level.spawn.y * TILE + (TILE - PH) / 2; // approx resting y at ground level
  // true if a spike sits within the next ~2 tiles ahead on the walk row — checked
  // with enough lead distance that pressing jump now clears it with margin.
  // A full-height jump only stays clear of the walk-row hazard band (its box drops
  // back below y~37 well before it actually lands) for roughly ~2 tiles of travel.
  // So only trigger when the spike is the very next tile — jumping any earlier
  // means the descent re-enters the hazard band right on top of it.
  function findSpikeAhead(p) {
    const curCol = Math.floor((p.x + PW / 2) / TILE);
    const c = curCol + 1;
    return (c >= 0 && c < level.cols && level.grid[3][c] === '^') ? c : -1;
  }
  let spikeHop = false, hopClearX = 0; // hold jump+right until just past the spike's column
  for (let f = 0; f < maxFrames; f++) {
    const p = sim.player;
    let mask = 0;

    if (spikeHop) {
      if (p.x + PW / 2 > hopClearX && p.onGround) spikeHop = false;
    } else {
      const sc = findSpikeAhead(p);
      if (sc >= 0 && p.onGround) { spikeHop = true; hopClearX = (sc + 1) * TILE; }
    }

    if (phase === 'approach') {
      const triggerX = climb.triggerCol * TILE + TILE / 2;
      const dx = triggerX - (p.x + PW / 2);
      if (dx > 1) mask |= M_RIGHT;
      if (spikeHop) mask |= M_JUMP | M_RIGHT;
      else if (Math.abs(dx) <= 6 && p.onGround) { mask |= M_JUMP | M_RIGHT; phase = 'jumping'; }
    } else if (phase === 'jumping') {
      mask = M_RIGHT | M_JUMP;
      if (p.vy >= 0 && p.y < corridorY - 8) phase = 'falling';
    } else if (phase === 'falling') {
      mask = M_RIGHT;
      if (p.onGround) {
        phase = p.y < corridorY - 6 ? 'landed' : 'missed';
      }
    } else if (phase === 'landed') {
      mask = 0;
      settleFrames++;
      if (settleFrames > 14) { push(mask); stepSim(sim, mask, DT); return { ok: true, rle: finish() }; }
    } else if (phase === 'missed') {
      return { ok: false, rle: finish() };
    } else { // plain run toward a floor target (spikes / goal)
      const dx = targetX - (p.x + PW / 2);
      if (dx > 2) mask |= M_RIGHT; else if (dx < -2) mask |= M_LEFT;
      if (spikeHop) mask |= M_JUMP | M_RIGHT;
      const onTarget = !spikeHop && Math.abs(dx) <= 2 && Math.abs(p.vx) < 2 && p.onGround;
      if (onTarget) {
        settleFrames++;
        if (settleFrames > 12) { push(mask); stepSim(sim, mask, DT); f++; break; }
      } else settleFrames = 0;
    }

    push(mask);
    stepSim(sim, mask, DT);
    if (sim.dead) return { ok: false, rle: finish() };
    if (sim.won) return { ok: true, rle: finish(), won: true };
  }
  function finish() { if (curRun > 0) rle.push([curRun, curMask]); return rle; }
  if (phase === 'landed' || phase === 'run') {
    for (let k = 0; k < 18; k++) {
      push(0);
      stepSim(sim, 0, DT);
      if (sim.dead) return { ok: false, rle: finish() };
      if (sim.won) return { ok: true, rle: finish(), won: true };
    }
    return { ok: true, rle: finish(), won: sim.won };
  }
  return { ok: false, rle: finish() };
}

// Attempts to solve a chain level. Returns { ok, solution }.
export function solveChain(levelDef, par, alcoveCols) {
  const sim = makeSim(0, [levelDef]);
  const level = sim.level;
  const runs = [];
  let goalCol = -1;
  for (let c = 0; c < level.cols; c++) if (level.grid[3][c] === 'G') { goalCol = c; break; }

  let maxRunFrames = 0;
  function runLen(rle) { return rle.reduce((s, [f]) => s + f, 0); }

  for (let seg = 0; seg < par; seg++) {
    const a = alcoveCols[seg];
    const triggerCol = a.start + 1; // jump roughly under the alcove's middle column
    const res = steerTo(sim, level, triggerCol, { triggerCol }, maxRunFrames + 600, maxRunFrames);
    if (!res.ok || res.won) return { ok: false };
    runs.push(res.rle);
    maxRunFrames = Math.max(maxRunFrames, runLen(res.rle));
    retryRun(sim, false);
  }
  const final = steerTo(sim, level, goalCol, null, maxRunFrames + 1400, maxRunFrames);
  if (!final.ok || !final.won) return { ok: false };
  runs.push(final.rle);
  return { ok: true, runs };
}

// ---------------------------------------------------------------- single-life exploit search

export function singleLifeExploitFound(levelDef, attempts, rng) {
  const masks = [0, M_LEFT, M_RIGHT, M_JUMP, M_RIGHT | M_JUMP, M_LEFT | M_JUMP];
  for (let a = 0; a < attempts; a++) {
    const sim = makeSim(0, [levelDef]);
    const maxFrames = 60 * 18;
    let cur = M_RIGHT, hold = 0;
    for (let f = 0; f < maxFrames; f++) {
      if (hold <= 0) {
        const r = rng();
        cur = r < 0.55 ? M_RIGHT : r < 0.75 ? (M_RIGHT | M_JUMP) : masks[Math.floor(rng() * masks.length)];
        hold = 3 + Math.floor(rng() * 20);
      }
      hold--;
      stepSim(sim, cur, DT);
      if (sim.won) return true;
      if (sim.dead) break;
    }
  }
  return false;
}

// ---------------------------------------------------------------- public generator entry

export function generateLevel(idx, baseSeed, exploitAttempts = 400) {
  const par = parForIndex(idx);
  let attempt = 0;
  while (attempt < 80) {
    attempt++;
    const seed = baseSeed + idx * 9973 + attempt * 104729;
    const rng = mulberry32(seed);
    const { grid, alcoveCols } = buildGrid(par, idx, rng);
    const levelDef = { name: `Chain ${idx}`, hint: '', par, grid };
    const solved = solveChain(levelDef, par, alcoveCols);
    if (!solved.ok) continue;
    const replay = replaySolution(0, [levelDef], solved.runs);
    if (!replay.won) continue;
    if (replay.runsUsed !== par + 1) continue;
    const exploitRng = mulberry32(seed ^ 0x9e3779b9);
    if (singleLifeExploitFound(levelDef, exploitAttempts, exploitRng)) continue;
    return { ok: true, par, grid, solution: solved.runs, seed, attempts: attempt };
  }
  return { ok: false, par };
}
