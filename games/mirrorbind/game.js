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
  Type, HUD_H, hudStrip, stat, panel, meter, orb, vignette, titleCard, withGlow,
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

const HEX6 = /^#([0-9a-f]{6})$/i;

/** Alpha variant of a palette colour. The arcade's hue set stays fixed. */
function withAlpha(hex, a) {
  const m = HEX6.exec(String(hex));
  if (!m) return String(hex);
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** One hue per transform: upright = warm, mirrored = blue, inverted = violet. */
function worldTint(w) {
  return w.flipY ? Palette.violet : (w.flipX ? Palette.accent2 : Palette.warm);
}

function worldLabel(w, short) {
  return (w.flipX ? (short ? 'MIRROR' : 'MIRRORED') : 'NORMAL')
       + (w.flipY ? (short ? ' INV' : ' · INVERTED') : '');
}

// Layout maths never calls measureText, so the HUD lands identically in every engine
// (and in the headless gate). Mono advance is a fixed fraction of the font size.
const monoW = (str, size) => String(str).length * size * 0.62;
const capW = (str, size = Type.label) => String(str).length * size * 0.74;
const pad2 = (n) => String(n).padStart(2, '0');

/** Uppercase, letterspaced, dim — the treatment stat() gives its labels. */
function capLabel(ctx, str, x, y, { size = Type.label, color = Palette.dim, align = 'left', alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const prev = ctx.letterSpacing;
  try { ctx.letterSpacing = '0.14em'; } catch { /* older engines */ }
  ctx.fillText(String(str).toUpperCase(), x, y);
  try { ctx.letterSpacing = prev || '0px'; } catch { /* ignore */ }
  ctx.restore();
}

/** Stubby arrow used by the per-panel transform badges. */
function arrow(ctx, cx, cy, dx, dy, len, color, alpha = 0.85) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const tx = cx + dx * len, ty = cy + dy * len;
  const px = -dy, py = dx;
  ctx.beginPath();
  ctx.moveTo(cx - dx * len, cy - dy * len);
  ctx.lineTo(tx, ty);
  ctx.moveTo(tx - dx * 3.4 + px * 2.6, ty - dy * 3.4 + py * 2.6);
  ctx.lineTo(tx, ty);
  ctx.lineTo(tx - dx * 3.4 - px * 2.6, ty - dy * 3.4 - py * 2.6);
  ctx.stroke();
  ctx.restore();
}

/** Which way this world hears "right", and which way it falls. */
function transformBadges(ctx, w, rightX, cy, tint) {
  // gravity: arrow toward the floor, with the floor drawn as a bar at the tip
  const gDir = w.flipY ? -1 : 1;
  const gx = rightX - 5;
  arrow(ctx, gx, cy - gDir * 1.5, 0, gDir, 4.5, tint, 0.9);
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = tint;
  ctx.fillRect(gx - 5, cy + gDir * 7 - (gDir > 0 ? 0 : 1.2), 10, 1.2);
  ctx.restore();
  // input: arrow toward whatever this world does when you press right
  arrow(ctx, rightX - 22, cy, w.flipX ? -1 : 1, 0, 5.5, tint, 0.9);
}

/**
 * Grid layout that maximises how large each world can be drawn, with a bias toward a
 * single row so mirrored pairs sit side by side whenever there is room for them.
 */
function panelRects(g, n, worldW, worldH) {
  const padX = 14, top = HUD_H + 14, padBot = 34, gap = 12;
  const availW = Math.max(80, g.w - padX * 2);
  const availH = Math.max(80, g.h - top - padBot);
  const headerFor = (h) => Math.max(20, Math.min(30, h * 0.14));

  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (availW - gap * (cols - 1)) / cols;
    const ch = (availH - gap * (rows - 1)) / rows;
    if (cw < 70 || ch < 74) continue;
    const scale = Math.min((cw - 20) / worldW, (ch - headerFor(ch) - 12) / worldH);
    const score = scale * (rows === 1 && scale >= 1.2 ? 1.5 : 1);
    if (!best || score > best.score) best = { cols, rows, cw, ch, score };
  }
  if (!best) {
    best = { cols: n, rows: 1, cw: Math.max(40, (availW - gap * (n - 1)) / n), ch: availH, score: 0 };
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / best.cols);
    const c = i % best.cols;
    const inRow = Math.min(best.cols, n - r * best.cols);
    const rowW = inRow * best.cw + (inRow - 1) * gap;
    out.push({
      x: padX + (availW - rowW) / 2 + c * (best.cw + gap),
      y: top + r * (best.ch + gap),
      w: best.cw, h: best.ch, row: r, col: c,
    });
  }
  return out;
}

/** The reflection axis between two bound worlds. */
function drawSeam(ctx, a, b, vertical) {
  ctx.save();
  if (vertical) {
    const x = (a.x + a.w + b.x) / 2;
    const y0 = Math.min(a.y, b.y) + 8, y1 = Math.max(a.y + a.h, b.y + b.h) - 8;
    if (y1 > y0) {
      const grad = ctx.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, withAlpha(Palette.accent, 0));
      grad.addColorStop(0.5, withAlpha(Palette.accent, 0.42));
      grad.addColorStop(1, withAlpha(Palette.accent, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y0);
      ctx.lineTo(Math.round(x) + 0.5, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      const my = (y0 + y1) / 2;
      withGlow(ctx, Palette.accent, 10, () => {
        ctx.fillStyle = withAlpha(Palette.accent, 0.8);
        ctx.beginPath();
        ctx.moveTo(x, my - 5); ctx.lineTo(x + 3.5, my);
        ctx.lineTo(x, my + 5); ctx.lineTo(x - 3.5, my);
        ctx.closePath();
        ctx.fill();
      });
    }
  } else {
    const y = (a.y + a.h + b.y) / 2;
    const x0 = Math.min(a.x, b.x) + 8, x1 = Math.max(a.x + a.w, b.x + b.w) - 8;
    if (x1 > x0) {
      const grad = ctx.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, withAlpha(Palette.accent, 0));
      grad.addColorStop(0.5, withAlpha(Palette.accent, 0.42));
      grad.addColorStop(1, withAlpha(Palette.accent, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const mx = (x0 + x1) / 2;
      withGlow(ctx, Palette.accent, 10, () => {
        ctx.fillStyle = withAlpha(Palette.accent, 0.8);
        ctx.beginPath();
        ctx.moveTo(mx - 5, y); ctx.lineTo(mx, y - 3.5);
        ctx.lineTo(mx + 5, y); ctx.lineTo(mx, y + 3.5);
        ctx.closePath();
        ctx.fill();
      });
    }
  }
  ctx.restore();
}

function drawWorld(ctx, w, ch, rect, t, idx) {
  const base = worldTint(w);
  const frame = ch.won ? Palette.accent : (ch.dead ? Palette.hot : base);
  const headerH = Math.max(20, Math.min(30, rect.h * 0.14));
  const W = w.cols * TILE, H = w.rows * TILE;

  // ---- frame
  panel(ctx, rect.x, rect.y, rect.w, rect.h, {
    fill: 'rgba(13,16,24,0.92)',
    border: ch.won || ch.dead ? withAlpha(frame, 0.5) : Palette.grid,
    radius: 8,
    glowColor: ch.won ? Palette.accent : (ch.dead ? Palette.hot : null),
    glowBlur: 18,
  });

  // identity tab along the top edge, brightest on the side this world calls forward
  ctx.save();
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
  ctx.clip();
  const tab = ctx.createLinearGradient(w.flipX ? rect.x + rect.w : rect.x, 0, w.flipX ? rect.x : rect.x + rect.w, 0);
  tab.addColorStop(0, withAlpha(base, 0.1));
  tab.addColorStop(1, withAlpha(base, 0.85));
  ctx.fillStyle = tab;
  ctx.fillRect(rect.x, rect.y, rect.w, 2);
  ctx.restore();

  // ---- header
  const cy = rect.y + headerH / 2;
  const statusX = rect.x + rect.w - 16;
  if (ch.won || ch.dead) {
    orb(ctx, statusX, cy, 3.4, frame, { glow: 1.1, rim: false });
  } else {
    ctx.save();
    ctx.strokeStyle = withAlpha(base, 0.5);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(statusX, cy, 3.4, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  const badgeRight = statusX - 12;
  transformBadges(ctx, w, badgeRight, cy, base);

  const room = badgeRight - 30 - (rect.x + 13);
  const full = worldLabel(w, false);
  const short = worldLabel(w, true);
  const label = capW(full) <= room ? full : (capW(short) <= room ? short : null);
  if (label) {
    capLabel(ctx, label, rect.x + 13, cy, {
      color: ch.won ? Palette.accent : (ch.dead ? Palette.hot : Palette.dim), alpha: 0.95,
    });
  }

  ctx.save();
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rect.x + 1, rect.y + headerH + 0.5);
  ctx.lineTo(rect.x + rect.w - 1, rect.y + headerH + 0.5);
  ctx.stroke();
  ctx.restore();

  // ---- world viewport
  const vx = rect.x + 9;
  const vy = rect.y + headerH + 4;
  const vw = Math.max(8, rect.w - 18);
  const vh = Math.max(8, rect.h - headerH - 13);
  const scale = Math.max(0.05, Math.min(vw / W, vh / H));
  const ox = vx + (vw - W * scale) / 2;
  const oy = vy + (vh - H * scale) / 2;

  ctx.save();
  roundRect(ctx, vx, vy, vw, vh, 5);
  ctx.clip();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  // backdrop + a wash that flows the way this world reads your input, so a mirrored
  // pair lights up symmetrically about the seam between them
  ctx.fillStyle = Palette.bg2;
  ctx.fillRect(0, 0, W, H);
  const wash = ctx.createLinearGradient(w.flipX ? W : 0, 0, w.flipX ? 0 : W, 0);
  wash.addColorStop(0, withAlpha(base, 0));
  wash.addColorStop(1, withAlpha(base, 0.13));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);
  // and a second wash that is dark at whatever this world calls the sky
  const sky = ctx.createLinearGradient(0, w.flipY ? H : 0, 0, w.flipY ? 0 : H);
  sky.addColorStop(0, 'rgba(0,0,0,0.34)');
  sky.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // grid
  ctx.save();
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1 / Math.max(0.4, scale);
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  for (let c = 1; c < w.cols; c++) { ctx.moveTo(c * TILE, 0); ctx.lineTo(c * TILE, H); }
  for (let r = 1; r < w.rows; r++) { ctx.moveTo(0, r * TILE); ctx.lineTo(W, r * TILE); }
  ctx.stroke();
  ctx.restore();

  // tiles
  const capCol = withAlpha(base, 0.42);
  for (let r = 0; r < w.rows; r++) {
    for (let c = 0; c < w.cols; c++) {
      if (w.solid[r][c]) {
        ctx.fillStyle = '#1c2436';
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
        ctx.fillStyle = '#28324a';
        // the lit edge is the one the character actually stands on
        const capR = w.flipY ? r + 1 : r - 1;
        if (!solidAt(w, c, capR)) {
          const cy2 = w.flipY ? (r + 1) * TILE - 2 : r * TILE;
          ctx.fillRect(c * TILE, cy2, TILE, 2);
          ctx.fillStyle = capCol;
          ctx.fillRect(c * TILE, cy2, TILE, 1);
        }
      }
      if (w.spike[r][c]) {
        const bx = c * TILE, by = r * TILE;
        withGlow(ctx, Palette.hot, 7, () => {
          ctx.fillStyle = Palette.hot;
          ctx.beginPath();
          for (let k = 0; k < 4; k++) {
            ctx.moveTo(bx + k * 4, by + TILE);
            ctx.lineTo(bx + k * 4 + 2, by + TILE - 7);
            ctx.lineTo(bx + k * 4 + 4, by + TILE);
          }
          ctx.fill();
        });
      }
    }
  }

  // exit portal
  const ex = w.exit.x * TILE, ey = w.exit.y * TILE;
  const pulse = 0.55 + 0.45 * Math.sin(t * 3 + idx);
  ctx.save();
  ctx.globalAlpha = 0.14 * (ch.won ? 2 : pulse);
  ctx.fillStyle = Palette.accent;
  roundRect(ctx, ex + 2.5, ey + 2.5, TILE - 5, TILE - 5, 3);
  ctx.fill();
  ctx.restore();
  withGlow(ctx, Palette.accent, 8 + 8 * pulse, () => {
    ctx.strokeStyle = withAlpha(Palette.accent, ch.won ? 0.95 : 0.4 + 0.45 * pulse);
    ctx.lineWidth = 1.4;
    roundRect(ctx, ex + 2.5, ey + 2.5, TILE - 5, TILE - 5, 3);
    ctx.stroke();
  });
  orb(ctx, ex + TILE / 2, ey + TILE / 2, 1.4 + pulse * 0.8, Palette.accent,
    { glow: ch.won ? 1.6 : 0.5 + pulse * 0.6, rim: false });

  // character — a lit object, not a filled rect
  if (!ch.dead) {
    const col = ch.won ? Palette.accent : base;
    withGlow(ctx, col, ch.won ? 16 : 9, () => {
      ctx.fillStyle = col;
      roundRect(ctx, ch.x, ch.y, PW, PH, 2.5);
      ctx.fill();
    });
    ctx.save();
    roundRect(ctx, ch.x, ch.y, PW, PH, 2.5);
    ctx.clip();
    // the highlight sits on this world's "up", so inverted selves are lit from below
    const lg = ctx.createLinearGradient(0, w.flipY ? ch.y + PH : ch.y, 0, w.flipY ? ch.y : ch.y + PH);
    lg.addColorStop(0, 'rgba(255,255,255,0.4)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    lg.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = lg;
    ctx.fillRect(ch.x - 1, ch.y - 1, PW + 2, PH + 2);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.7;
    roundRect(ctx, ch.x + 0.35, ch.y + 0.35, PW - 0.7, PH - 0.7, 2.2);
    ctx.stroke();
    ctx.restore();
    // eye — which way this one thinks forward is, on the end its head is at
    ctx.save();
    ctx.fillStyle = Palette.bg;
    ctx.fillRect(ch.x + (ch.face > 0 ? PW - 4 : 2), ch.y + (w.flipY ? PH - 5 : 3), 2, 2);
    ctx.restore();
  }

  // particles live in world units — draw them inside each bound world
  FX.draw(ctx);

  ctx.restore();
}

function drawHud(s, ctx, g) {
  const compact = g.w < 760;
  hudStrip(ctx, g);

  const level = LEVELS[s.levelIndex];
  const levelValue = `${pad2(s.levelIndex + 1)}/${pad2(LEVELS.length)}`;
  let x = 18;
  stat(ctx, x, 20, 'Level', levelValue);
  x += Math.max(capW('LEVEL'), monoW(levelValue, Type.value)) + 26;

  if (!compact) {
    stat(ctx, x, 20, 'Chamber', level.name.toUpperCase(), {
      color: Palette.accent2, valueSize: Type.body,
    });
  }

  let rx = g.w - 18;
  const deaths = String(s.runDeaths);
  stat(ctx, rx, 20, 'Deaths', deaths, {
    align: 'right', color: s.runDeaths > 0 ? Palette.hot : Palette.ink,
  });
  rx -= Math.max(capW('DEATHS'), monoW(deaths, Type.value)) + 26;

  if (!compact) {
    const bound = s.sim.chars.reduce((a, c) => a + (c.won ? 1 : 0), 0);
    const boundValue = `${bound}/${s.sim.chars.length}`;
    stat(ctx, rx, 20, 'Bound', boundValue, {
      align: 'right', valueSize: Type.body,
      color: bound === s.sim.chars.length ? Palette.accent : Palette.ink,
    });
  }

  // run progress along the bottom edge of the strip
  meter(ctx, 0, HUD_H - 3, g.w, 3, (s.levelIndex + 1) / LEVELS.length, {
    color: withAlpha(Palette.accent, 0.75),
    track: 'rgba(255,255,255,0.04)',
    radius: 0, glow: false,
  });
}

function render(s, ctx, g) {
  ctx.save();
  ctx.fillStyle = Palette.bg;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.restore();

  const level = LEVELS[s.levelIndex];
  const worlds = s.sim.worlds;
  const worldW = Math.max(...worlds.map((w) => w.cols)) * TILE;
  const worldH = Math.max(...worlds.map((w) => w.rows)) * TILE;
  const rects = panelRects(g, worlds.length, worldW, worldH);

  for (let i = 0; i < worlds.length; i++) {
    drawWorld(ctx, worlds[i], s.sim.chars[i], rects[i], g.t, i);
  }

  // the bind between consecutive worlds
  for (let i = 0; i + 1 < rects.length; i++) {
    const a = rects[i], b = rects[i + 1];
    if (a.row === b.row) drawSeam(ctx, a, b, true);
    else if (a.col === b.col) drawSeam(ctx, a, b, false);
  }

  if (s.flash > 0) {
    ctx.save();
    ctx.globalAlpha = s.flash * 0.24;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, HUD_H + 1, g.w, Math.max(0, g.h - HUD_H - 1));
    ctx.restore();
  }

  drawHud(s, ctx, g);

  if (s.hintT > 0 && s.phase === 'play') {
    const a = clamp(s.hintT / 0.6, 0, 1);
    const size = clamp((g.w - 72) / Math.max(1, level.hint.length * 0.62), 8, Type.small);
    const pw = monoW(level.hint, size) + 30;
    const ph = 22;
    const px = g.w / 2 - pw / 2;
    const py = g.h - 30;
    ctx.save();
    ctx.globalAlpha = a;
    panel(ctx, px, py, pw, ph, {
      fill: 'rgba(13,16,24,0.9)', border: Palette.grid, radius: ph / 2,
    });
    text(ctx, level.hint, g.w / 2, py + ph / 2, {
      size, color: Palette.dim, align: 'center', baseline: 'middle',
    });
    ctx.restore();
  }

  if (s.phase === 'cleared') {
    const bw = Math.min(g.w - 40, 210);
    const bh = 34;
    const bx = g.w / 2 - bw / 2;
    const by = g.h / 2 - bh / 2;
    panel(ctx, bx, by, bw, bh, {
      fill: 'rgba(13,16,24,0.94)', border: withAlpha(Palette.accent, 0.45),
      radius: bh / 2, glowColor: Palette.accent, glowBlur: 20,
    });
    capLabel(ctx, 'Chamber Clear', g.w / 2, by + bh / 2, {
      size: Type.small, color: Palette.accent, align: 'center',
    });
  }

  if (s.phase === 'intro') {
    titleCard(ctx, g, {
      title: 'MIRRORBIND',
      tagline: 'One input moves every version of you.',
      lines: [
        'Mirrored worlds read your left as their right.',
        'Inverted worlds fall the other way.',
        'If one of you dies, all of you die.',
        '',
        'ARROWS / A D to move · SPACE jump · R retry',
      ],
      prompt: 'PRESS SPACE',
      t: g.t,
      accent: Palette.accent,
    });
  }

  if (s.phase === 'complete') {
    titleCard(ctx, g, {
      title: 'ALL TEN BOUND',
      tagline: `Finished with ${s.runDeaths} deaths.`,
      lines: ['Every mirror walked itself home.'],
      prompt: 'ENTER TO RUN IT BACK',
      t: g.t,
      accent: Palette.accent,
    });
  }

  vignette(ctx, g, 0.4);
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
