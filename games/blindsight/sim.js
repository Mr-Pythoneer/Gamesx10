// Blindsight — the simulation. PURE and DOM-free.
//
//   makeSim(seedString, opts)          -> sim
//   stepSim(sim, intent, dt)           -> sim   (fixed dt, seeded RNG only)
//
//   intent = { mx, my, ping: 'wide'|'narrow'|null, sneak: bool, aim: number|null }
//
// The live game and the self-test both call THIS stepSim. No Math.random, no
// Date.now, no DOM. Same seed + same intents => byte-identical run.

import { RNG, clamp, TAU } from '../../shared/kit.js';
import {
  TILE, FACE_N, FACE_E, FACE_S, FACE_W,
  generateMaze, mapFromRows, makeMap, solidAt, castRay, hasLOS, bfsField,
  tileCenter, tileOf, faceIndex, walkableTiles, moveCircle, nearestWalkable,
} from './maze.js';

export {
  TILE, FACE_N, FACE_E, FACE_S, FACE_W,
  mapFromRows, castRay, hasLOS, bfsField, tileCenter, tileOf, faceIndex, solidAt,
};

// ---------------------------------------------------------------- tuning

export const MAZE_COLS = 15;
export const MAZE_ROWS = 11;
export const SHARD_COUNT = 4;

export const PLAYER_R = 5.5;
export const RUN_SPEED = 84;
export const SNEAK_SPEED = 44;

export const SELF_GLOW_R = 42;      // the faint always-on halo, so you are never fully lost
export const SELF_GLOW_RAYS = 34;
export const REVEAL_LIFE = 3.4;     // seconds for a revealed surface to fade to nothing
export const ECHO_LIFE = 1.5;
export const MAX_ECHOES = 1200;

export const PING = {
  //         rays  spread(rad)  range  loudness  cooldown  strength  ring speed
  wide:   { rays: 300, spread: TAU,  range: 300, loud: 1.00, cool: 1.25, strength: 1.00, ringSpeed: 520 },
  narrow: { rays: 110, spread: 0.80, range: 480, loud: 0.26, cool: 0.45, strength: 0.94, ringSpeed: 680 },
};
const PING_LOCKOUT = 0.22;          // minimum gap between any two pings

export const HEAR_BASE = 980;       // hearing radius at loudness 1.0 (covers the whole maze)
export const FOOTSTEP_LOUD = 0.075;
export const FOOTSTEP_STRIDE = 26;
export const SHARD_LOUD = 0.2;

export const HUNTER_R = 6;
export const HUNTER_SPEED = { patrol: 40, hunt: 66, chase: 78 };
export const HUNTER_SIGHT = 215;
export const HUNTER_SENSE = 44;     // it feels you this close even in the dark
export const HUNTER_STRIDE = 21;
export const CATCH_DIST = 11;

export const SHARD_R = 11;
export const EXIT_R = 13;
const FX_CAP = 64;

// ---------------------------------------------------------------- construction

function pushFx(sim, ev) {
  sim.fxq.push(ev);
  if (sim.fxq.length > FX_CAP) sim.fxq.splice(0, sim.fxq.length - FX_CAP);
}

function manhattanTiles(map, a, b) {
  const ax = a % map.tw, ay = (a / map.tw) | 0;
  const bx = b % map.tw, by = (b / map.tw) | 0;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/**
 * makeSim(seedString, opts)
 *   opts.map         — inject a known layout (self-test); otherwise generated from the seed
 *   opts.spawnTile   — {x,y}
 *   opts.exitTile    — {x,y}
 *   opts.hunterTile  — {x,y}
 *   opts.hunter      — false to omit the hunter entirely
 *   opts.shardCount  — defaults to SHARD_COUNT
 */
export function makeSim(seedString, opts = {}) {
  const seed = String(seedString);
  const rng = new RNG(seed);
  const map = opts.map || generateMaze(rng, opts.cols || MAZE_COLS, opts.rows || MAZE_ROWS);
  const tw = map.tw, th = map.th;
  const walkable = walkableTiles(map);

  let spawnTi = opts.spawnTile ? opts.spawnTile.y * tw + opts.spawnTile.x : tw + 1;
  if (spawnTi < 0 || spawnTi >= map.solid.length || map.solid[spawnTi]) spawnTi = walkable[0];

  const field = bfsField(map, spawnTi % tw, (spawnTi / tw) | 0);
  let maxD = 0;
  for (let i = 0; i < walkable.length; i++) if (field[walkable[i]] > maxD) maxD = field[walkable[i]];

  // exit — as far from spawn as the maze allows
  let exitTi;
  if (opts.exitTile) exitTi = opts.exitTile.y * tw + opts.exitTile.x;
  else {
    const far = walkable.filter((ti) => field[ti] >= maxD * 0.85);
    exitTi = far.length ? far[rng.int(far.length)] : walkable[walkable.length - 1];
  }

  // shards — spread out, never adjacent to each other or to the exit
  const shardCount = opts.shardCount === undefined ? SHARD_COUNT : opts.shardCount;
  const shards = [];
  if (shardCount > 0) {
    const cands = rng.shuffle(walkable.filter((ti) =>
      field[ti] >= maxD * 0.2 && ti !== exitTi && ti !== spawnTi));
    const chosen = [];
    for (let pass = 0; pass < 2 && chosen.length < shardCount; pass++) {
      const minSep = pass === 0 ? 6 : 0;
      for (let i = 0; i < cands.length && chosen.length < shardCount; i++) {
        const ti = cands[i];
        if (chosen.indexOf(ti) >= 0) continue;
        if (manhattanTiles(map, ti, exitTi) < (pass === 0 ? 4 : 1)) continue;
        let ok = true;
        for (let k = 0; k < chosen.length; k++) {
          if (manhattanTiles(map, ti, chosen[k]) < minSep) { ok = false; break; }
        }
        if (ok) chosen.push(ti);
      }
    }
    for (let i = 0; i < chosen.length; i++) {
      const c = tileCenter(chosen[i] % tw, (chosen[i] / tw) | 0);
      shards.push({ x: c.x, y: c.y, taken: false, glow: 0, spin: rng.range(0, TAU) });
    }
  }

  // hunter — starts far away, so the first ping is what wakes it
  let hunter = null;
  if (opts.hunter !== false) {
    let hti;
    if (opts.hunterTile) hti = opts.hunterTile.y * tw + opts.hunterTile.x;
    else {
      const far = walkable.filter((ti) => field[ti] >= maxD * 0.6);
      hti = far.length ? far[rng.int(far.length)] : walkable[walkable.length - 1];
    }
    const hc = tileCenter(hti % tw, (hti / tw) | 0);
    hunter = {
      x: hc.x, y: hc.y,
      state: 'patrol', alert: 0, glow: 0,
      target: { x: hc.x, y: hc.y },
      lastSeen: { x: hc.x, y: hc.y },
      lostT: 0, pauseT: 0, wanderT: 0, stepT: 0, stuckT: 0, side: 1,
      field: null, fieldTi: -1,
    };
  }

  const sp = tileCenter(spawnTi % tw, (spawnTi / tw) | 0);
  const ex = tileCenter(exitTi % tw, (exitTi / tw) | 0);

  const sim = {
    seed, rng, map, walkable, tw, th,
    reveal: new Float32Array(tw * th * 4),
    echoes: [],
    rings: [],
    player: { x: sp.x, y: sp.y, face: 0, stepT: 0, moving: 0 },
    spawn: { x: sp.x, y: sp.y },
    exit: { x: ex.x, y: ex.y, glow: 0, active: shards.length === 0 },
    shards,
    collected: 0,
    hunter,
    cool: { wide: 0, narrow: 0 },
    glowPhase: 0,
    pingCount: 0,
    time: 0,
    frames: 0,
    won: false,
    dead: false,
    over: false,
    dread: 0,
    fxq: [],
  };

  if (hunter) pickPatrol(sim);
  return sim;
}

// ---------------------------------------------------------------- echolocation

function pushEcho(sim, x, y, f, delay, str) {
  sim.echoes.push({ x, y, f, t: -delay, str, armed: 0 });
}

function emitPing(sim, kind) {
  const cfg = PING[kind];
  const px = sim.player.x, py = sim.player.y;
  const full = cfg.spread >= TAU - 1e-6;

  sim.rings.push({
    x: px, y: py, r: 0, prevR: 0,
    range: cfg.range, speed: cfg.ringSpeed,
    dir: sim.player.face, spread: cfg.spread, kind,
  });
  if (sim.rings.length > 6) sim.rings.shift();

  const n = cfg.rays;
  const base = full ? 0 : sim.player.face - cfg.spread / 2;
  for (let i = 0; i < n; i++) {
    const a = full ? (i / n) * TAU : base + (i / (n - 1)) * cfg.spread;
    const r = castRay(sim.map, px, py, Math.cos(a), Math.sin(a), cfg.range);
    if (!r.hit || r.face < 0) continue;
    const str = cfg.strength * (0.35 + 0.65 * (1 - r.dist / cfg.range));
    pushEcho(sim, r.x, r.y, faceIndex(sim.map, r.tx, r.ty, r.face), r.dist / cfg.ringSpeed, str);
  }
  if (sim.echoes.length > MAX_ECHOES) sim.echoes.splice(0, sim.echoes.length - MAX_ECHOES);

  sim.pingCount++;
  pushFx(sim, { type: 'ping', kind, x: px, y: py, loud: cfg.loud });
  emitSound(sim, px, py, cfg.loud);
}

/** The faint halo. Costs nothing, makes no noise, barely reaches past your own feet. */
function selfGlow(sim) {
  const px = sim.player.x, py = sim.player.y;
  sim.glowPhase = (sim.glowPhase + 0.37) % TAU;
  for (let i = 0; i < SELF_GLOW_RAYS; i++) {
    const a = sim.glowPhase + (i / SELF_GLOW_RAYS) * TAU;
    const r = castRay(sim.map, px, py, Math.cos(a), Math.sin(a), SELF_GLOW_R);
    if (!r.hit || r.face < 0) continue;
    const f = faceIndex(sim.map, r.tx, r.ty, r.face);
    const v = 0.035 + 0.19 * (1 - r.dist / SELF_GLOW_R);
    if (v > sim.reveal[f]) sim.reveal[f] = v;
  }
}

function inCone(ring, x, y) {
  if (ring.spread >= TAU - 1e-6) return true;
  const a = Math.atan2(y - ring.y, x - ring.x);
  let d = ((a - ring.dir + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return Math.abs(d) <= ring.spread / 2 + 0.06;
}

/** Objects light up the instant the expanding ring sweeps across them. */
function scanRing(sim, ring) {
  for (let i = 0; i < sim.shards.length; i++) {
    const s = sim.shards[i];
    if (!s.taken) touchRing(sim, ring, s, 'shardPing');
  }
  touchRing(sim, ring, sim.exit, 'exitPing');
  if (sim.hunter) touchRing(sim, ring, sim.hunter, 'hunterSeen');
}

function touchRing(sim, ring, o, evType) {
  const d = Math.hypot(o.x - ring.x, o.y - ring.y);
  if (d > ring.range || d <= ring.prevR || d > ring.r) return;
  if (!inCone(ring, o.x, o.y)) return;
  if (!hasLOS(sim.map, ring.x, ring.y, o.x, o.y)) return;
  o.glow = 1;
  pushFx(sim, { type: evType, x: o.x, y: o.y });
}

// ---------------------------------------------------------------- hearing

/**
 * A noise at (x,y). The hunter's hearing radius scales with loudness; how
 * accurately it localises you scales with how close and how loud it was.
 */
function emitSound(sim, x, y, loud) {
  const h = sim.hunter;
  if (!h || loud <= 0) return;
  const R = HEAR_BASE * loud;
  const d = Math.hypot(x - h.x, y - h.y);
  if (d > R) return;

  const acc = clamp(1 - d / R, 0, 1);
  const jitter = (1 - acc) * 165 + (1 - loud) * 18;
  const ang = sim.rng.next() * TAU;
  const rad = sim.rng.next() * jitter;
  const guess = nearestWalkable(sim.map, x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);

  if (h.state !== 'chase') {
    h.state = 'hunt';
    h.target.x = guess.x; h.target.y = guess.y;
    h.pauseT = 0;
    h.alert = Math.max(h.alert, 0.5 + acc * 0.35);
  }
  pushFx(sim, { type: 'heard', x: guess.x, y: guess.y, loud });
}

// ---------------------------------------------------------------- hunter

function pickPatrol(sim) {
  const h = sim.hunter;
  const ti = sim.walkable[sim.rng.int(sim.walkable.length)];
  const c = tileCenter(ti % sim.tw, (ti / sim.tw) | 0);
  h.target.x = c.x; h.target.y = c.y;
  h.wanderT = 6 + sim.rng.next() * 6;
  h.pauseT = 0;
}

/** One-tile lookahead down a BFS gradient. Used only when direct LOS is blocked. */
function waypointToward(sim, gx, gy) {
  const h = sim.hunter, map = sim.map, tw = map.tw;
  let t = tileOf(gx, gy);
  if (solidAt(map, t.tx, t.ty)) {
    const nw = nearestWalkable(map, gx, gy);
    t = tileOf(nw.x, nw.y);
  }
  const ti = t.ty * tw + t.tx;
  if (h.fieldTi !== ti || !h.field) { h.field = bfsField(map, t.tx, t.ty); h.fieldTi = ti; }

  const c = tileOf(h.x, h.y);
  if (c.tx < 0 || c.ty < 0 || c.tx >= map.tw || c.ty >= map.th) return null;
  const ci = c.ty * tw + c.tx;
  const cv = h.field[ci];
  if (cv < 0) return null;

  let bx = -1, by = -1, bestV = cv;
  const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let d = 0; d < 4; d++) {
    const nx = c.tx + D[d][0], ny = c.ty + D[d][1];
    if (nx < 0 || ny < 0 || nx >= map.tw || ny >= map.th) continue;
    const ni = ny * tw + nx;
    if (map.solid[ni]) continue;
    const v = h.field[ni];
    if (v >= 0 && v < bestV) { bestV = v; bx = nx; by = ny; }
  }
  if (bx < 0) return null;
  return tileCenter(bx, by);
}

function stepHunter(sim, dt) {
  const h = sim.hunter;
  if (!h) return;
  const p = sim.player;
  const d = Math.hypot(p.x - h.x, p.y - h.y);
  const los = d < HUNTER_SIGHT && hasLOS(sim.map, h.x, h.y, p.x, p.y);

  if (los || d < HUNTER_SENSE) {
    if (h.state !== 'chase') pushFx(sim, { type: 'spotted', x: h.x, y: h.y });
    h.state = 'chase';
    h.lostT = 0;
    h.lastSeen.x = p.x; h.lastSeen.y = p.y;
  } else if (h.state === 'chase') {
    h.lostT += dt;
    if (h.lostT > 2.6) {
      h.state = 'hunt';
      h.target.x = h.lastSeen.x; h.target.y = h.lastSeen.y;
      h.pauseT = 0;
    }
  }

  let speed = HUNTER_SPEED.patrol;
  let gx = h.target.x, gy = h.target.y;

  if (h.state === 'chase') {
    speed = HUNTER_SPEED.chase;
    gx = los ? p.x : h.lastSeen.x;
    gy = los ? p.y : h.lastSeen.y;
  } else if (h.state === 'hunt') {
    speed = HUNTER_SPEED.hunt;
    if (Math.hypot(gx - h.x, gy - h.y) < 15) {
      h.pauseT += dt;
      speed = 0;
      if (h.pauseT > 1.4) { h.state = 'patrol'; pickPatrol(sim); }
    }
  } else {
    h.wanderT -= dt;
    if (h.wanderT <= 0 || Math.hypot(gx - h.x, gy - h.y) < 16) {
      pickPatrol(sim);
      gx = h.target.x; gy = h.target.y;
    }
  }

  h.alert = h.state === 'chase' ? 1
    : h.state === 'hunt' ? Math.max(0.5, h.alert - dt * 0.2)
      : Math.max(0, h.alert - dt * 0.3);

  if (speed <= 0) return;

  let wx = gx, wy = gy;
  if (!hasLOS(sim.map, h.x, h.y, gx, gy)) {
    const wp = waypointToward(sim, gx, gy);
    if (wp) { wx = wp.x; wy = wp.y; }
  }

  const ang = Math.atan2(wy - h.y, wx - h.x);
  const step = speed * dt;
  const bx = h.x, by = h.y;
  moveCircle(sim.map, h, Math.cos(ang) * step, Math.sin(ang) * step, HUNTER_R);
  let mv = Math.hypot(h.x - bx, h.y - by);

  if (mv < step * 0.25) {
    h.stuckT += dt;
    if (h.stuckT > 0.18) { h.side = sim.rng.bool() ? 1 : -1; h.stuckT = 0; }
    const a2 = ang + h.side * Math.PI / 2;
    moveCircle(sim.map, h, Math.cos(a2) * step, Math.sin(a2) * step, HUNTER_R);
    mv = Math.hypot(h.x - bx, h.y - by);
  } else h.stuckT = 0;

  h.stepT += mv;
  if (h.stepT >= HUNTER_STRIDE) {
    h.stepT -= HUNTER_STRIDE;
    pushFx(sim, { type: 'step', x: h.x, y: h.y, alert: h.alert });
  }
}

// ---------------------------------------------------------------- per-frame decay

function decayVisuals(sim, dt) {
  const rv = sim.reveal, k = dt / REVEAL_LIFE;
  for (let i = 0; i < rv.length; i++) {
    const v = rv[i];
    if (v > 0) rv[i] = v > k ? v - k : 0;
  }

  for (let i = sim.rings.length - 1; i >= 0; i--) {
    const R = sim.rings[i];
    R.prevR = R.r;
    R.r += R.speed * dt;
    scanRing(sim, R);
    if (R.prevR > R.range) sim.rings.splice(i, 1);
  }

  let w = 0;
  for (let i = 0; i < sim.echoes.length; i++) {
    const e = sim.echoes[i];
    e.t += dt;
    if (e.t >= 0 && !e.armed) {
      e.armed = 1;
      if (e.str > sim.reveal[e.f]) sim.reveal[e.f] = e.str;
    }
    if (e.t < ECHO_LIFE) sim.echoes[w++] = e;
  }
  sim.echoes.length = w;

  const gk = dt / 2.4;
  for (let i = 0; i < sim.shards.length; i++) {
    const s = sim.shards[i];
    s.spin += dt * 1.6;
    if (s.spin > TAU) s.spin -= TAU;
    s.glow = s.glow > gk ? s.glow - gk : 0;
  }
  sim.exit.glow = sim.exit.glow > gk ? sim.exit.glow - gk : 0;
  if (sim.hunter) {
    const hk = dt / 1.15;
    sim.hunter.glow = sim.hunter.glow > hk ? sim.hunter.glow - hk : 0;
  }
}

function turnToward(a, b, t) {
  const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * clamp(t, 0, 1);
}

// ---------------------------------------------------------------- the step

export function stepSim(sim, intent = {}, dt = 1 / 60) {
  sim.frames++;
  decayVisuals(sim, dt);
  if (sim.over) return sim;

  sim.time += dt;
  const p = sim.player;

  // --- facing
  const mx = clamp(intent.mx || 0, -1, 1);
  const my = clamp(intent.my || 0, -1, 1);
  const len = Math.hypot(mx, my);
  if (typeof intent.aim === 'number' && Number.isFinite(intent.aim)) p.face = intent.aim;
  else if (len > 0.01) p.face = turnToward(p.face, Math.atan2(my, mx), clamp(14 * dt, 0, 1));

  // --- movement
  const speed = intent.sneak ? SNEAK_SPEED : RUN_SPEED;
  const bx = p.x, by = p.y;
  if (len > 0.01) {
    moveCircle(sim.map, p, (mx / len) * speed * dt, (my / len) * speed * dt, PLAYER_R);
  }
  const moved = Math.hypot(p.x - bx, p.y - by);
  p.moving = moved > 0.0001 ? 1 : 0;

  // --- footsteps: running is a quiet, short-range giveaway; sneaking is silent
  if (moved > 0.0001 && !intent.sneak) {
    p.stepT += moved;
    if (p.stepT >= FOOTSTEP_STRIDE) {
      p.stepT -= FOOTSTEP_STRIDE;
      pushFx(sim, { type: 'foot', x: p.x, y: p.y });
      emitSound(sim, p.x, p.y, FOOTSTEP_LOUD);
    }
  }

  // --- pings
  sim.cool.wide = Math.max(0, sim.cool.wide - dt);
  sim.cool.narrow = Math.max(0, sim.cool.narrow - dt);
  const kind = intent.ping;
  if ((kind === 'wide' || kind === 'narrow') && sim.cool[kind] <= 0) {
    emitPing(sim, kind);
    sim.cool[kind] = PING[kind].cool;
    const other = kind === 'wide' ? 'narrow' : 'wide';
    if (sim.cool[other] < PING_LOCKOUT) sim.cool[other] = PING_LOCKOUT;
  }

  selfGlow(sim);
  stepHunter(sim, dt);

  // --- shards
  for (let i = 0; i < sim.shards.length; i++) {
    const s = sim.shards[i];
    if (s.taken) continue;
    if (Math.hypot(s.x - p.x, s.y - p.y) < SHARD_R) {
      s.taken = true;
      sim.collected++;
      pushFx(sim, { type: 'shard', x: s.x, y: s.y, n: sim.collected });
      emitSound(sim, s.x, s.y, SHARD_LOUD);
      if (sim.collected >= sim.shards.length) {
        sim.exit.active = true;
        pushFx(sim, { type: 'exitOpen', x: sim.exit.x, y: sim.exit.y });
      }
    }
  }

  // --- dread (drives the heartbeat in the audio layer)
  if (sim.hunter) {
    const hd = Math.hypot(sim.hunter.x - p.x, sim.hunter.y - p.y);
    const prox = clamp(1 - hd / 300, 0, 1);
    sim.dread = clamp(prox * (0.55 + 0.45 * sim.hunter.alert), 0, 1);
  }

  // --- win / lose
  if (sim.exit.active && Math.hypot(sim.exit.x - p.x, sim.exit.y - p.y) < EXIT_R) {
    sim.won = true; sim.over = true;
    pushFx(sim, { type: 'win', x: p.x, y: p.y });
  } else if (sim.hunter && Math.hypot(sim.hunter.x - p.x, sim.hunter.y - p.y) < CATCH_DIST) {
    sim.dead = true; sim.over = true;
    pushFx(sim, { type: 'caught', x: p.x, y: p.y });
  }

  return sim;
}

/** Convenience for scripted tests: put the player somewhere and settle one frame. */
export function teleport(sim, x, y) { sim.player.x = x; sim.player.y = y; return sim; }
