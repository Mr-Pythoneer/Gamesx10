// Orbital — the pure simulation.
//
// This module touches NOTHING outside itself and holes.js: no DOM, no canvas, no kit,
// no Math.random(), no Date.now(). That is deliberate. The live game, the in-browser
// self-test and the node solver harness (tools-solve.mjs) all drive the exact same
// stepSim(), so a flight can never mean two different things.
//
// Integration is velocity-Verlet with 2 substeps per 1/60 frame. Bodies attract the
// probe with softened inverse-square gravity; the probe never affects the bodies, so
// every body position is an analytic function of flight time and a replay is exact.

import { HOLES } from './holes.js';

export const TAU = Math.PI * 2;

export const PROBE_R = 5;          // probe collision radius (world units)
export const MAX_POWER = 520;      // launch speed at a full pull (units/sec)
export const MIN_POWER = 70;       // a nudge is still a shot
export const MAX_SPEED = 1800;     // hard speed clamp — keeps the integrator sane
export const SUBSTEPS = 2;         // physics substeps per simulation frame
export const FLIGHT_LIMIT = 16;    // seconds before a shot is declared lost in space
export const WARP_COOLDOWN = 0.3;  // seconds a wormhole ignores the probe after a jump
export const OOB_MARGIN = 90;      // slack outside the stated bounds before out-of-bounds
export const TRAIL_MAX = 1200;

// gm is "G * mass" straight up — authored per body, or derived from radius by type.
const DENSITY = {
  planet: 1500,
  moon: 1250,
  blackhole: 30000,
  repulsor: -1500,
  wormhole: 0,
};

const SOLID = {
  planet: true,
  moon: true,
  blackhole: true,
  repulsor: true,
  wormhole: false,
};

export const HOLE_COUNT = HOLES.length;

/** Preview length by hole: full flight early, half by the middle, a stub on the back six. */
export function previewSteps(holeIndex) {
  if (holeIndex < 6) return 640;   // holes 1-6: the whole flight, all the way down
  if (holeIndex < 12) return 120;  // holes 7-12: about two seconds of future
  return 46;                       // holes 13-18: a stub. Now you are flying it.
}

// ---------------------------------------------------------------- construction

function makeBody(def, index) {
  const type = def.type || 'planet';
  const r = def.r || 40;
  const gm = def.gm !== undefined ? def.gm : DENSITY[type] * r * r;
  const b = {
    index,
    type,
    r,
    gm,
    solid: SOLID[type] !== false,
    soft: Math.max(6, r * 0.5),
    link: def.link === undefined ? -1 : def.link,
    orbit: def.orbit ? { cx: def.orbit.cx, cy: def.orbit.cy, r: def.orbit.r, w: def.orbit.w, phase: def.orbit.phase || 0 } : null,
    x: def.x || 0,
    y: def.y || 0,
    px: 0,
    py: 0,
  };
  if (b.orbit) {
    b.px = b.orbit.cx + Math.cos(b.orbit.phase) * b.orbit.r;
    b.py = b.orbit.cy + Math.sin(b.orbit.phase) * b.orbit.r;
  } else {
    b.px = b.x;
    b.py = b.y;
  }
  return b;
}

/** Fresh simulation for a hole, probe parked on the tee, nothing launched yet. */
export function makeSim(holeIndex) {
  const hole = HOLES[holeIndex];
  const bodies = hole.bodies.map(makeBody);
  return {
    holeIndex,
    bounds: hole.bounds,
    goal: { x: hole.goal.x, y: hole.goal.y, r: hole.goal.r },
    start: { x: hole.start.x, y: hole.start.y },
    bodies,
    probe: { x: hole.start.x, y: hole.start.y, vx: 0, vy: 0 },
    status: 'ready',        // ready | flying | sunk | crashed | oob | lost
    flightTime: 0,
    warpCd: 0,
    launchAngle: 0,
    launchPower: 0,
    impactSpeed: 0,
    trail: [],
    events: [],
    frames: 0,
  };
}

/** Fire the probe from the tee. angle in radians, power in units/sec. */
export function launch(sim, angle, power) {
  const p = Math.max(0, Math.min(MAX_POWER, power));
  sim.probe.x = sim.start.x;
  sim.probe.y = sim.start.y;
  sim.probe.vx = Math.cos(angle) * p;
  sim.probe.vy = Math.sin(angle) * p;
  sim.status = 'flying';
  sim.flightTime = 0;
  sim.warpCd = 0;
  sim.impactSpeed = 0;
  sim.launchAngle = angle;
  sim.launchPower = p;
  sim.trail = [{ x: sim.probe.x, y: sim.probe.y }];
  sim.events = [];
  sim.frames = 0;
  updateBodies(sim, 0);
  return sim;
}

// ---------------------------------------------------------------- physics

function updateBodies(sim, t) {
  const bs = sim.bodies;
  for (let i = 0; i < bs.length; i++) {
    const o = bs[i].orbit;
    if (!o) continue;
    const a = o.phase + o.w * t;
    bs[i].px = o.cx + Math.cos(a) * o.r;
    bs[i].py = o.cy + Math.sin(a) * o.r;
  }
}

const A0 = { x: 0, y: 0 };
const A1 = { x: 0, y: 0 };

/** Softened inverse-square pull from every massive body. Repulsors carry negative gm. */
function accelAt(sim, x, y, out) {
  let ax = 0, ay = 0;
  const bs = sim.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.gm === 0) continue;
    const dx = b.px - x, dy = b.py - y;
    const d2 = dx * dx + dy * dy + b.soft * b.soft;
    const inv = b.gm / (d2 * Math.sqrt(d2));
    ax += dx * inv;
    ay += dy * inv;
  }
  out.x = ax;
  out.y = ay;
}

/** Public helper — used by the renderer to sketch the local pull direction. */
export function fieldAt(sim, x, y) {
  accelAt(sim, x, y, A0);
  return { x: A0.x, y: A0.y };
}

/**
 * Smallest u in [0,1] where the segment (x0,y0)+u*(dx,dy) is within R of (cx,cy).
 * Segment-based so a probe screaming past a black hole cannot tunnel through it.
 */
function segCircleU(x0, y0, dx, dy, cx, cy, R) {
  const fx = x0 - cx, fy = y0 - cy;
  const c = fx * fx + fy * fy - R * R;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a <= 0) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const u1 = (-b - sq) / (2 * a);
  if (u1 >= 0 && u1 <= 1) return u1;
  const u2 = (-b + sq) / (2 * a);
  if (u2 >= 0 && u2 <= 1) return u2;
  return -1;
}

function pushEvent(sim, ev) {
  sim.events.push(ev);
  if (sim.events.length > 32) sim.events.shift();
}

function subStep(sim, h) {
  const p = sim.probe;

  updateBodies(sim, sim.flightTime);
  accelAt(sim, p.x, p.y, A0);

  const nx = p.x + p.vx * h + 0.5 * A0.x * h * h;
  const ny = p.y + p.vy * h + 0.5 * A0.y * h * h;

  updateBodies(sim, sim.flightTime + h);
  accelAt(sim, nx, ny, A1);

  let nvx = p.vx + 0.5 * (A0.x + A1.x) * h;
  let nvy = p.vy + 0.5 * (A0.y + A1.y) * h;
  const sp = Math.sqrt(nvx * nvx + nvy * nvy);
  if (sp > MAX_SPEED) { const k = MAX_SPEED / sp; nvx *= k; nvy *= k; }

  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nvx) || !Number.isFinite(nvy)) {
    sim.status = 'lost';
    return;
  }

  // --- earliest hit along this step's segment: goal, solid body, or wormhole mouth
  const dx = nx - p.x, dy = ny - p.y;
  let bestU = 2, bestKind = '', bestBody = null;

  const gu = segCircleU(p.x, p.y, dx, dy, sim.goal.x, sim.goal.y, sim.goal.r);
  if (gu >= 0 && gu < bestU) { bestU = gu; bestKind = 'goal'; bestBody = null; }

  for (let i = 0; i < sim.bodies.length; i++) {
    const b = sim.bodies[i];
    if (b.solid) {
      const u = segCircleU(p.x, p.y, dx, dy, b.px, b.py, b.r + PROBE_R);
      if (u >= 0 && u < bestU) { bestU = u; bestKind = 'solid'; bestBody = b; }
    } else if (b.type === 'wormhole' && sim.warpCd <= 0 && b.link >= 0) {
      const u = segCircleU(p.x, p.y, dx, dy, b.px, b.py, b.r);
      if (u >= 0 && u < bestU) { bestU = u; bestKind = 'warp'; bestBody = b; }
    }
  }

  if (bestKind === 'goal') {
    p.x = p.x + dx * bestU;
    p.y = p.y + dy * bestU;
    p.vx = nvx; p.vy = nvy;
    sim.impactSpeed = Math.sqrt(nvx * nvx + nvy * nvy);
    sim.status = 'sunk';
    sim.flightTime += h;
    return;
  }

  if (bestKind === 'solid') {
    p.x = p.x + dx * bestU;
    p.y = p.y + dy * bestU;
    sim.impactSpeed = Math.sqrt(nvx * nvx + nvy * nvy);
    sim.status = 'crashed';
    sim.crashType = bestBody.type;
    sim.flightTime += h;
    pushEvent(sim, { type: 'crash', x: p.x, y: p.y, body: bestBody.type });
    return;
  }

  if (bestKind === 'warp') {
    const hx = p.x + dx * bestU, hy = p.y + dy * bestU;
    const other = sim.bodies[bestBody.link];
    const s = Math.sqrt(nvx * nvx + nvy * nvy) || 1;
    const ux = nvx / s, uy = nvy / s;
    // Speed and heading conserved; the probe pops out of the far mouth still moving.
    p.x = other.px + ux * (other.r + PROBE_R + 4);
    p.y = other.py + uy * (other.r + PROBE_R + 4);
    p.vx = nvx; p.vy = nvy;
    sim.warpCd = WARP_COOLDOWN;
    sim.flightTime += h;
    pushEvent(sim, { type: 'warp', x: hx, y: hy, ex: p.x, ey: p.y });
    return;
  }

  p.x = nx; p.y = ny; p.vx = nvx; p.vy = nvy;
  sim.flightTime += h;
  if (sim.warpCd > 0) sim.warpCd -= h;

  const bd = sim.bounds;
  if (p.x < bd.x - OOB_MARGIN || p.x > bd.x + bd.w + OOB_MARGIN ||
      p.y < bd.y - OOB_MARGIN || p.y > bd.y + bd.h + OOB_MARGIN) {
    sim.status = 'oob';
    pushEvent(sim, { type: 'oob', x: p.x, y: p.y });
    return;
  }
  if (sim.flightTime >= FLIGHT_LIMIT) {
    sim.status = 'lost';
    pushEvent(sim, { type: 'lost', x: p.x, y: p.y });
  }
}

/** One fixed simulation frame. The ONLY way time moves anywhere in this game. */
export function stepSim(sim, dt) {
  if (sim.status !== 'flying') return sim;
  const h = dt / SUBSTEPS;
  for (let k = 0; k < SUBSTEPS && sim.status === 'flying'; k++) subStep(sim, h);
  sim.frames++;
  sim.trail.push({ x: sim.probe.x, y: sim.probe.y });
  if (sim.trail.length > TRAIL_MAX) sim.trail.shift();
  return sim;
}

// ---------------------------------------------------------------- prediction / replay

/**
 * Forward-simulate a candidate launch with the same integrator the flight uses.
 * `steps` caps the length so later holes can show only a stub of the future.
 */
export function predict(holeIndex, angle, power, steps, dt = 1 / 60) {
  const sim = makeSim(holeIndex);
  launch(sim, angle, power);
  const pts = [{ x: sim.probe.x, y: sim.probe.y, warp: false }];
  let warps = 0;
  for (let i = 0; i < steps && sim.status === 'flying'; i++) {
    stepSim(sim, dt);
    const isWarp = sim.events.length > warps && sim.events[sim.events.length - 1].type === 'warp';
    if (isWarp) warps = sim.events.length;
    pts.push({ x: sim.probe.x, y: sim.probe.y, warp: isWarp });
  }
  return { points: pts, status: sim.status, truncated: sim.status === 'flying', time: sim.flightTime };
}

/** Run a launch to completion headlessly. Used by the solver and the self-test. */
export function flightResult(holeIndex, angle, power, { dt = 1 / 60, maxFrames = 1000 } = {}) {
  const sim = makeSim(holeIndex);
  launch(sim, angle, power);
  let f = 0;
  while (sim.status === 'flying' && f < maxFrames) { stepSim(sim, dt); f++; }
  return { status: sim.status, frames: f, time: sim.flightTime, sim };
}

/** Replay a stored `solution` object ({a, p}) and report whether it sinks. */
export function replaySolution(holeIndex, solution, opts) {
  if (!solution) return { status: 'none', frames: 0 };
  return flightResult(holeIndex, solution.a, solution.p, opts);
}

// ---------------------------------------------------------------- solver (dev)

/**
 * solve(holeIndex) — coarse grid search over launch angle x power, every candidate
 * forward-simulated with stepSim() to a time limit. Returns the most ROBUST sinking
 * launch (the one sitting deepest inside a basin of neighbouring successes), not just
 * the first one found, so the embedded solution is a shot a human could plausibly hit.
 *
 * Run it from node via tools-solve.mjs, or from the browser console:
 *   __orbital.solve(0)
 */
export function solve(holeIndex, { angles = 180, powers = 30, minFrac = 0.18, dt = 1 / 60, maxFrames = 1000, refine = true } = {}) {
  const hit = [];
  const hitList = [];
  for (let i = 0; i < angles; i++) hit.push(new Uint8Array(powers));

  for (let i = 0; i < angles; i++) {
    const a = (i / angles) * TAU;
    for (let j = 0; j < powers; j++) {
      const p = MAX_POWER * (minFrac + (1 - minFrac) * ((j + 1) / powers));
      const r = flightResult(holeIndex, a, p, { dt, maxFrames });
      if (r.status === 'sunk') {
        hit[i][j] = 1;
        hitList.push({ i, j, a, p, frames: r.frames });
      }
    }
  }

  if (!hitList.length) {
    return { ok: false, hits: 0, tried: angles * powers, holeIndex };
  }

  // Robustness = how many neighbours in the (angle, power) grid also sink.
  let best = null;
  for (const h of hitList) {
    let score = 0;
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        const ii = (h.i + di + angles) % angles;
        const jj = h.j + dj;
        if (jj < 0 || jj >= powers) continue;
        if (hit[ii][jj]) score++;
      }
    }
    if (!best || score > best.score || (score === best.score && h.frames < best.frames)) {
      best = { ...h, score };
    }
  }

  let solution = { a: best.a, p: best.p };

  // Local refinement: nudge inside the basin so the stored shot is not on a knife edge.
  if (refine) {
    const stepA = TAU / angles, stepP = MAX_POWER * (1 - minFrac) / powers;
    let bestLocal = { a: solution.a, p: solution.p, score: -1 };
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        const a = best.a + di * stepA * 0.5;
        const p = best.p + dj * stepP * 0.5;
        if (p < MAX_POWER * minFrac || p > MAX_POWER) continue;
        if (flightResult(holeIndex, a, p, { dt, maxFrames }).status !== 'sunk') continue;
        // how much slack around this exact shot?
        let s = 0;
        for (const [da, dp] of [[0.006, 0], [-0.006, 0], [0, 4], [0, -4], [0.012, 0], [-0.012, 0], [0, 8], [0, -8]]) {
          if (flightResult(holeIndex, a + da, p + dp, { dt, maxFrames }).status === 'sunk') s++;
        }
        if (s > bestLocal.score) bestLocal = { a, p, score: s };
      }
    }
    if (bestLocal.score >= 0) solution = { a: bestLocal.a, p: bestLocal.p };
  }

  const verify = flightResult(holeIndex, solution.a, solution.p, { dt, maxFrames });
  return {
    ok: verify.status === 'sunk',
    holeIndex,
    solution,
    frames: verify.frames,
    hits: hitList.length,
    tried: angles * powers,
    robustness: best.score,
  };
}

export { HOLES };
