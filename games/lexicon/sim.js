// Lexicon — pure simulation. No DOM, no Math.random, no Date.now.
//
// Everything the game IS lives here: impulse-based tile physics, the touching-tiles
// selection graph, word validation, scoring and chains, spawn escalation, the
// overflow lose condition, and the hint search. game.js only draws it and feeds
// it an intent. The self-test and the headless node checks call the exact same
// stepSim(), so what you verify is what you play.

import { RNG, clamp } from '../../shared/kit.js';
import { isWord, words } from './words.js';

// ---------------------------------------------------------------- world constants

export const WORLD_W = 420;
export const WORLD_H = 580;
export const TILE_R = 24;
export const DANGER_Y = 104;      // resting above this line = overflowing
export const TOUCH_TOL = 5;       // circles this close still count as "touching"
export const MAX_TILES = 132;
export const MIN_WORD = 3;
export const MAX_WORD = 8;
export const CHAIN_WINDOW = 2.6;  // seconds to land the next clear
export const HINT_DELAY = 7;      // seconds of nothing before a tile pulses

// physics — semi-implicit Euler + sequential-impulse contact solver.
// Velocity impulses accumulate per contact (so a deep stack actually converges to
// rest) and penetration is fixed in a separate position pass that never touches
// velocity — that split is what stops a settled pile from jittering forever.
const GRAVITY = 980;
const DAMP = 0.999;               // per-step velocity retention
const MAXV = 620;                 // world units/sec — also prevents tunnelling
const VEL_ITER = 8;
const POS_ITER = 4;
const REST = 0.12;                // restitution, only above IMPACT_V
const IMPACT_V = 90;              // below this a contact is inelastic
const MU = 0.45;                  // contact friction
const POS_SLOP = 0.05;
const POS_RELAX = 0.5;
const SQUASH_V = 150;
const SLEEP_V = 10.0;             // world units/sec (0.17 px/frame — invisible)
const SLEEP_FRAMES = 16;
const WAKE_OVERLAP = 3.5;

// ---------------------------------------------------------------- letters

const VOWELS = 'aeiou';
const RARE = 'jqxz';

// Roughly English letter frequency, nudged toward vowels and away from the
// unplayable tail. Weights are per-1000.
const FREQ = {
  a: 90, b: 18, c: 32, d: 40, e: 118, f: 18, g: 22, h: 32, i: 80, j: 2,
  k: 12, l: 50, m: 28, n: 62, o: 78, p: 26, q: 2, r: 62, s: 66, t: 70,
  u: 38, v: 10, w: 14, x: 2, y: 22, z: 2,
};

export const LETTER_VALUE = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3,
  n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10,
};

function makeTable(filter) {
  const rows = [];
  let acc = 0;
  for (const k of Object.keys(FREQ)) {
    if (filter && !filter(k)) continue;
    acc += FREQ[k];
    rows.push([k, acc]);
  }
  return { rows, total: acc };
}
const T_ALL = makeTable(null);
const T_VOWEL = makeTable((k) => VOWELS.includes(k));
const T_CONS = makeTable((k) => !VOWELS.includes(k));

function weightedPick(rng, table) {
  const r = rng.next() * table.total;
  const rows = table.rows;
  for (let i = 0; i < rows.length; i++) if (r < rows[i][1]) return rows[i][0];
  return rows[rows.length - 1][0];
}

/**
 * Keeps the pile solvable: never a wall of consonants, never a puddle of vowels.
 * The floor/ceiling and rare-letter cap are read off the sim so campaign stages
 * can skew the distribution (more consonants at higher stages) without ever
 * being able to push it out of a playable range — see clamps in makeSim().
 */
export function pickLetter(sim) {
  const tiles = sim.tiles;
  const vowelFloor = sim.vowelFloor === undefined ? 0.30 : sim.vowelFloor;
  const vowelCeil = sim.vowelCeil === undefined ? 0.55 : sim.vowelCeil;
  const rareCap = sim.rareCap === undefined ? 2 : sim.rareCap;
  let v = 0, rare = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (VOWELS.includes(tiles[i].letter)) v++;
    if (RARE.includes(tiles[i].letter)) rare++;
  }
  const ratio = tiles.length ? v / tiles.length : 0.38;
  if (tiles.length >= 6 && ratio < vowelFloor) return weightedPick(sim.rng, T_VOWEL);
  if (tiles.length >= 6 && ratio > vowelCeil) return weightedPick(sim.rng, T_CONS);
  let l = weightedPick(sim.rng, T_ALL);
  if (RARE.includes(l) && rare >= rareCap) l = weightedPick(sim.rng, T_CONS);
  if (RARE.includes(l) && rare >= rareCap) l = weightedPick(sim.rng, T_VOWEL);
  return l;
}

// ---------------------------------------------------------------- scoring

export const LEN_MULT = { 3: 1, 4: 1.6, 5: 2.4, 6: 3.4, 7: 4.6, 8: 6 };
export const chainMult = (chain) => 1 + 0.6 * chain;

export function scoreFor(word, chain = 0) {
  let base = 0;
  for (let i = 0; i < word.length; i++) base += LETTER_VALUE[word[i]] || 1;
  const lm = LEN_MULT[word.length] || 1;
  return Math.round(base * lm * chainMult(chain) * 5);
}

// ---------------------------------------------------------------- broadphase (spatial hash)

const CELL = TILE_R * 2.4;
const _cells = new Map();
const _pairs = [];
const _pairs2 = [];

const cellKey = (cx, cy) => (cx + 64) * 512 + (cy + 64);

/** Flat [i0,j0, i1,j1, ...] index pairs closer than `reach`. */
function buildPairs(tiles, reach, out) {
  _cells.clear();
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const k = cellKey(Math.floor(t.x / CELL), Math.floor(t.y / CELL));
    let a = _cells.get(k);
    if (!a) { a = []; _cells.set(k, a); }
    a.push(i);
  }
  out.length = 0;
  const r2 = reach * reach;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const cx = Math.floor(t.x / CELL), cy = Math.floor(t.y / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const a = _cells.get(cellKey(cx + ox, cy + oy));
        if (!a) continue;
        for (let n = 0; n < a.length; n++) {
          const j = a[n];
          if (j <= i) continue;
          const dx = tiles[j].x - t.x, dy = tiles[j].y - t.y;
          if (dx * dx + dy * dy < r2) { out.push(i); out.push(j); }
        }
      }
    }
  }
  return out;
}

/** adjacency[i] = array of tile indices whose circles touch tile i. */
export function adjacencyOf(tiles) {
  const adj = [];
  for (let i = 0; i < tiles.length; i++) adj.push([]);
  buildPairs(tiles, TILE_R * 2 + TOUCH_TOL, _pairs2);
  for (let p = 0; p < _pairs2.length; p += 2) {
    const i = _pairs2[p], j = _pairs2[p + 1];
    const a = tiles[i], b = tiles[j];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d <= a.r + b.r + TOUCH_TOL) { adj[i].push(j); adj[j].push(i); }
  }
  return adj;
}

export function adjacent(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= a.r + b.r + TOUCH_TOL;
}

// ---------------------------------------------------------------- sim construction

export function addTile(sim, letter, x, y) {
  const t = {
    id: sim.nextId++, letter,
    x, y, vx: 0, vy: 0, r: TILE_R,
    still: 0, asleep: false, speed: 0, squash: 0, born: sim.t,
  };
  sim.tiles.push(t);
  return t;
}

function spawnInterval(sim) {
  return clamp(1.6 - sim.t * 0.007, 0.55, 1.6) * sim.spawnScale;
}

/** Drop into whichever of two sampled columns is currently lower. */
function spawnTile(sim) {
  const letter = pickLetter(sim);
  const margin = TILE_R + 2;
  let bestX = margin, bestTop = -Infinity;
  for (let k = 0; k < 2; k++) {
    const x = margin + sim.rng.next() * (WORLD_W - margin * 2);
    let top = WORLD_H;
    for (let i = 0; i < sim.tiles.length; i++) {
      const t = sim.tiles[i];
      if (Math.abs(t.x - x) < TILE_R * 1.7) top = Math.min(top, t.y);
    }
    if (top > bestTop) { bestTop = top; bestX = x; }
  }
  sim.dropped++;
  return addTile(sim, letter, bestX, -TILE_R - 6);
}

export function makeSim(seed = 1, opts = {}) {
  const sim = {
    seed,
    rng: new RNG(seed),
    tiles: [],
    nextId: 1,
    t: 0,
    frames: 0,
    score: 0,
    wordsMade: 0,
    chain: 0,
    chainT: 0,
    bestChain: 0,
    sel: [],
    word: '',
    valid: false,
    preview: 0,
    prevDown: false,
    ppx: 0, ppy: 0, hasPP: false,
    spawnT: 0,
    spawnScale: opts.spawnScale === undefined ? 1 : opts.spawnScale,
    autoSpawn: opts.autoSpawn !== false,
    dropped: 0,
    over: false,
    overflowT: 0,
    idleT: 0,
    hintIds: [],
    hintWord: '',
    longest: '',
    lastWord: '',
    lastGain: 0,
    lastMult: 1,
    badFlash: 0,
    impact: 0,
    events: [],
    impulses: new Map(),   // warm-start cache, keyed by contact
    // campaign tuning — clamped so no combination can make the pile unsolvable
    vowelFloor: opts.vowelFloor === undefined ? 0.30 : clamp(opts.vowelFloor, 0.20, 0.32),
    vowelCeil: opts.vowelCeil === undefined ? 0.55 : clamp(opts.vowelCeil, 0.55, 0.65),
    rareCap: opts.rareCap === undefined ? 2 : clamp(opts.rareCap, 2, 3),
    dangerY: opts.dangerY === undefined ? DANGER_Y : clamp(opts.dangerY, DANGER_Y, DANGER_Y + 60),
    target: opts.target || 0,          // 0 = endless (no clear condition)
    cleared: false,
  };
  // Opening rain: a curtain of tiles already on the way down.
  const prefill = opts.prefill === undefined ? 16 : opts.prefill;
  const margin = TILE_R + 2;
  for (let i = 0; i < prefill; i++) {
    const t = addTile(sim, pickLetter(sim), margin + sim.rng.next() * (WORLD_W - margin * 2), -TILE_R - 8 - i * 44);
    sim.dropped++;
    t.vy = 60;
  }
  sim.spawnT = spawnInterval(sim);
  return sim;
}

// ---------------------------------------------------------------- physics

function wake(t) {
  if (!t.asleep) return;
  t.asleep = false;
  t.still = 0;
}

export function wakeAll(sim) {
  for (let i = 0; i < sim.tiles.length; i++) wake(sim.tiles[i]);
}

// Contact pool — reused every frame so a full jar allocates nothing.
const STATIC = { x: 0, y: 0, vx: 0, vy: 0, asleep: true, r: 0, id: -1 };
const _pool = [];
let _nc = 0;

function newContact(key, cache) {
  if (_nc >= _pool.length) _pool.push({ ai: 0, bi: -1, nx: 0, ny: 0, pd: 0, ni: 0, ti: 0, key: 0 });
  const c = _pool[_nc++];
  c.key = key;
  const w = cache.get(key);
  // Warm start: last frame's impulse is this frame's first guess. Without it a
  // deep stack never converges in a handful of iterations and creeps forever.
  c.ni = w ? w[0] : 0;
  c.ti = w ? w[1] : 0;
  return c;
}

function addWallContact(i, key, cache, nx, ny, pd) {
  const c = newContact(key, cache);
  c.ai = i; c.bi = -1; c.nx = nx; c.ny = ny; c.pd = pd;
  return c;
}

function buildContacts(sim, tiles) {
  _nc = 0;
  STATIC.vx = 0; STATIC.vy = 0; STATIC.x = 0; STATIC.y = 0;
  const cache = sim.impulses;
  buildPairs(tiles, TILE_R * 2 + 1, _pairs);
  for (let p = 0; p < _pairs.length; p += 2) {
    const i = _pairs[p], j = _pairs[p + 1];
    const a = tiles[i], b = tiles[j];
    let dx = b.x - a.x, dy = b.y - a.y;
    const rr = a.r + b.r;
    let d = Math.hypot(dx, dy);
    if (!(d < rr)) continue;   // NaN-safe: an unknown distance is never a contact
    const pen = rr - d;
    // Only a MOVING tile wakes a sleeper. Two sleepers jammed against the walls
    // can legitimately rest inside each other; waking them on penetration alone
    // makes the whole pile breathe forever.
    if (pen > WAKE_OVERLAP) {
      if (!a.asleep) wake(b);
      else if (!b.asleep) wake(a);
    }
    if (d < 1e-5) { dx = (a.id + b.id) % 2 ? 1 : -1; dy = -1; d = Math.hypot(dx, dy); }
    const nx = dx / d, ny = dy / d;
    const c = newContact(a.id * 8388608 + b.id, cache);
    c.ai = i; c.bi = j; c.nx = nx; c.ny = ny; c.pd = 0;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < -SQUASH_V) {
      const s = Math.min(1, (-vn - SQUASH_V) / 520);
      if (s > a.squash) a.squash = s;
      if (s > b.squash) b.squash = s;
      if (s > sim.impact) sim.impact = s;
    }
  }
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const r = t.r;
    if (t.x < r) addWallContact(i, -(t.id * 4 + 1), cache, -1, 0, -r);
    else if (t.x > WORLD_W - r) addWallContact(i, -(t.id * 4 + 2), cache, 1, 0, WORLD_W - r);
    if (t.y > WORLD_H - r) {
      addWallContact(i, -(t.id * 4 + 3), cache, 0, 1, WORLD_H - r);
      if (t.vy > SQUASH_V) {
        const s = Math.min(1, (t.vy - SQUASH_V) / 520);
        if (s > t.squash) t.squash = s;
        if (s > sim.impact) sim.impact = s;
      }
    }
  }
}

function warmStart(tiles) {
  for (let k = 0; k < _nc; k++) {
    const c = _pool[k];
    const a = tiles[c.ai];
    const b = bodyOf(tiles, c.bi);
    const px = c.nx * c.ni - c.ny * c.ti;
    const py = c.ny * c.ni + c.nx * c.ti;
    if (invMass(a, c.ai)) { a.vx -= px; a.vy -= py; }
    if (invMass(b, c.bi)) { b.vx += px; b.vy += py; }
  }
}

function storeImpulses(sim) {
  const next = new Map();
  for (let k = 0; k < _nc; k++) {
    const c = _pool[k];
    if (c.ni !== 0 || c.ti !== 0) next.set(c.key, [c.ni, c.ti]);
  }
  sim.impulses = next;
}

const bodyOf = (tiles, i) => (i < 0 ? STATIC : tiles[i]);
const invMass = (t, i) => (i < 0 || t.asleep ? 0 : 1);

function penOf(c, a, b) {
  if (c.bi < 0) return a.x * c.nx + a.y * c.ny - c.pd;
  return a.r + b.r - Math.hypot(b.x - a.x, b.y - a.y);
}

function solveVelocity(tiles) {
  for (let k = 0; k < _nc; k++) {
    const c = _pool[k];
    const a = tiles[c.ai];
    const b = bodyOf(tiles, c.bi);
    const ima = invMass(a, c.ai), imb = invMass(b, c.bi);
    const sum = ima + imb;
    if (sum === 0) continue;

    const vn = (b.vx - a.vx) * c.nx + (b.vy - a.vy) * c.ny;
    const bias = vn < -IMPACT_V ? -REST * vn : 0;
    let lam = -(vn - bias) / sum;
    const oldN = c.ni;
    c.ni = Math.max(0, oldN + lam);
    lam = c.ni - oldN;
    if (ima) { a.vx -= c.nx * lam; a.vy -= c.ny * lam; }
    if (imb) { b.vx += c.nx * lam; b.vy += c.ny * lam; }

    const tx = -c.ny, ty = c.nx;
    const vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty;
    const maxF = MU * c.ni;
    const oldT = c.ti;
    c.ti = clamp(oldT - vt / sum, -maxF, maxF);
    const lt = c.ti - oldT;
    if (ima) { a.vx -= tx * lt; a.vy -= ty * lt; }
    if (imb) { b.vx += tx * lt; b.vy += ty * lt; }
  }
}

/**
 * Penetration only — never touches velocity, so it cannot pump energy in.
 * Sleeping tiles DO get separated here (a frozen overlap would otherwise wake
 * its neighbours forever), but they are not woken by it.
 */
function solvePosition(tiles) {
  for (let k = 0; k < _nc; k++) {
    const c = _pool[k];
    const a = tiles[c.ai];
    const b = bodyOf(tiles, c.bi);
    const ima = 1, imb = c.bi < 0 ? 0 : 1;
    const sum = ima + imb;
    const pen = penOf(c, a, b);
    if (!(pen > POS_SLOP)) continue;
    const corr = (pen - POS_SLOP) * POS_RELAX / sum;
    if (ima) { a.x -= c.nx * corr; a.y -= c.ny * corr; }
    if (imb) { b.x += c.nx * corr; b.y += c.ny * corr; }
  }
}

function physics(sim, dt) {
  const tiles = sim.tiles;

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.squash > 0) t.squash = Math.max(0, t.squash - dt * 4.5);
    if (t.asleep) { t.vx = 0; t.vy = 0; t.speed = 0; continue; }
    t.vy += GRAVITY * dt;
    t.vx *= DAMP; t.vy *= DAMP;
    t.vx = clamp(t.vx, -MAXV, MAXV);
    t.vy = clamp(t.vy, -MAXV, MAXV);
    t.x += t.vx * dt;
    t.y += t.vy * dt;
  }

  buildContacts(sim, tiles);
  warmStart(tiles);
  for (let it = 0; it < VEL_ITER; it++) solveVelocity(tiles);
  storeImpulses(sim);
  for (let it = 0; it < POS_ITER; it++) solvePosition(tiles);

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    // Belt and braces: a rogue non-finite tile is re-dropped rather than
    // allowed to poison every distance test it touches.
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.vx) || !Number.isFinite(t.vy)) {
      t.x = WORLD_W / 2; t.y = -t.r; t.vx = 0; t.vy = 0;
    }
    // hard containment — the solver is soft, the jar is not
    if (t.x < t.r) { t.x = t.r; if (t.vx < 0) t.vx = 0; }
    else if (t.x > WORLD_W - t.r) { t.x = WORLD_W - t.r; if (t.vx > 0) t.vx = 0; }
    if (t.y > WORLD_H - t.r) { t.y = WORLD_H - t.r; if (t.vy > 0) t.vy = 0; }
    if (t.asleep) continue;

    const sp = Math.hypot(t.vx, t.vy);
    t.speed = sp;
    if (sp < SLEEP_V) t.still++; else t.still = 0;
    if (t.still >= SLEEP_FRAMES) { t.asleep = true; t.vx = 0; t.vy = 0; t.speed = 0; }
  }
}

// ---------------------------------------------------------------- selection

function tileAt(sim, x, y) {
  let best = null, bd = Infinity;
  for (let i = 0; i < sim.tiles.length; i++) {
    const t = sim.tiles[i];
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < t.r * 0.95 && d < bd) { bd = d; best = t; }
  }
  return best;
}

export function tileById(sim, id) {
  for (let i = 0; i < sim.tiles.length; i++) if (sim.tiles[i].id === id) return sim.tiles[i];
  return null;
}

export function selWord(sim) {
  let w = '';
  for (let i = 0; i < sim.sel.length; i++) {
    const t = tileById(sim, sim.sel[i]);
    if (t) w += t.letter;
  }
  return w;
}

function touch(sim, x, y) {
  const hit = tileAt(sim, x, y);
  if (!hit) return;
  const n = sim.sel.length;
  if (n === 0) {
    sim.sel.push(hit.id);
    sim.events.push({ type: 'pick', n: 1, x: hit.x, y: hit.y });
    return;
  }
  if (sim.sel[n - 1] === hit.id) return;
  if (n >= 2 && sim.sel[n - 2] === hit.id) {
    sim.sel.pop();
    sim.events.push({ type: 'unpick', n: sim.sel.length, x: hit.x, y: hit.y });
    return;
  }
  if (sim.sel.indexOf(hit.id) >= 0 || n >= MAX_WORD) return;
  const last = tileById(sim, sim.sel[n - 1]);
  if (last && adjacent(last, hit)) {
    sim.sel.push(hit.id);
    sim.events.push({ type: 'pick', n: sim.sel.length, x: hit.x, y: hit.y });
  }
}

function removeIds(sim, ids) {
  const drop = new Set(ids);
  sim.tiles = sim.tiles.filter((t) => !drop.has(t.id));
  wakeAll(sim);
}

function commit(sim) {
  const word = selWord(sim);
  if (word.length >= MIN_WORD && isWord(word)) {
    const chain = sim.chainT > 0 ? sim.chain + 1 : 0;
    const gain = scoreFor(word, chain);
    const pts = [];
    for (let i = 0; i < sim.sel.length; i++) {
      const t = tileById(sim, sim.sel[i]);
      if (t) pts.push({ x: t.x, y: t.y, letter: t.letter });
    }
    sim.chain = chain;
    sim.chainT = CHAIN_WINDOW;
    if (chain > sim.bestChain) sim.bestChain = chain;
    sim.score += gain;
    sim.lastGain = gain;
    sim.lastWord = word;
    sim.lastMult = chainMult(chain);
    sim.wordsMade++;
    if (word.length > sim.longest.length) sim.longest = word;
    removeIds(sim, sim.sel);
    sim.events.push({ type: 'clear', word, gain, chain, pts });
    sim.idleT = 0;
    sim.hintIds = [];
    sim.hintWord = '';
  } else if (word.length > 0) {
    sim.events.push({ type: 'reject', word });
    sim.badFlash = 1;
  }
  sim.sel = [];
}

function updateSelection(sim, intent, dt) {
  const p = intent && intent.pointer ? intent.pointer : null;
  const down = !!(p && p.down);

  if (sim.over) {
    sim.sel = [];
    sim.prevDown = down;
    sim.hasPP = false;
    return;
  }

  if (down) {
    const x = p.x, y = p.y;
    if (!sim.prevDown) {
      sim.sel = [];
      sim.idleT = 0;
      sim.hintIds = [];
      sim.hintWord = '';
      sim.hasPP = false;
    }
    // Sample along the drag segment so a fast flick can't skip a tile.
    if (sim.hasPP) {
      const dx = x - sim.ppx, dy = y - sim.ppy;
      const steps = clamp(Math.ceil(Math.hypot(dx, dy) / 8), 1, 12);
      for (let k = 1; k <= steps; k++) touch(sim, sim.ppx + dx * (k / steps), sim.ppy + dy * (k / steps));
    } else {
      touch(sim, x, y);
    }
    sim.ppx = x; sim.ppy = y; sim.hasPP = true;
  } else {
    sim.hasPP = false;
  }

  const submit = (!down && sim.prevDown) || !!(intent && intent.submit);
  sim.prevDown = down;
  if (submit && sim.sel.length > 0) commit(sim);

  sim.word = selWord(sim);
  sim.valid = sim.word.length >= MIN_WORD && isWord(sim.word);
  sim.preview = sim.valid ? scoreFor(sim.word, sim.chainT > 0 ? sim.chain + 1 : 0) : 0;
}

// ---------------------------------------------------------------- hint search

let _prefix = null;
/** Prefixes of length 3 and 4 — cheap pruning that keeps the DFS near-exhaustive. */
function prefixSet() {
  if (_prefix) return _prefix;
  _prefix = new Set();
  for (const w of words()) {
    if (w.length >= 3) _prefix.add(w.slice(0, 3));
    if (w.length >= 4) _prefix.add(w.slice(0, 4));
  }
  return _prefix;
}

/**
 * Depth-first walk of the touching-tiles graph for any valid word.
 * Returns { ids, word } or null. Used for the hint pulse and by the
 * headless playability check.
 */
export function findWord(sim, opts = {}) {
  const maxLen = opts.maxLen === undefined ? 6 : opts.maxLen;
  const budget = opts.budget === undefined ? 150000 : opts.budget;
  const tiles = sim.tiles;
  const n = tiles.length;
  if (n < MIN_WORD) return null;
  const pre = prefixSet();
  const adj = adjacencyOf(tiles);
  const used = new Uint8Array(n);
  const path = [];
  let steps = 0;
  let found = null;

  function dfs(i, word) {
    if (found || ++steps > budget) return;
    const w = word + tiles[i].letter;
    if (w.length >= 3 && !pre.has(w.slice(0, 3))) return;
    if (w.length >= 4 && !pre.has(w.slice(0, 4))) return;
    path.push(i); used[i] = 1;
    if (w.length >= MIN_WORD && isWord(w)) {
      found = { ids: path.map((k) => tiles[k].id), word: w };
    } else if (w.length < maxLen) {
      const list = adj[i];
      for (let k = 0; k < list.length && !found; k++) {
        const j = list[k];
        if (!used[j]) dfs(j, w);
      }
    }
    used[i] = 0; path.pop();
  }

  for (let i = 0; i < n && !found; i++) dfs(i, '');
  return found;
}

// ---------------------------------------------------------------- step

/**
 * One fixed simulation step.
 * intent = { pointer: {x, y, down}, submit }  — all coordinates are WORLD units.
 */
export function stepSim(sim, intent, dt) {
  sim.events.length = 0;
  sim.impact = 0;

  if (sim.badFlash > 0) sim.badFlash = Math.max(0, sim.badFlash - dt * 3);

  // --- spawning
  if (!sim.over && sim.autoSpawn) {
    sim.spawnT -= dt;
    if (sim.spawnT <= 0) {
      if (sim.tiles.length < MAX_TILES) spawnTile(sim);
      sim.spawnT += Math.max(0.08, spawnInterval(sim));
    }
  }

  physics(sim, dt);
  updateSelection(sim, intent, dt);

  // --- chain window
  if (sim.chainT > 0) {
    sim.chainT -= dt;
    if (sim.chainT <= 0) { sim.chainT = 0; sim.chain = 0; }
  }

  // --- stage clear (campaign only — target === 0 means endless, never clears)
  if (!sim.over && !sim.cleared && sim.target > 0 && sim.score >= sim.target) {
    sim.cleared = true;
    sim.events.push({ type: 'cleared', score: sim.score });
  }

  // --- overflow / lose
  if (!sim.over) {
    let bad = false;
    for (let i = 0; i < sim.tiles.length; i++) {
      const t = sim.tiles[i];
      if ((t.asleep || t.still > 8) && t.y - t.r < sim.dangerY) { bad = true; break; }
    }
    sim.overflowT = bad ? sim.overflowT + dt : Math.max(0, sim.overflowT - dt * 1.5);
    if (sim.overflowT > 1.5) {
      sim.over = true;
      sim.sel = [];
      sim.events.push({ type: 'over', score: sim.score });
    }
  }

  // --- idle hint
  if (!sim.over) {
    sim.idleT += dt;
    if (sim.hintIds.length === 0 && sim.idleT > HINT_DELAY && sim.frames % 30 === 0) {
      const hit = findWord(sim);
      if (hit) { sim.hintIds = hit.ids; sim.hintWord = hit.word; }
    }
  }

  sim.t += dt;
  sim.frames++;
  return sim;
}

// ---------------------------------------------------------------- verification helpers

/** Sum of 1/2 m v^2 with m = 1. Near zero once the pile has settled. */
export function totalKE(sim) {
  let ke = 0;
  for (let i = 0; i < sim.tiles.length; i++) {
    const v = sim.tiles[i].speed;
    ke += 0.5 * v * v;
  }
  return ke;
}

export function maxOverlap(sim) {
  const tiles = sim.tiles;
  let worst = 0;
  buildPairs(tiles, TILE_R * 2 + 2, _pairs2);
  for (let p = 0; p < _pairs2.length; p += 2) {
    const a = tiles[_pairs2[p]], b = tiles[_pairs2[p + 1]];
    const o = a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y);
    if (o > worst) worst = o;
  }
  return worst;
}

/** Tiles that escaped the jar (a tolerance of 0.5 units absorbs solver slop). */
export function outOfBounds(sim, tol = 0.5) {
  const bad = [];
  for (let i = 0; i < sim.tiles.length; i++) {
    const t = sim.tiles[i];
    if (t.x < t.r - tol || t.x > WORLD_W - t.r + tol || t.y > WORLD_H - t.r + tol) bad.push(t.id);
  }
  return bad;
}

const IDLE_INTENT = { pointer: { x: -9999, y: -9999, down: false }, submit: false };

/** Step with no input until everything sleeps (or the frame budget runs out). */
export function settle(sim, maxFrames = 900, dt = 1 / 60) {
  for (let f = 0; f < maxFrames; f++) {
    stepSim(sim, IDLE_INTENT, dt);
    let allAsleep = sim.tiles.length > 0;
    for (let i = 0; i < sim.tiles.length; i++) if (!sim.tiles[i].asleep) { allAsleep = false; break; }
    if (allAsleep) return f + 1;
  }
  return maxFrames;
}

/** Scripted drag through a list of tiles, driving the real stepSim. */
export function dragThrough(sim, tiles, dt = 1 / 60, framesPer = 2) {
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    for (let f = 0; f < framesPer; f++) {
      stepSim(sim, { pointer: { x: t.x, y: t.y, down: true }, submit: false }, dt);
    }
  }
  const last = tiles[tiles.length - 1];
  stepSim(sim, { pointer: { x: last ? last.x : 0, y: last ? last.y : 0, down: false }, submit: false }, dt);
  return sim;
}

export { IDLE_INTENT };
