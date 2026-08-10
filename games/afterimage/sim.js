// Afterimage — pure, cloneable simulation. No DOM, no Math.random(), no Date.now().
// Same seed (none needed here — levels are static) + same input scripts => identical run.
//
// Core idea: every run (living-player attempt) is recorded as a per-frame input mask
// array. On death or manual retry, that recording becomes a "ghost" that replays
// exactly, forever, driven only by (its own inputs + static level geometry). Ghosts
// never depend on doors, other ghosts, or the live player, so they are frame-perfect
// reproducible no matter what else is happening on screen. The live player DOES collide
// with ghost bodies (rigid, both axes) and with doors (whose open/closed state depends
// on which ghosts + the player are currently weighing pressure plates).

export const TILE = 16;
export const PW = 10, PH = 14;

const SPEED = 92;
const ACCEL_GROUND = 1000;
const ACCEL_AIR = 560;
const FRICTION = 1100;
const GRAVITY = 700;
const JUMP_V = 246;
const MAX_FALL = 420;
const COYOTE = 6;
const BUFFER = 6;
const CUT = 0.5;

export const M_LEFT = 1, M_RIGHT = 2, M_JUMP = 4;
export const GHOST_CAP = 6;

// ---------------------------------------------------------------- level parsing

// Plate/door ids run 1-6 / a-f so a level can require up to GHOST_CAP (6) ghosts
// simultaneously (one plate+door pair per required ghost).
function plateId(ch) { return (ch >= '1' && ch <= '6') ? ch.charCodeAt(0) - 48 : 0; }
function doorId(ch) { return (ch >= 'a' && ch <= 'f') ? ch.charCodeAt(0) - 96 : 0; }
function isOneway(ch) { return ch === '_' || plateId(ch) > 0; }

export function parseLevel(def) {
  const grid = def.grid;
  const rows = grid.length, cols = grid[0].length;
  let spawn = { x: 1, y: 1 }, goal = { x: cols - 2, y: 1 };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = grid[r][c];
      if (ch === 'S') spawn = { x: c, y: r };
      else if (ch === 'G') goal = { x: c, y: r };
    }
  }
  return { name: def.name, hint: def.hint, par: def.par, grid, rows, cols, spawn, goal };
}

// ---------------------------------------------------------------- geometry helpers

function solidWall(level, c, r) {
  if (c < 0 || c >= level.cols) return true;
  if (r < 0 || r >= level.rows) return false; // void above/below — falling out kills
  return level.grid[r][c] === '#';
}
function spikeAt(level, c, r) {
  if (r < 0 || r >= level.rows || c < 0 || c >= level.cols) return false;
  return level.grid[r][c] === '^';
}
function chAt(level, c, r) {
  if (r < 0 || r >= level.rows || c < 0 || c >= level.cols) return '.';
  return level.grid[r][c];
}

function overlapsRect(x, y, rx, ry, rw, rh) {
  return x < rx + rw && x + PW > rx && y < ry + rh && y + PH > ry;
}

// Weight detection needs to count "resting exactly on top" as an overlap. Discrete
// per-pixel collision stepping can leave a sub-2px gap between a resting box and the
// surface it landed on, so pad the touch test generously rather than testing for
// mathematically exact contact.
function overlapsRectTouch(x, y, rx, ry, rw, rh) {
  const pad = 3;
  return x < rx + rw + pad && x + PW > rx - pad && y < ry + rh + pad && y + PH > ry - pad;
}

function boxSolidX(level, x, y, forGhost, doorOpen) {
  const c0 = Math.floor(x / TILE), c1 = Math.floor((x + PW - 0.001) / TILE);
  const r0 = Math.floor(y / TILE), r1 = Math.floor((y + PH - 0.001) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || c >= level.cols) return true;
      if (r < 0 || r >= level.rows) continue;
      const ch = level.grid[r][c];
      if (ch === '#') return true;
      if (!forGhost) {
        const d = doorId(ch);
        if (d && !doorOpen[d]) return true;
      }
    }
  }
  return false;
}

function boxSolidY(level, x, y, forGhost, doorOpen, prevBottom, vy) {
  const c0 = Math.floor(x / TILE), c1 = Math.floor((x + PW - 0.001) / TILE);
  const r0 = Math.floor(y / TILE), r1 = Math.floor((y + PH - 0.001) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || c >= level.cols) return true;
      if (r < 0 || r >= level.rows) continue;
      const ch = level.grid[r][c];
      if (ch === '#') return true;
      if (!forGhost) {
        const d = doorId(ch);
        if (d && !doorOpen[d]) return true;
      }
      if (isOneway(ch)) {
        const tileTop = r * TILE;
        if (vy > 0 && prevBottom <= tileTop + 0.6) return true;
      }
    }
  }
  return false;
}

function rectsOverlapX(x, y, rects) {
  for (const rc of rects) if (overlapsRect(x, y, rc.x, rc.y, PW, PH)) return true;
  return false;
}

// ---------------------------------------------------------------- one character step

function stepChar(level, ch, mask, dt, forGhost, doorOpen, rects) {
  if (ch.dead || ch.won) return;

  const jump = !!(mask & M_JUMP);
  const jumpPressed = jump && !ch.prevJump;
  ch.prevJump = jump;

  const left = !!(mask & M_LEFT), right = !!(mask & M_RIGHT);
  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  if (dir !== 0) ch.face = dir;

  const accel = ch.onGround ? ACCEL_GROUND : ACCEL_AIR;
  if (dir !== 0) {
    ch.vx += dir * accel * dt;
    ch.vx = Math.max(-SPEED, Math.min(SPEED, ch.vx));
  } else {
    const f = FRICTION * dt;
    ch.vx = Math.abs(ch.vx) <= f ? 0 : ch.vx - Math.sign(ch.vx) * f;
  }

  if (jumpPressed) ch.buffer = BUFFER;
  if (ch.buffer > 0) ch.buffer--;
  if (ch.coyote > 0) ch.coyote--;
  if (ch.buffer > 0 && ch.coyote > 0) {
    ch.vy = -JUMP_V;
    ch.buffer = 0; ch.coyote = 0; ch.onGround = false; ch.jumpHeld = true;
  }
  if (ch.jumpHeld && !jump) {
    if (ch.vy < 0) ch.vy *= CUT;
    ch.jumpHeld = false;
  }

  ch.vy += GRAVITY * dt;
  ch.vy = Math.max(-MAX_FALL, Math.min(MAX_FALL, ch.vy));

  // X
  let nx = ch.x + ch.vx * dt;
  if (boxSolidX(level, nx, ch.y, forGhost, doorOpen) || rectsOverlapX(nx, ch.y, rects)) {
    const step = Math.sign(ch.vx);
    if (step !== 0) {
      while (!boxSolidX(level, ch.x + step, ch.y, forGhost, doorOpen) &&
             !rectsOverlapX(ch.x + step, ch.y, rects) &&
             Math.abs(ch.x + step - nx) > 0.01) ch.x += step;
    }
    ch.vx = 0;
  } else ch.x = nx;

  // Y
  const prevBottom = ch.y + PH;
  let ny = ch.y + ch.vy * dt;
  ch.onGround = false;
  if (boxSolidY(level, ch.x, ny, forGhost, doorOpen, prevBottom, ch.vy) || rectsOverlapX(ch.x, ny, rects)) {
    const step = Math.sign(ch.vy);
    if (step !== 0) {
      while (!boxSolidY(level, ch.x, ch.y + step, forGhost, doorOpen, prevBottom, ch.vy) &&
             !rectsOverlapX(ch.x, ch.y + step, rects) &&
             Math.abs(ch.y + step - ny) > 0.01) ch.y += step;
    }
    if (ch.vy > 0) { ch.onGround = true; ch.coyote = COYOTE; }
    ch.vy = 0;
  } else {
    ch.y = ny;
  }

  // hazards
  const pad = 3;
  const c0 = Math.floor((ch.x + pad) / TILE), c1 = Math.floor((ch.x + PW - pad) / TILE);
  const r0 = Math.floor((ch.y + pad) / TILE), r1 = Math.floor((ch.y + PH - pad) / TILE);
  for (let r = r0; r <= r1 && !ch.dead; r++)
    for (let c = c0; c <= c1 && !ch.dead; c++)
      if (spikeAt(level, c, r)) ch.dead = true;
  if (ch.y > level.rows * TILE + 60 || ch.y < -200) ch.dead = true;
}

function newChar(level) {
  return {
    x: level.spawn.x * TILE + (TILE - PW) / 2,
    y: level.spawn.y * TILE + (TILE - PH) / 2,
    vx: 0, vy: 0, onGround: false, coyote: 0, buffer: 0, jumpHeld: false,
    prevJump: false, dead: false, won: false, face: 1,
  };
}

function settle(level, ch) {
  let guard = 0;
  while (!boxSolidY(level, ch.x, ch.y + 1, false, {}, ch.y + PH, 1) && guard++ < TILE * 6) ch.y += 1;
}

// ---------------------------------------------------------------- sim (multi-run)

export function makeSim(levelIndex, LEVELS) {
  const level = parseLevel(LEVELS[levelIndex]);
  const player = newChar(level);
  settle(level, player);
  return {
    levelIndex, level,
    player,
    runInputs: [],       // current run's recorded per-frame masks
    ghosts: [],          // { inputs, stepIdx, x,y,vx,vy,onGround,coyote,buffer,jumpHeld,prevJump,dead,visible,face }
    frame: 0,
    dead: false,
    won: false,
    runsUsed: 1,          // counts the run in progress
  };
}

function ghostFromRun(level, inputs, diedAtEnd) {
  const ch = newChar(level);
  settle(level, ch);
  return {
    inputs, stepIdx: 0, diedAtEnd,
    x: ch.x, y: ch.y, vx: 0, vy: 0, onGround: ch.onGround, coyote: COYOTE, buffer: 0,
    jumpHeld: false, prevJump: false, dead: false, visible: true, face: 1,
  };
}

function addGhost(sim, diedAtEnd) {
  const g = ghostFromRun(sim.level, sim.runInputs.slice(), diedAtEnd);
  sim.ghosts.push(g);
  if (sim.ghosts.length > GHOST_CAP) sim.ghosts.shift();
}

/** Player died or pressed retry — archive the run as a ghost and respawn. */
export function retryRun(sim, diedAtEnd) {
  if (sim.runInputs.length > 0) addGhost(sim, diedAtEnd);
  sim.player = newChar(sim.level);
  settle(sim.level, sim.player);
  sim.runInputs = [];
  sim.frame = 0;
  sim.dead = false;
  sim.won = false;
  sim.runsUsed++;
}

function plateActive(sim, id) {
  const level = sim.level;
  for (const g of sim.ghosts) {
    if (!g.visible) continue;
    for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
      if (plateId(level.grid[r][c]) === id && overlapsRectTouch(g.x, g.y, c * TILE, r * TILE, TILE, TILE)) return true;
    }
  }
  const p = sim.player;
  for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
    if (plateId(level.grid[r][c]) === id && overlapsRectTouch(p.x, p.y, c * TILE, r * TILE, TILE, TILE)) return true;
  }
  return false;
}

/** One fixed frame. mask = current live input for the player. */
export function stepSim(sim, mask, dt) {
  if (sim.dead || sim.won) return sim;
  const level = sim.level;

  // 1. advance ghosts (pure function of their own recorded inputs + static geometry)
  for (const g of sim.ghosts) {
    if (!g.visible) continue;
    let m = 0;
    if (g.stepIdx < g.inputs.length) { m = g.inputs[g.stepIdx]; g.stepIdx++; }
    else if (g.diedAtEnd) { g.visible = false; continue; }
    stepChar(level, g, m, dt, true, null, []);
    if (g.dead) g.visible = false;
  }

  // 2. door state from plates (ghosts + player's previous position)
  const doorOpen = {};
  for (let id = 1; id <= 6; id++) doorOpen[id] = plateActive(sim, id);

  // 3. advance player, colliding with tiles + closed doors + ghost bodies
  const rects = sim.ghosts.filter((g) => g.visible).map((g) => ({ x: g.x, y: g.y }));
  stepChar(level, sim.player, mask, dt, false, doorOpen, rects);
  sim.runInputs.push(mask);
  sim.frame++;

  // 4. win / lose
  const p = sim.player;
  const gx = level.goal.x * TILE + TILE / 2, gy = level.goal.y * TILE + TILE / 2;
  if (!p.dead && Math.abs(p.x + PW / 2 - gx) < TILE * 0.55 && Math.abs(p.y + PH / 2 - gy) < TILE * 0.7) {
    p.won = true;
    sim.won = true;
  }
  if (p.dead) sim.dead = true;

  return sim;
}

/**
 * Replay a full multi-run solution: an array of runs, each an array of
 * [frames, mask] RLE pairs. A run ends early on death or win; if it ends
 * without either, that's a manual retry (matches pressing R in the live game).
 */
export function replaySolution(levelIndex, LEVELS, runs, dt = 1 / 60) {
  const sim = makeSim(levelIndex, LEVELS);
  for (const run of runs) {
    for (const [frames, mask] of run) {
      for (let f = 0; f < frames; f++) {
        if (sim.dead || sim.won) break;
        stepSim(sim, mask, dt);
      }
      if (sim.dead || sim.won) break;
    }
    if (sim.won) return sim;
    if (sim.dead) { retryRun(sim, true); continue; }
    retryRun(sim, false); // script ended without death/win => manual retry
  }
  return sim;
}
