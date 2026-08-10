// Mirrorbind — one input, two (then three) brains.
//
// Reference implementation for Gamesx10. Shape to copy:
//   1. Pure, cloneable simulation state + a single stepSim(sim, mask) used by BOTH
//      the live game and the headless solver/self-test. Physics can never drift apart.
//   2. boot() from ../../shared/kit.js for the fixed-timestep loop, input, FX, storage.
//   3. registerSelftest() proving init / input response / progress / win / lose / no-NaN.

import {
  boot, registerSelftest, Palette, FX, Sound, Store,
  clamp, text, roundRect, allFinite, TAU,
} from '../../shared/kit.js';
import { LEVELS } from './levels.js';

// ---------------------------------------------------------------- tuning

const TILE = 16;
const PW = 10, PH = 12;          // player box
const SPEED = 84;                 // px/s
const ACCEL_GROUND = 900;
const ACCEL_AIR = 520;
const FRICTION = 1100;
const GRAVITY = 620;
const JUMP_V = 232;               // ~2.7 tiles up, ~3.9 tiles across
const MAX_FALL = 380;
const COYOTE = 6;                 // frames
const BUFFER = 6;                 // frames
const CUT = 0.45;                 // release-jump-early damping

const M_LEFT = 1, M_RIGHT = 2, M_JUMP = 4;

// ---------------------------------------------------------------- simulation (pure)

function parseWorld(w) {
  const grid = w.grid;
  const rows = grid.length, cols = grid[0].length;
  let spawn = { x: 1, y: 1 }, exit = { x: cols - 2, y: 1 };
  const solid = [], spike = [];
  for (let r = 0; r < rows; r++) {
    solid.push(new Uint8Array(cols));
    spike.push(new Uint8Array(cols));
    for (let c = 0; c < cols; c++) {
      const ch = grid[r][c];
      if (ch === '#') solid[r][c] = 1;
      else if (ch === '^') spike[r][c] = 1;
      else if (ch === 'S') spawn = { x: c, y: r };
      else if (ch === 'E') exit = { x: c, y: r };
    }
  }
  return { rows, cols, solid, spike, spawn, exit, flipX: !!w.flipX, flipY: !!w.flipY };
}

/** Drop the character onto its own floor at spawn, so a jump held from frame 1 fires. */
function settle(w, ch) {
  const gDir = w.flipY ? -1 : 1;
  let guard = 0;
  while (!boxHitsSolid(w, ch.x, ch.y + gDir) && guard++ < TILE * 4) ch.y += gDir;
  if (boxHitsSolid(w, ch.x, ch.y + gDir)) { ch.onGround = true; ch.coyote = COYOTE; }
}

function makeSim(levelIndex) {
  const level = LEVELS[levelIndex];
  const worlds = level.worlds.map(parseWorld);
  const chars = worlds.map((w) => ({
    x: w.spawn.x * TILE + (TILE - PW) / 2,
    y: w.spawn.y * TILE + (TILE - PH) / 2,
    vx: 0, vy: 0,
    onGround: false, coyote: 0, buffer: 0, jumpHeld: false,
    won: false, dead: false,
    face: w.flipX ? -1 : 1,
  }));
  for (let i = 0; i < chars.length; i++) settle(worlds[i], chars[i]);
  return {
    levelIndex,
    worlds,
    chars,
    prevJump: false,
    dead: false,
    won: false,
    frames: 0,
  };
}

function cloneSim(s) {
  return {
    levelIndex: s.levelIndex,
    worlds: s.worlds, // immutable after parse — safe to share
    chars: s.chars.map((c) => ({ ...c })),
    prevJump: s.prevJump,
    dead: s.dead,
    won: s.won,
    frames: s.frames,
  };
}

function solidAt(w, cx, cy) {
  // Sides are walls, but above and below the grid is open void — so a gap in the floor
  // drops you out of the world and kills you, instead of becoming a well you sit in.
  if (cx < 0 || cx >= w.cols) return true;
  if (cy < 0 || cy >= w.rows) return false;
  return !!w.solid[cy][cx];
}
function spikeAt(w, cx, cy) {
  if (cy < 0 || cy >= w.rows || cx < 0 || cx >= w.cols) return false;
  return !!w.spike[cy][cx];
}

function boxHitsSolid(w, x, y) {
  const c0 = Math.floor(x / TILE), c1 = Math.floor((x + PW - 0.001) / TILE);
  const r0 = Math.floor(y / TILE), r1 = Math.floor((y + PH - 0.001) / TILE);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (solidAt(w, c, r)) return true;
  return false;
}

function boxHitsSpike(w, x, y) {
  // Spikes use a slimmer hitbox so grazing the edge is survivable.
  const pad = 3;
  const c0 = Math.floor((x + pad) / TILE), c1 = Math.floor((x + PW - pad) / TILE);
  const r0 = Math.floor((y + pad) / TILE), r1 = Math.floor((y + PH - pad) / TILE);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (spikeAt(w, c, r)) return true;
  return false;
}

/** One fixed simulation step. mask = bitfield of M_LEFT | M_RIGHT | M_JUMP. */
function stepSim(sim, mask, dt) {
  if (sim.dead || sim.won) return sim;

  const jump = !!(mask & M_JUMP);
  const jumpPressed = jump && !sim.prevJump;
  sim.prevJump = jump;

  let allWon = true;

  for (let i = 0; i < sim.chars.length; i++) {
    const ch = sim.chars[i];
    const w = sim.worlds[i];
    if (ch.won || ch.dead) { if (!ch.won) allWon = false; continue; }

    // --- input transform: this is the whole game
    let left = !!(mask & M_LEFT), right = !!(mask & M_RIGHT);
    if (w.flipX) { const t = left; left = right; right = t; }
    const gDir = w.flipY ? -1 : 1;      // +1 = gravity pulls down

    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    if (dir !== 0) ch.face = dir;

    // --- horizontal
    const accel = ch.onGround ? ACCEL_GROUND : ACCEL_AIR;
    if (dir !== 0) {
      ch.vx += dir * accel * dt;
      ch.vx = clamp(ch.vx, -SPEED, SPEED);
    } else {
      const f = FRICTION * dt;
      ch.vx = Math.abs(ch.vx) <= f ? 0 : ch.vx - Math.sign(ch.vx) * f;
    }

    // --- jump (coyote + buffer + variable height)
    if (jumpPressed) ch.buffer = BUFFER;
    if (ch.buffer > 0) ch.buffer--;
    if (ch.coyote > 0) ch.coyote--;

    if (ch.buffer > 0 && ch.coyote > 0) {
      ch.vy = -JUMP_V * gDir;
      ch.buffer = 0; ch.coyote = 0; ch.onGround = false; ch.jumpHeld = true;
    }
    if (ch.jumpHeld && !jump) {
      if (ch.vy * gDir < 0) ch.vy *= CUT;
      ch.jumpHeld = false;
    }

    // --- gravity
    ch.vy += GRAVITY * gDir * dt;
    ch.vy = clamp(ch.vy, -MAX_FALL, MAX_FALL);

    // --- integrate + resolve, one axis at a time
    let nx = ch.x + ch.vx * dt;
    if (boxHitsSolid(w, nx, ch.y)) {
      const step = Math.sign(ch.vx);
      while (!boxHitsSolid(w, ch.x + step, ch.y) && Math.abs(ch.x + step - nx) > 0.01) ch.x += step;
      ch.vx = 0;
    } else ch.x = nx;

    let ny = ch.y + ch.vy * dt;
    ch.onGround = false;
    if (boxHitsSolid(w, ch.x, ny)) {
      const step = Math.sign(ch.vy);
      while (!boxHitsSolid(w, ch.x, ch.y + step) && Math.abs(ch.y + step - ny) > 0.01) ch.y += step;
      if (ch.vy * gDir > 0) { ch.onGround = true; ch.coyote = COYOTE; }
      ch.vy = 0;
    } else {
      ch.y = ny;
    }

    // --- hazards
    if (boxHitsSpike(w, ch.x, ch.y)) ch.dead = true;
    if (ch.y > w.rows * TILE + 40 || ch.y < -40) ch.dead = true;

    // --- exit
    const ex = w.exit.x * TILE + TILE / 2, ey = w.exit.y * TILE + TILE / 2;
    if (Math.abs(ch.x + PW / 2 - ex) < TILE * 0.55 && Math.abs(ch.y + PH / 2 - ey) < TILE * 0.7) {
      ch.won = true;
      ch.vx = 0; ch.vy = 0;
    }

    if (ch.dead) sim.dead = true;
    if (!ch.won) allWon = false;
  }

  if (allWon) sim.won = true;
  sim.frames++;
  return sim;
}

// ---------------------------------------------------------------- solver (proves levels are beatable)

const SOLVER_ACTIONS = [0, M_LEFT, M_RIGHT, M_JUMP, M_LEFT | M_JUMP, M_RIGHT | M_JUMP];

/** Minimal binary heap keyed on `f`. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node) {
    const a = this.a; a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  }
}

/**
 * Weighted best-first search over coarse input decisions. Proves every level is
 * beatable and extracts the scripts replayed by window.__selftest().
 *
 * Plain BFS drowns here: 6 actions x ~25 decisions explodes long before it reaches
 * a goal, so it reports "unsolvable" for levels that are trivially solvable. The
 * heuristic — remaining distance to each exit, summed over all characters — collapses
 * that. Returns [[frames, mask], ...] or null.
 */
export function solve(levelIndex, { hold = 5, maxDepth = 160, maxNodes = 220000, greed = 3 } = {}) {
  const dt = 1 / 60;
  const start = makeSim(levelIndex);

  const heuristic = (s) => {
    let total = 0;
    for (let i = 0; i < s.chars.length; i++) {
      const c = s.chars[i];
      if (c.won) continue;
      const w = s.worlds[i];
      total += Math.abs(c.x + PW / 2 - (w.exit.x * TILE + TILE / 2))
             + Math.abs(c.y + PH / 2 - (w.exit.y * TILE + TILE / 2)) * 0.7;
    }
    return total;
  };

  const key = (s) => s.chars.map((c) =>
    `${Math.round(c.x / 4)},${Math.round(c.y / 4)},${Math.round(c.vx / 40)},${Math.round(c.vy / 55)},${c.won ? 1 : 0}`
  ).join('|') + (s.prevJump ? 'J' : '');

  const open = new Heap();
  open.push({ sim: start, path: [], depth: 0, f: heuristic(start) });
  const seen = new Set([key(start)]);
  let nodes = 0;

  while (open.size) {
    const node = open.pop();
    if (node.depth >= maxDepth) continue;
    for (const mask of SOLVER_ACTIONS) {
      if (++nodes > maxNodes) return null;
      const s = cloneSim(node.sim);
      for (let f = 0; f < hold && !s.dead && !s.won; f++) stepSim(s, mask, dt);
      if (s.dead) continue;
      const path = node.path.concat([[hold, mask]]);
      if (s.won) return path;
      const k = key(s);
      if (seen.has(k)) continue;
      seen.add(k);
      open.push({ sim: s, path, depth: node.depth + 1, f: heuristic(s) + (node.depth + 1) * greed });
    }
  }
  return null;
}

/** Replay a solution script headlessly. Returns the finished sim. */
export function replay(levelIndex, script) {
  const dt = 1 / 60;
  const s = makeSim(levelIndex);
  for (const [frames, mask] of script) {
    for (let f = 0; f < frames && !s.dead && !s.won; f++) stepSim(s, mask, dt);
    if (s.dead || s.won) break;
  }
  return s;
}

/** Dev helper: solve every level and print embeddable scripts. Run from the console. */
export function solveAll(opts) {
  const out = [];
  for (let i = 0; i < LEVELS.length; i++) {
    const t0 = performance.now();
    const sol = solve(i, opts);
    out.push({ level: i, name: LEVELS[i].name, solved: !!sol, steps: sol ? sol.length : 0, ms: Math.round(performance.now() - t0), script: sol });
  }
  return out;
}

// ---------------------------------------------------------------- game

const MAX_LEVEL_KEY = 'maxLevel';

function init(g) {
  const startLevel = clamp(Store.get(MAX_LEVEL_KEY, 0), 0, LEVELS.length - 1);
  return {
    levelIndex: startLevel,
    sim: makeSim(startLevel),
    deaths: Store.get('deaths', 0),
    runDeaths: 0,
    phase: 'intro',        // intro | play | dying | cleared | complete
    timer: 0,
    flash: 0,
    hintT: 0,
    totalCleared: Store.get('cleared', 0),
  };
}

function loadLevel(s, idx) {
  s.levelIndex = clamp(idx, 0, LEVELS.length - 1);
  s.sim = makeSim(s.levelIndex);
  s.hintT = 2.6;
}

function currentMask(g) {
  const I = g.input;
  let m = 0;
  if (I.isDown('left') || I.isDown('a')) m |= M_LEFT;
  if (I.isDown('right') || I.isDown('d')) m |= M_RIGHT;
  if (I.isDown('space') || I.isDown('up') || I.isDown('w')) m |= M_JUMP;
  return m;
}

function update(s, dt, g) {
  s.flash = Math.max(0, s.flash - dt * 3);
  if (s.hintT > 0) s.hintT -= dt;

  if (s.phase === 'intro') {
    if (g.input.justPressed('space') || g.input.justPressed('enter') || g.input.pointerPressed) {
      s.phase = 'play';
      s.hintT = 2.6;
      Sound.init(); Sound.resume();
    }
    return;
  }

  if (s.phase === 'complete') {
    if (g.input.justPressed('enter')) {
      Store.set(MAX_LEVEL_KEY, 0);
      s.runDeaths = 0;
      loadLevel(s, 0);
      s.phase = 'play';
    }
    return;
  }

  if (s.phase === 'dying') {
    s.timer -= dt;
    if (s.timer <= 0) { loadLevel(s, s.levelIndex); s.phase = 'play'; }
    return;
  }

  if (s.phase === 'cleared') {
    s.timer -= dt;
    if (s.timer <= 0) {
      const next = s.levelIndex + 1;
      if (next >= LEVELS.length) {
        s.phase = 'complete';
        Store.set(MAX_LEVEL_KEY, 0);
      } else {
        Store.set(MAX_LEVEL_KEY, Math.max(Store.get(MAX_LEVEL_KEY, 0), next));
        loadLevel(s, next);
        s.phase = 'play';
      }
    }
    return;
  }

  // --- playing
  if (g.input.justPressed('r')) { s.deaths++; s.runDeaths++; loadLevel(s, s.levelIndex); return; }
  if (g.input.justPressed('n') && g.input.isDown('shift')) { // dev skip
    loadLevel(s, s.levelIndex + 1); return;
  }

  const before = s.sim.chars.map((c) => c.won);
  stepSim(s.sim, currentMask(g), dt);

  for (let i = 0; i < s.sim.chars.length; i++) {
    if (s.sim.chars[i].won && !before[i]) {
      const c = s.sim.chars[i];
      FX.burst(c.x + PW / 2, c.y + PH / 2, { count: 18, color: Palette.accent, speed: 90, life: 0.5, size: 3 });
      Sound.blip(760 + i * 120);
    }
  }

  if (s.sim.dead) {
    s.deaths++; s.runDeaths++;
    Store.set('deaths', s.deaths);
    s.phase = 'dying'; s.timer = 0.34; s.flash = 1;
    FX.shake(9);
    Sound.bad();
    for (const c of s.sim.chars) {
      if (c.dead) FX.burst(c.x + PW / 2, c.y + PH / 2, { count: 22, color: Palette.hot, speed: 150, life: 0.45, size: 3, gravity: 300 });
    }
  } else if (s.sim.won) {
    s.phase = 'cleared'; s.timer = 0.55;
    s.totalCleared++;
    Store.set('cleared', s.totalCleared);
    FX.shake(4);
    Sound.ok();
  }
}

// ---------------------------------------------------------------- render

function panelRects(g, n) {
  const pad = 10;
  const gap = 8;
  const topPad = 34, botPad = 26;
  const availW = g.w - pad * 2 - gap * (n - 1);
  const availH = g.h - topPad - botPad;
  const pw = availW / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: pad + i * (pw + gap), y: topPad, w: pw, h: availH });
  return out;
}

function drawWorld(ctx, w, ch, rect, s, idx) {
  const scale = Math.min(rect.w / (w.cols * TILE), rect.h / (w.rows * TILE));
  const ox = rect.x + (rect.w - w.cols * TILE * scale) / 2;
  const oy = rect.y + (rect.h - w.rows * TILE * scale) / 2;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  const W = w.cols * TILE, H = w.rows * TILE;

  // backdrop
  ctx.fillStyle = Palette.bg2;
  ctx.fillRect(0, 0, W, H);

  // subtle grid
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let c = 1; c < w.cols; c++) { ctx.moveTo(c * TILE, 0); ctx.lineTo(c * TILE, H); }
  for (let r = 1; r < w.rows; r++) { ctx.moveTo(0, r * TILE); ctx.lineTo(W, r * TILE); }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // tiles
  for (let r = 0; r < w.rows; r++) {
    for (let c = 0; c < w.cols; c++) {
      if (w.solid[r][c]) {
        ctx.fillStyle = '#1c2436';
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
        ctx.fillStyle = '#28324a';
        const openTop = !solidAt(w, c, r - 1);
        if (openTop) ctx.fillRect(c * TILE, r * TILE, TILE, 2);
      }
      if (w.spike[r][c]) {
        ctx.fillStyle = Palette.hot;
        const bx = c * TILE, by = r * TILE;
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          ctx.moveTo(bx + k * 4, by + TILE);
          ctx.lineTo(bx + k * 4 + 2, by + TILE - 7);
          ctx.lineTo(bx + k * 4 + 4, by + TILE);
        }
        ctx.fill();
      }
    }
  }

  // exit
  const ex = w.exit.x * TILE, ey = w.exit.y * TILE;
  const pulse = 0.55 + 0.45 * Math.sin(s.timerT * 3 + idx);
  ctx.globalAlpha = ch.won ? 1 : pulse;
  ctx.strokeStyle = Palette.accent;
  ctx.lineWidth = 2;
  roundRect(ctx, ex + 2.5, ey + 2.5, TILE - 5, TILE - 5, 3);
  ctx.stroke();
  ctx.globalAlpha = 0.16 * (ch.won ? 1.6 : pulse);
  ctx.fillStyle = Palette.accent;
  ctx.fill();
  ctx.globalAlpha = 1;

  // gravity marker for inverted worlds
  if (w.flipY) {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = Palette.violet;
    ctx.lineWidth = 1.5;
    for (let k = 0; k < 3; k++) {
      const ax = W - 14, ay = 10 + k * 5;
      ctx.beginPath();
      ctx.moveTo(ax, ay + 3); ctx.lineTo(ax + 3, ay); ctx.lineTo(ax + 6, ay + 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // character
  if (!ch.dead) {
    const col = ch.won ? Palette.accent : (w.flipY ? Palette.violet : (w.flipX ? Palette.accent2 : Palette.warm));
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = ch.won ? 14 : 8;
    roundRect(ctx, ch.x, ch.y, PW, PH, 2.5);
    ctx.fill();
    ctx.shadowBlur = 0;
    // eye — shows which way this one thinks "forward" is
    ctx.fillStyle = Palette.bg;
    ctx.fillRect(ch.x + (ch.face > 0 ? PW - 4 : 2), ch.y + 3, 2, 2);
  }

  ctx.restore();

  // panel frame + label
  ctx.strokeStyle = ch.won ? Palette.accent : Palette.grid;
  ctx.globalAlpha = ch.won ? 0.7 : 1;
  ctx.lineWidth = 1;
  roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, 8);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const label = (w.flipX ? 'MIRRORED' : 'NORMAL') + (w.flipY ? ' · INVERTED' : '');
  text(ctx, label, rect.x + 9, rect.y + rect.h + 7, {
    size: 9, color: ch.won ? Palette.accent : Palette.dim, alpha: 0.85,
  });
}

function render(s, ctx, g) {
  s.timerT = g.t;
  ctx.fillStyle = Palette.bg;
  ctx.fillRect(0, 0, g.w, g.h);

  const level = LEVELS[s.levelIndex];
  const rects = panelRects(g, s.sim.worlds.length);
  for (let i = 0; i < s.sim.worlds.length; i++) {
    drawWorld(ctx, s.sim.worlds[i], s.sim.chars[i], rects[i], s, i);
  }

  FX.draw(ctx);

  // HUD
  text(ctx, `${String(s.levelIndex + 1).padStart(2, '0')}/${String(LEVELS.length).padStart(2, '0')}  ${level.name.toUpperCase()}`,
    12, 12, { size: 12, color: Palette.ink, weight: 700 });
  text(ctx, `DEATHS ${s.runDeaths}`, g.w - 12, 12, { size: 11, color: Palette.dim, align: 'right' });

  if (s.hintT > 0 && s.phase === 'play') {
    const a = clamp(s.hintT / 0.6, 0, 1);
    text(ctx, level.hint, g.w / 2, g.h - 16, { size: 11, color: Palette.dim, align: 'center', alpha: a });
  }

  if (s.flash > 0) {
    ctx.globalAlpha = s.flash * 0.28;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalAlpha = 1;
  }

  if (s.phase === 'intro') {
    ctx.fillStyle = 'rgba(7,8,13,0.86)';
    ctx.fillRect(0, 0, g.w, g.h);
    text(ctx, 'MIRRORBIND', g.w / 2, g.h / 2 - 46, { size: 30, color: Palette.accent, align: 'center', weight: 700 });
    text(ctx, 'One set of keys controls every version of you at once.', g.w / 2, g.h / 2 - 6, { size: 13, color: Palette.ink, align: 'center' });
    text(ctx, 'Mirrored worlds read your left as their right. Get all of you home.', g.w / 2, g.h / 2 + 14, { size: 12, color: Palette.dim, align: 'center' });
    text(ctx, '←/→ or A/D  ·  SPACE to jump  ·  R to retry', g.w / 2, g.h / 2 + 46, { size: 12, color: Palette.dim, align: 'center' });
    const p = 0.5 + 0.5 * Math.sin(g.t * 3);
    text(ctx, 'PRESS SPACE', g.w / 2, g.h / 2 + 78, { size: 13, color: Palette.warm, align: 'center', weight: 700, alpha: 0.4 + p * 0.6 });
  }

  if (s.phase === 'complete') {
    ctx.fillStyle = 'rgba(7,8,13,0.9)';
    ctx.fillRect(0, 0, g.w, g.h);
    text(ctx, 'ALL TEN BOUND', g.w / 2, g.h / 2 - 30, { size: 26, color: Palette.accent, align: 'center', weight: 700 });
    text(ctx, `You finished with ${s.runDeaths} deaths.`, g.w / 2, g.h / 2 + 6, { size: 13, color: Palette.ink, align: 'center' });
    text(ctx, 'ENTER to run it back', g.w / 2, g.h / 2 + 34, { size: 12, color: Palette.dim, align: 'center' });
  }
}

// ---------------------------------------------------------------- boot + self-test

const game = boot({ id: 'mirrorbind', title: 'Mirrorbind', seed: 1, init, update, render });

registerSelftest('mirrorbind', (check, log) => {
  const dt = 1 / 60;

  // 1. world initializes
  const s0 = makeSim(0);
  check('level 0 initializes with 2 worlds', s0.worlds.length === 2, `worlds=${s0.worlds.length}`);
  check('every level parses with >=2 worlds and a spawn+exit', LEVELS.every((_, i) => {
    const s = makeSim(i);
    return s.worlds.length >= 2 && s.chars.length === s.worlds.length;
  }), `${LEVELS.length} levels`);

  // 2. input actually moves the characters — and mirrored worlds move the OTHER way
  const s1 = makeSim(0);
  const x0 = s1.chars.map((c) => c.x);
  for (let i = 0; i < 30; i++) stepSim(s1, M_RIGHT, dt);
  check('normal world moves right on RIGHT', s1.chars[0].x > x0[0] + 4, `dx=${(s1.chars[0].x - x0[0]).toFixed(1)}`);
  check('mirrored world moves left on RIGHT', s1.chars[1].x < x0[1] - 4, `dx=${(s1.chars[1].x - x0[1]).toFixed(1)}`);

  // 3. jump leaves the ground
  const s2 = makeSim(0);
  const y0 = s2.chars[0].y;
  for (let i = 0; i < 14; i++) stepSim(s2, M_JUMP, dt);
  check('JUMP raises the character', s2.chars[0].y < y0 - 6, `dy=${(s2.chars[0].y - y0).toFixed(1)}`);

  // 4. WIN is reachable — replay each level's verified script
  let solvedCount = 0;
  const unsolved = [];
  for (let i = 0; i < LEVELS.length; i++) {
    const script = LEVELS[i].solution;
    if (!script) { unsolved.push(`${i}:no-script`); continue; }
    const s = replay(i, script);
    if (s.won) solvedCount++; else unsolved.push(`${i}:${s.dead ? 'died' : 'timeout'}`);
  }
  check('every level has a verified winning script', solvedCount === LEVELS.length,
    `${solvedCount}/${LEVELS.length} ${unsolved.length ? '· failed: ' + unsolved.join(',') : ''}`);

  // 5. LOSE is reachable — walk into the pit on level 1 without jumping
  const s3 = makeSim(1);
  for (let i = 0; i < 300 && !s3.dead && !s3.won; i++) stepSim(s3, M_RIGHT, dt);
  check('lose condition reachable (pit kills)', s3.dead === true, `dead=${s3.dead} won=${s3.won} frames=${s3.frames}`);

  // 6. no NaN/Infinity after a long chaotic run
  const s4 = makeSim(LEVELS.length - 1);
  let mask = 0;
  for (let i = 0; i < 900; i++) {
    if (i % 7 === 0) mask = [0, M_LEFT, M_RIGHT, M_JUMP, M_LEFT | M_JUMP, M_RIGHT | M_JUMP][(i / 7) % 6 | 0];
    stepSim(s4, mask, dt);
    if (s4.dead || s4.won) { Object.assign(s4, makeSim(LEVELS.length - 1)); }
  }
  const fin = allFinite(s4.chars);
  check('no NaN/Infinity after 900 frames', fin.ok, fin.bad.slice(0, 3).join(','));

  // 7. the live game responds to real injected input through the kit
  game.restart();
  game.state.phase = 'play';
  const live0 = game.state.sim.chars[0].x;
  game.input.press('right');
  game.step(30);
  game.input.release('right');
  check('live game responds to kit input', game.state.sim.chars[0].x > live0 + 4,
    `dx=${(game.state.sim.chars[0].x - live0).toFixed(1)}`);
  check('live state stays finite', allFinite(game.state.sim.chars).ok);

  game.restart();
  log(`levels=${LEVELS.length} solved=${solvedCount}`);
});

// expose for the dev console / verification tooling
globalThis.__mirrorbind = { solve, solveAll, replay, makeSim, stepSim, LEVELS, M_LEFT, M_RIGHT, M_JUMP };

export default game;
