// Scribble — pure verlet solver. DOM-free, deterministic, zero dependencies.
//
// Everything here is a plain function over a plain, cloneable object. No Math.random(),
// no Date.now(), no canvas, no window. The live game and window.__selftest() call the
// exact same makeSim()/stepSim(), so a headless replay is bit-identical to what a player
// sees. That is the whole reason the level solutions can be machine-verified.
//
// Solver shape (the classic ~150-line verlet):
//   1. integrate every particle with implicit velocity (x - px), gravity, damping
//   2. relax distance constraints N times
//   3. project particles out of the world / each other inside the same relaxation loop
//   4. the ball is just one more particle, with restitution + rolling friction
//
// Stability, in order of importance:
//   - per-frame displacement is hard-clamped (MAX_STEP), so nothing can gain energy
//   - degenerate constraints (len < EPS) are skipped, never divided by
//   - non-finite values are caught every frame and snapped back to a stored home point
//   - particle and constraint counts are capped, strokes below MIN_STROKE_LEN rejected
//   - contacts bleed tangential energy, so structures actually go to sleep

import { LEVELS } from './levels.js';

// ---------------------------------------------------------------- constants

export const WORLD_W = 960;
export const WORLD_H = 600;
export const DT = 1 / 60;

export const TOOL_INK = 'ink';
export const TOOL_STATIC = 'static';
export const TOOL_PIN = 'pin';
export const TOOL_ERASE = 'erase';
export const TOOLS = [TOOL_INK, TOOL_STATIC, TOOL_PIN, TOOL_ERASE];

const GRAV = 1500;
const DAMP = 0.994;
const MAX_STEP = 14;          // px per frame, hard cap on every body — the anti-explosion rule
const ITER = 6;               // constraint relaxation passes
const PP_ITER = 2;            // ink-vs-ink passes (subset of the above)

export const INK_R = 4.2;
export const BALL_R = 11;
export const WALL_R = 5;
export const SPIKE_R = 9;

const SPACING = 13;           // particle spacing after resampling
const RDP_EPS = 2.4;          // Ramer-Douglas-Peucker tolerance
const DECIMATE = 3;           // raw-sample minimum spacing
export const MAX_PARTICLES = 640;
const MAX_BODY_PTS = 72;
const MIN_STROKE_LEN = 18;
export const PIN_COST = 22;
const PIN_GRAB = 54;
const ERASE_R = 34;

const BALL_INV = 0.5;         // ball is heavier than one ink particle, so it can shove
const BALL_REST = 0.24;
const BALL_TAN = 0.99;        // tangential retention => it rolls
const PART_REST = 0.02;
const PART_TAN = 0.72;        // ink loses sideways energy on contact => it settles

const INK_FLOOR = WORLD_H + 260;
const BOUND = 4000;
const EPS = 1e-6;

// ---------------------------------------------------------------- geometry helpers

function segClosest(px, py, x1, y1, x2, y2, out) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > EPS ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
  out.x = x1 + dx * t;
  out.y = y1 + dy * t;
  out.t = t;
  return out;
}

const _c = { x: 0, y: 0, t: 0 };

function polyLen(pts, closed = false) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 2) {
    L += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  }
  return L;
}

// ---------------------------------------------------------------- static world grid
//
// Levels never change, so their segments get bucketed once into a uniform grid and
// cached outside the sim (keeping sim state plain + cloneable). Expansion is larger
// than any query radius, so a single cell lookup is exact, not approximate.

const GRID_CELL = 64;
const gridCache = new Map();

function buildGrid(levelIndex) {
  const L = LEVELS[levelIndex];
  const walls = new Map();
  const pad = 40;
  const put = (map, seg) => {
    const minx = Math.min(seg[0], seg[2]) - pad, maxx = Math.max(seg[0], seg[2]) + pad;
    const miny = Math.min(seg[1], seg[3]) - pad, maxy = Math.max(seg[1], seg[3]) + pad;
    for (let cx = Math.floor(minx / GRID_CELL); cx <= Math.floor(maxx / GRID_CELL); cx++) {
      for (let cy = Math.floor(miny / GRID_CELL); cy <= Math.floor(maxy / GRID_CELL); cy++) {
        const k = cx * 73856093 ^ cy * 19349663;
        let a = map.get(k);
        if (!a) map.set(k, a = []);
        a.push(seg);
      }
    }
  };
  for (const w of (L.walls || [])) put(walls, w);
  const G = { walls, spikes: (L.spikes || []).slice() };
  gridCache.set(levelIndex, G);
  return G;
}

function getGrid(levelIndex) {
  return gridCache.get(levelIndex) || buildGrid(levelIndex);
}

function cellAt(map, x, y) {
  const cx = Math.floor(x / GRID_CELL), cy = Math.floor(y / GRID_CELL);
  return map.get(cx * 73856093 ^ cy * 19349663);
}

// ---------------------------------------------------------------- stroke preparation
//
// Raw pointer samples are far too dense (60/s, sub-pixel jitter). Pipeline:
//   decimate -> Ramer-Douglas-Peucker -> uniform resample.
// Uniform resampling matters more than it looks: equal constraint lengths make the
// relaxation converge evenly instead of fighting one very short link.

function normPts(input) {
  const out = [];
  if (!input || typeof input.length !== 'number') return out;
  const n = Math.min(input.length, 20000);
  for (let i = 0; i < n; i++) {
    const p = input[i];
    let x, y;
    if (Array.isArray(p)) { x = +p[0]; y = +p[1]; }
    else if (p && typeof p === 'object') { x = +p.x; y = +p.y; }
    else continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -BOUND || x > BOUND || y < -BOUND || y > BOUND) continue;
    out.push({ x, y });
  }
  return out;
}

function decimate(pts, minD) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1];
    if (Math.hypot(p.x - q.x, p.y - q.y) >= minD) out.push(p);
  }
  const last = pts[pts.length - 1], q = out[out.length - 1];
  if (out.length === 1 || last !== q) {
    if (Math.hypot(last.x - q.x, last.y - q.y) > 0.001) out.push(last);
  }
  return out;
}

/** Iterative RDP — an explicit stack, so a 2000-point scribble can never blow the stack. */
function rdp(pts, eps) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const i1 = stack.pop(), i0 = stack.pop();
    if (i1 <= i0 + 1) continue;
    const ax = pts[i0].x, ay = pts[i0].y, bx = pts[i1].x, by = pts[i1].y;
    let maxD = -1, idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      segClosest(pts[i].x, pts[i].y, ax, ay, bx, by, _c);
      const d = Math.hypot(pts[i].x - _c.x, pts[i].y - _c.y);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > i0) {
      keep[idx] = 1;
      stack.push(i0, idx, idx, i1);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function resample(pts, spacing) {
  const sp = Math.max(1, spacing);
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y }];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1].x, ay = pts[i - 1].y;
    const bx = pts[i].x, by = pts[i].y;
    let seg = Math.hypot(bx - ax, by - ay);
    let guard = 0;
    while (acc + seg >= sp && guard++ < 4096) {
      const t = (sp - acc) / seg;
      const nx = ax + (bx - ax) * t, ny = ay + (by - ay) * t;
      out.push({ x: nx, y: ny });
      if (out.length >= MAX_BODY_PTS) return out;
      ax = nx; ay = ny;
      seg = Math.hypot(bx - ax, by - ay);
      acc = 0;
    }
    acc += seg;
  }
  const last = pts[pts.length - 1], o = out[out.length - 1];
  if (Math.hypot(last.x - o.x, last.y - o.y) > sp * 0.35 && out.length < MAX_BODY_PTS) {
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

/**
 * prepareStroke(raw) -> { ok, reason, pts, len, closed }
 * Pure. Used by commitStroke AND by the renderer to preview a stroke's ink cost.
 * Degenerate input (empty, one point, a dot) is rejected — never turned into NaN.
 */
export function prepareStroke(raw) {
  const pts0 = normPts(raw);
  if (pts0.length === 0) return { ok: false, reason: 'empty', pts: [], len: 0, closed: false };
  if (pts0.length === 1) return { ok: false, reason: 'tiny', pts: [], len: 0, closed: false };
  const dec = decimate(pts0, DECIMATE);
  if (dec.length < 2) return { ok: false, reason: 'tiny', pts: [], len: 0, closed: false };
  const simp = rdp(dec, RDP_EPS);
  const rawLen = polyLen(simp);
  if (!(rawLen >= MIN_STROKE_LEN)) return { ok: false, reason: 'tiny', pts: [], len: rawLen || 0, closed: false };
  const spacing = Math.max(SPACING, rawLen / (MAX_BODY_PTS - 2));
  let pts = resample(simp, spacing);
  if (pts.length < 2) return { ok: false, reason: 'tiny', pts: [], len: rawLen, closed: false };

  // Closed loop => rigid body (ring + hub spokes). Needs enough points to be a shape.
  const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const closed = pts.length >= 6 && gap < spacing * 1.7;
  if (closed && gap < spacing * 0.6) pts = pts.slice(0, -1);
  if (closed && pts.length < 5) return { ok: false, reason: 'tiny', pts: [], len: rawLen, closed: false };

  const len = polyLen(pts, closed);
  if (!Number.isFinite(len) || len < MIN_STROKE_LEN) {
    return { ok: false, reason: 'tiny', pts: [], len: 0, closed: false };
  }
  return { ok: true, reason: '', pts, len, closed };
}

/** Convenience for HUD previews. */
export function strokeCost(raw) {
  const p = prepareStroke(raw);
  return p.ok ? p.len : 0;
}

// ---------------------------------------------------------------- sim construction

export function makeSim(levelIndex) {
  const idx = Math.max(0, Math.min(LEVELS.length - 1, levelIndex | 0));
  const L = LEVELS[idx];
  getGrid(idx);
  return {
    levelIndex: idx,
    frames: 0,
    runFrames: 0,
    bodies: [],
    pins: [],
    history: [],
    nextId: 1,
    inkUsed: 0,
    inkBudget: L.ink,
    ball: {
      x: L.ball.x, y: L.ball.y, px: L.ball.x, py: L.ball.y,
      alive: true, impact: 0, contact: 0,
    },
    trail: [],
    released: false,
    status: 'play',      // 'play' | 'won' | 'dead'
    goalGlow: 0,
    events: [],
  };
}

/** Deep copy of the plain state. Used by tooling; the sim itself never needs it. */
export function cloneSim(s) {
  return {
    ...s,
    bodies: s.bodies.map((b) => ({
      ...b,
      pts: b.pts.map((p) => ({ ...p })),
      cons: b.cons.map((c) => ({ ...c })),
    })),
    pins: s.pins.map((p) => ({ ...p })),
    history: s.history.map((h) => ({ ...h })),
    ball: { ...s.ball },
    trail: s.trail.map((t) => ({ ...t })),
    events: [],
  };
}

export function countParticles(s) {
  let n = 0;
  for (const b of s.bodies) n += b.pts.length;
  return n;
}

export function countConstraints(s) {
  let n = 0;
  for (const b of s.bodies) n += b.cons.length;
  return n;
}

/** Sum of squared per-frame displacement. A settled structure trends to ~0. */
export function totalKE(s) {
  let ke = 0;
  for (const b of s.bodies) {
    for (const p of b.pts) {
      if (p.inv === 0) continue;
      const dx = p.x - p.px, dy = p.y - p.py;
      ke += dx * dx + dy * dy;
    }
  }
  return ke;
}

export function maxAbsCoord(s) {
  let m = Math.max(Math.abs(s.ball.x), Math.abs(s.ball.y));
  for (const b of s.bodies) {
    for (const p of b.pts) {
      const a = Math.abs(p.x), c = Math.abs(p.y);
      if (a > m) m = a;
      if (c > m) m = c;
    }
  }
  return m;
}

export function maxSpeed(s) {
  let m = Math.hypot(s.ball.x - s.ball.px, s.ball.y - s.ball.py);
  for (const b of s.bodies) {
    for (const p of b.pts) {
      const v = Math.hypot(p.x - p.px, p.y - p.py);
      if (v > m) m = v;
    }
  }
  return m;
}

// ---------------------------------------------------------------- body building

function mkPoint(x, y, inv) {
  return { x, y, px: x, py: y, hx: x, hy: y, inv, pin: 0 };
}

function link(body, a, b, k) {
  const pa = body.pts[a], pb = body.pts[b];
  if (!pa || !pb || a === b) return;
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (!(len > 0.5)) return;                    // degenerate constraint — never divide by it
  body.cons.push({ a, b, len, k });
}

function buildBody(sim, prep, tool) {
  const stat = tool === TOOL_STATIC;
  const inv = stat ? 0 : 1;
  const body = {
    id: sim.nextId++,
    tool: stat ? TOOL_STATIC : TOOL_INK,
    closed: prep.closed,
    ink: prep.len,
    pts: prep.pts.map((p) => mkPoint(p.x, p.y, inv)),
    cons: [],
  };
  const n = body.pts.length;

  // Chain + cross-bracing. i->i+1 alone is a wet noodle; +2 and +3 make a beam.
  for (let i = 0; i + 1 < n; i++) link(body, i, i + 1, 1);
  for (let i = 0; i + 2 < n; i++) link(body, i, i + 2, 0.9);
  for (let i = 0; i + 3 < n; i++) link(body, i, i + 3, 0.7);

  if (prep.closed && n >= 5) {
    link(body, n - 1, 0, 1);
    link(body, n - 2, 0, 0.9);
    link(body, n - 1, 1, 0.9);
    link(body, n - 3, 0, 0.7);
    link(body, n - 1, 2, 0.7);
    // hub particle + spokes => a genuinely rigid wheel instead of a floppy ring
    let cx = 0, cy = 0;
    for (const p of body.pts) { cx += p.x; cy += p.y; }
    cx /= n; cy /= n;
    body.pts.push(mkPoint(cx, cy, inv));
    const hub = body.pts.length - 1;
    for (let i = 0; i < n; i++) link(body, i, hub, 0.85);
    const half = n >> 1;
    for (let i = 0; i < half; i++) link(body, i, (i + half) % n, 0.5);
  }
  return body;
}

// ---------------------------------------------------------------- intents

function ev(sim, type, x = 0, y = 0, v = 0) {
  if (sim.events.length < 24) sim.events.push({ type, x, y, v });
}

function removeBodyById(sim, id, refund) {
  const i = sim.bodies.findIndex((b) => b.id === id);
  if (i < 0) return 0;
  const b = sim.bodies[i];
  sim.bodies.splice(i, 1);
  // pins that lived on this body die with it
  for (let k = sim.pins.length - 1; k >= 0; k--) {
    if (sim.pins[k].bodyId === id) {
      if (refund) sim.inkUsed -= sim.pins[k].ink;
      sim.pins.splice(k, 1);
    }
  }
  for (let k = sim.history.length - 1; k >= 0; k--) {
    const h = sim.history[k];
    if ((h.type === 'body' && h.id === id) || (h.type === 'pin' && h.bodyId === id)) sim.history.splice(k, 1);
  }
  if (refund) sim.inkUsed -= b.ink;
  if (sim.inkUsed < 0) sim.inkUsed = 0;
  return b.ink;
}

function doPin(sim, pts) {
  if (!pts.length) { ev(sim, 'reject'); return; }
  const q = pts[pts.length - 1];
  if (sim.inkUsed + PIN_COST > sim.inkBudget + 1e-6) { ev(sim, 'reject'); return; }
  let best = null, bestD = PIN_GRAB;
  for (const b of sim.bodies) {
    if (b.tool === TOOL_STATIC) continue;
    for (let i = 0; i < b.pts.length; i++) {
      const p = b.pts[i];
      if (p.inv === 0) continue;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bestD) { bestD = d; best = { b, i }; }
    }
  }
  if (!best) { ev(sim, 'reject'); return; }
  const p = best.b.pts[best.i];
  p.inv = 0; p.pin = 1;
  p.px = p.x; p.py = p.y;
  sim.pins.push({ bodyId: best.b.id, index: best.i, x: p.x, y: p.y, ink: PIN_COST });
  sim.history.push({ type: 'pin', bodyId: best.b.id, index: best.i });
  sim.inkUsed += PIN_COST;
  ev(sim, 'pin', p.x, p.y);
}

function doErase(sim, pts) {
  let removed = 0;
  for (const q of pts) {
    for (let i = sim.bodies.length - 1; i >= 0; i--) {
      const b = sim.bodies[i];
      let hit = false;
      for (const p of b.pts) {
        if (Math.hypot(p.x - q.x, p.y - q.y) < ERASE_R) { hit = true; break; }
      }
      if (hit) { removeBodyById(sim, b.id, true); removed++; }
    }
  }
  if (removed) ev(sim, 'erase', pts[pts.length - 1].x, pts[pts.length - 1].y);
  else ev(sim, 'reject');
}

function doUndo(sim) {
  const h = sim.history.pop();
  if (!h) { ev(sim, 'reject'); return; }
  if (h.type === 'body') {
    sim.history.push(h);            // removeBodyById strips its own history entry
    removeBodyById(sim, h.id, true);
    ev(sim, 'erase');
  } else {
    const b = sim.bodies.find((x) => x.id === h.bodyId);
    const k = sim.pins.findIndex((p) => p.bodyId === h.bodyId && p.index === h.index);
    if (k >= 0) { sim.inkUsed -= sim.pins[k].ink; sim.pins.splice(k, 1); }
    if (b && b.pts[h.index] && b.tool !== TOOL_STATIC) { b.pts[h.index].inv = 1; b.pts[h.index].pin = 0; }
    if (sim.inkUsed < 0) sim.inkUsed = 0;
    ev(sim, 'erase');
  }
}

export function resetBall(sim) {
  const L = LEVELS[sim.levelIndex];
  const b = sim.ball;
  b.x = L.ball.x; b.y = L.ball.y; b.px = b.x; b.py = b.y;
  b.alive = true; b.impact = 0; b.contact = 0;
  sim.released = false;
  sim.status = 'play';
  sim.runFrames = 0;
  sim.trail.length = 0;
  sim.goalGlow = 0;
}

export function clearAll(sim) {
  sim.bodies.length = 0;
  sim.pins.length = 0;
  sim.history.length = 0;
  sim.inkUsed = 0;
  ev(sim, 'erase');
}

function commitStroke(sim, raw, tool) {
  const pts = normPts(raw);
  if (tool === TOOL_PIN) return doPin(sim, pts);
  if (tool === TOOL_ERASE) return doErase(sim, pts);

  const prep = prepareStroke(pts);
  if (!prep.ok) { ev(sim, 'reject'); return; }
  if (sim.inkUsed + prep.len > sim.inkBudget + 1e-6) { ev(sim, 'reject'); return; }
  const add = prep.pts.length + (prep.closed ? 1 : 0);
  if (countParticles(sim) + add > MAX_PARTICLES) { ev(sim, 'reject'); return; }

  const body = buildBody(sim, prep, tool);
  sim.bodies.push(body);
  sim.history.push({ type: 'body', id: body.id });
  sim.inkUsed += body.ink;
  ev(sim, 'ink', prep.pts[0].x, prep.pts[0].y, body.ink);
}

function applyIntent(sim, intent) {
  if (!intent) return;
  if (intent.reset) resetBall(sim);
  if (intent.clear) clearAll(sim);
  if (intent.undo) doUndo(sim);
  if (intent.release && !sim.released && sim.status === 'play') {
    sim.released = true;
    ev(sim, 'release', sim.ball.x, sim.ball.y);
  }
  if (intent.commit && intent.stroke) commitStroke(sim, intent.stroke, intent.tool || TOOL_INK);
}

// ---------------------------------------------------------------- solver internals

function integrate(p, g) {
  if (p.inv === 0) { p.px = p.x; p.py = p.y; return; }
  let vx = (p.x - p.px) * DAMP;
  let vy = (p.y - p.py) * DAMP;
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) { vx = 0; vy = 0; }
  const sp = Math.hypot(vx, vy);
  if (sp > MAX_STEP) { const k = MAX_STEP / sp; vx *= k; vy *= k; }
  p.px = p.x; p.py = p.y;
  p.x += vx;
  p.y += vy + g;
}

function solveConstraints(sim) {
  for (const b of sim.bodies) {
    const pts = b.pts, cons = b.cons;
    for (let i = 0; i < cons.length; i++) {
      const c = cons[i];
      const a = pts[c.a], d = pts[c.b];
      const w = a.inv + d.inv;
      if (w === 0) continue;
      const dx = d.x - a.x, dy = d.y - a.y;
      const dl = Math.sqrt(dx * dx + dy * dy);
      if (!(dl > EPS)) continue;                       // degenerate — skip, never divide
      const diff = ((dl - c.len) / dl) * c.k;
      const fa = diff * (a.inv / w), fb = diff * (d.inv / w);
      a.x += dx * fa; a.y += dy * fa;
      d.x -= dx * fb; d.y -= dy * fb;
    }
  }
}

/** Push a verlet point out of a solid capsule segment. Returns penetration depth. */
function projectPoint(p, seg, radius, final, tan, rest) {
  segClosest(p.x, p.y, seg[0], seg[1], seg[2], seg[3], _c);
  let nx = p.x - _c.x, ny = p.y - _c.y;
  let d = Math.hypot(nx, ny);
  const R = radius + WALL_R;
  if (d >= R) return 0;
  if (d < EPS) {
    // dead centre on the segment — push along its normal so we never divide by zero
    const sx = seg[2] - seg[0], sy = seg[3] - seg[1];
    const sl = Math.hypot(sx, sy) || 1;
    nx = -sy / sl; ny = sx / sl; d = 0;
  } else { nx /= d; ny /= d; }
  const pen = R - d;
  p.x += nx * pen; p.y += ny * pen;
  if (final) {
    let vx = p.x - p.px, vy = p.y - p.py;
    const vn = vx * nx + vy * ny;
    if (vn < 0) {
      const tx = vx - vn * nx, ty = vy - vn * ny;
      vx = tx * tan - nx * vn * rest;
      vy = ty * tan - ny * vn * rest;
      p.px = p.x - vx; p.py = p.y - vy;
    }
  }
  return pen;
}

function collideWithWorld(sim, G, final) {
  for (const b of sim.bodies) {
    if (b.tool === TOOL_STATIC) continue;             // static ink ignores the world
    for (const p of b.pts) {
      if (p.inv === 0) continue;
      const cell = cellAt(G.walls, p.x, p.y);
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) projectPoint(p, cell[i], INK_R, final, PART_TAN, PART_REST);
    }
  }
}

/** Ink-vs-ink, different bodies only. Uniform hash, position-only => rock solid. */
function collideInkInk(sim) {
  const list = [];
  for (let bi = 0; bi < sim.bodies.length; bi++) {
    const b = sim.bodies[bi];
    for (let i = 0; i < b.pts.length; i++) list.push({ b: bi, p: b.pts[i] });
  }
  if (list.length < 2) return;
  const cell = INK_R * 2.4;
  const map = new Map();
  for (let i = 0; i < list.length; i++) {
    const p = list[i].p;
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    const k = cx * 73856093 ^ cy * 19349663;
    let a = map.get(k);
    if (!a) map.set(k, a = []);
    a.push(i);
  }
  const R = INK_R * 1.85;
  for (let i = 0; i < list.length; i++) {
    const A = list[i], pa = A.p;
    const cx = Math.floor(pa.x / cell), cy = Math.floor(pa.y / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const a = map.get((cx + ox) * 73856093 ^ (cy + oy) * 19349663);
        if (!a) continue;
        for (let j = 0; j < a.length; j++) {
          const B = list[a[j]];
          if (B.b === A.b || a[j] <= i) continue;
          const pb = B.p;
          const w = pa.inv + pb.inv;
          if (w === 0) continue;
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= R * R || d2 < EPS) continue;
          const d = Math.sqrt(d2);
          const pen = (R - d) / d * 0.5;
          const fa = pen * (pa.inv / w), fb = pen * (pb.inv / w);
          pa.x -= dx * fa; pa.y -= dy * fa;
          pb.x += dx * fb; pb.y += dy * fb;
        }
      }
    }
  }
}

/** Ball vs every ink segment, treated as a capsule. Reaction is shared with the ink. */
function collideBallInk(sim, final) {
  const ball = sim.ball;
  for (const b of sim.bodies) {
    const pts = b.pts, cons = b.cons;
    for (let i = 0; i < cons.length; i++) {
      const c = cons[i];
      if (c.k < 0.95) continue;                       // only the spine, not the bracing
      const a = pts[c.a], d = pts[c.b];
      segClosest(ball.x, ball.y, a.x, a.y, d.x, d.y, _c);
      let nx = ball.x - _c.x, ny = ball.y - _c.y;
      let dl = Math.hypot(nx, ny);
      const R = BALL_R + INK_R;
      if (dl >= R) continue;
      if (dl < EPS) {
        const sx = d.x - a.x, sy = d.y - a.y;
        const sl = Math.hypot(sx, sy) || 1;
        nx = -sy / sl; ny = sx / sl; dl = 0;
      } else { nx /= dl; ny /= dl; }
      const pen = R - dl;
      const t = _c.t;
      const wa = (1 - t) * a.inv, wb = t * d.inv;
      const wsum = wa + wb + BALL_INV;
      if (wsum <= EPS) continue;
      ball.x += nx * pen * (BALL_INV / wsum);
      ball.y += ny * pen * (BALL_INV / wsum);
      a.x -= nx * pen * (wa / wsum); a.y -= ny * pen * (wa / wsum);
      d.x -= nx * pen * (wb / wsum); d.y -= ny * pen * (wb / wsum);
      ball.contact = 1;
      if (final) {
        let vx = ball.x - ball.px, vy = ball.y - ball.py;
        const vn = vx * nx + vy * ny;
        if (vn < 0) {
          ball.impact = Math.max(ball.impact, -vn);
          const tx = vx - vn * nx, ty = vy - vn * ny;
          vx = tx * BALL_TAN - nx * vn * BALL_REST;
          vy = ty * BALL_TAN - ny * vn * BALL_REST;
          ball.px = ball.x - vx; ball.py = ball.y - vy;
        }
      }
    }
  }
}

function collideBallWorld(sim, G, final) {
  const ball = sim.ball;
  const cell = cellAt(G.walls, ball.x, ball.y);
  if (!cell) return;
  for (let i = 0; i < cell.length; i++) {
    const before = ball.px;
    const pen = projectPoint(ball, cell[i], BALL_R, final, BALL_TAN, BALL_REST);
    if (pen > 0) {
      ball.contact = 1;
      if (final) ball.impact = Math.max(ball.impact, Math.abs(ball.px - before));
    }
  }
}

function sanitize(sim) {
  for (const b of sim.bodies) {
    for (const p of b.pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) ||
          !Number.isFinite(p.px) || !Number.isFinite(p.py) ||
          Math.abs(p.x) > BOUND || Math.abs(p.y) > BOUND) {
        p.x = p.hx; p.y = p.hy; p.px = p.hx; p.py = p.hy;
      }
      if (p.y > INK_FLOOR) { p.y = INK_FLOOR; if (p.py > INK_FLOOR) p.py = INK_FLOOR; }
    }
  }
  const b = sim.ball;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y) ||
      !Number.isFinite(b.px) || !Number.isFinite(b.py) ||
      Math.abs(b.x) > BOUND || Math.abs(b.y) > BOUND) {
    const L = LEVELS[sim.levelIndex];
    b.x = L.ball.x; b.y = L.ball.y; b.px = b.x; b.py = b.y;
    b.alive = false;
  }
}

// ---------------------------------------------------------------- the step

function simulate(sim, dt) {
  const L = LEVELS[sim.levelIndex];
  const G = getGrid(sim.levelIndex);
  const g = GRAV * dt * dt;
  const ball = sim.ball;
  const live = sim.released && ball.alive && sim.status === 'play';

  for (const b of sim.bodies) {
    if (b.tool === TOOL_STATIC) continue;
    for (const p of b.pts) integrate(p, g);
  }

  ball.impact = 0;
  ball.contact = 0;
  if (live) integrate(ball, g);
  else { ball.px = ball.x; ball.py = ball.y; }

  for (let k = 0; k < ITER; k++) {
    const final = k === ITER - 1;
    solveConstraints(sim);
    collideWithWorld(sim, G, final);
    if (k < PP_ITER) collideInkInk(sim);
    if (live) {
      collideBallInk(sim, final);
      collideBallWorld(sim, G, final);
    }
  }

  sanitize(sim);

  if (ball.impact > 1.2) ev(sim, 'thud', ball.x, ball.y, ball.impact);

  if (live) {
    sim.runFrames++;
    sim.trail.push({ x: ball.x, y: ball.y });
    if (sim.trail.length > 26) sim.trail.shift();

    for (const s of G.spikes) {
      segClosest(ball.x, ball.y, s[0], s[1], s[2], s[3], _c);
      if (Math.hypot(ball.x - _c.x, ball.y - _c.y) < BALL_R + SPIKE_R) {
        ball.alive = false;
        sim.status = 'dead';
        ev(sim, 'die', ball.x, ball.y);
        break;
      }
    }
    if (ball.alive && (ball.y > WORLD_H + 90 || ball.y < -600)) {
      ball.alive = false;
      sim.status = 'dead';
      ev(sim, 'die', ball.x, Math.min(ball.y, WORLD_H + 20));
    }
    if (ball.alive && Math.hypot(ball.x - L.goal.x, ball.y - L.goal.y) < L.goal.r) {
      sim.status = 'won';
      sim.goalGlow = 1;
      ev(sim, 'win', L.goal.x, L.goal.y);
    }
  }

  if (sim.goalGlow > 0) sim.goalGlow = Math.max(0, sim.goalGlow - dt * 0.6);
}

/**
 * stepSim(sim, intent, dt) — one fixed simulation step.
 *
 * intent (all optional): { stroke, tool, commit, undo, clear, reset, release }
 *   stroke  : array of [x,y] or {x,y} in WORLD coordinates
 *   tool    : 'ink' | 'static' | 'pin' | 'erase'
 *   commit  : finalise `stroke` into a body / pin / erase this frame
 */
export function stepSim(sim, intent, dt = DT) {
  sim.events.length = 0;
  applyIntent(sim, intent);
  simulate(sim, dt);
  sim.frames++;
  return sim;
}

// ---------------------------------------------------------------- verification helper

/**
 * Replay a level's authored stroke script headlessly through the real stepSim.
 * Returns the finished sim plus the closest the ball ever got to the goal.
 */
export function replaySolution(levelIndex, solution, opts = {}) {
  const sim = makeSim(levelIndex);
  if (!solution) return { sim, won: false, best: Infinity };
  const settle = opts.settle ?? solution.settle ?? 30;
  const maxFrames = opts.maxFrames ?? solution.maxFrames ?? 900;
  for (const s of solution.strokes || []) {
    stepSim(sim, { stroke: s.points, tool: s.tool || TOOL_INK, commit: true }, DT);
  }
  for (let i = 0; i < settle; i++) stepSim(sim, null, DT);
  stepSim(sim, { release: true }, DT);
  const L = LEVELS[levelIndex];
  let best = Infinity;
  for (let i = 0; i < maxFrames && sim.status === 'play'; i++) {
    stepSim(sim, null, DT);
    const d = Math.hypot(sim.ball.x - L.goal.x, sim.ball.y - L.goal.y);
    if (d < best) best = d;
  }
  return { sim, won: sim.status === 'won', dead: sim.status === 'dead', ink: sim.inkUsed, best, frames: sim.frames };
}

export { LEVELS };
