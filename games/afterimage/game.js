// Afterimage — every death or retry records your run as a ghost; the ghost replays
// forever, solid to you (stand on its head) but see-through to other ghosts. Levels are
// built so you cannot reach the goal alone — a ghost must hold a pressure plate open,
// or stand still so you can climb it.
//
// Architecture: sim.js holds the pure, cloneable simulation (makeSim/stepSim), driven
// by per-frame input masks only — no Math.random(), no Date.now(). The live game and
// the self-test call the exact same stepSim, so physics can never drift apart.

import {
  boot, registerSelftest, Palette, FX, Sound, Store,
  clamp, text, roundRect, allFinite,
} from '../../shared/kit.js';
import { LEVELS } from './levels.js';
import {
  makeSim, stepSim, retryRun, replaySolution,
  TILE, PW, PH, M_LEFT, M_RIGHT, M_JUMP, GHOST_CAP,
} from './sim.js';

const MAX_LEVEL_KEY = 'maxLevel';

// ---------------------------------------------------------------- game state

function init(g) {
  const startLevel = clamp(Store.get(MAX_LEVEL_KEY, 0), 0, LEVELS.length - 1);
  return {
    levelIndex: startLevel,
    sim: makeSim(startLevel, LEVELS),
    phase: 'intro',        // intro | play | dying | cleared | complete
    timer: 0,
    flash: 0,
    hintT: 0,
    totalDeaths: Store.get('deaths', 0),
    runDeaths: 0,
  };
}

function loadLevel(s, idx) {
  s.levelIndex = clamp(idx, 0, LEVELS.length - 1);
  s.sim = makeSim(s.levelIndex, LEVELS);
  s.hintT = 3.0;
}

function currentMask(g) {
  const I = g.input;
  let m = 0;
  if (I.isDown('left') || I.isDown('a')) m |= M_LEFT;
  if (I.isDown('right') || I.isDown('d')) m |= M_RIGHT;
  if (I.isDown('space') || I.isDown('up') || I.isDown('w')) m |= M_JUMP;
  return m;
}

function pushTrail(sim) {
  for (const g of sim.ghosts) {
    if (!g.trail) g.trail = [];
    if (g.visible) {
      g.trail.push({ x: g.x, y: g.y });
      if (g.trail.length > 7) g.trail.shift();
    }
  }
}

function update(s, dt, g) {
  s.flash = Math.max(0, s.flash - dt * 3);
  if (s.hintT > 0) s.hintT -= dt;

  if (s.phase === 'intro') {
    if (g.input.justPressed('space') || g.input.justPressed('enter') || g.input.pointerPressed) {
      s.phase = 'play';
      s.hintT = 3.0;
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
      } else {
        Store.set(MAX_LEVEL_KEY, Math.max(Store.get(MAX_LEVEL_KEY, 0), next));
        loadLevel(s, next);
        s.phase = 'play';
      }
    }
    return;
  }

  // --- playing
  if (g.input.justPressed('r')) {
    s.runDeaths++;
    s.totalDeaths++;
    Store.set('deaths', s.totalDeaths);
    retryRun(s.sim, false);
    Sound.blip(420);
    FX.burst(s.sim.player.x + PW / 2, s.sim.player.y + PH / 2, { count: 10, color: Palette.violet, speed: 70, life: 0.4, size: 2.5 });
    return;
  }

  stepSim(s.sim, currentMask(g), dt);
  pushTrail(s.sim);

  if (s.sim.dead) {
    s.runDeaths++;
    s.totalDeaths++;
    Store.set('deaths', s.totalDeaths);
    s.phase = 'dying'; s.timer = 0.34; s.flash = 1;
    FX.shake(9);
    Sound.bad();
    const p = s.sim.player;
    FX.burst(p.x + PW / 2, p.y + PH / 2, { count: 22, color: Palette.hot, speed: 150, life: 0.45, size: 3, gravity: 300 });
  } else if (s.sim.won) {
    s.phase = 'cleared'; s.timer = 0.6;
    const par = LEVELS[s.levelIndex].par;
    const used = s.sim.runsUsed;
    const improved = Store.best('best' + s.levelIndex, used, false);
    const p = s.sim.player;
    FX.burst(p.x + PW / 2, p.y + PH / 2, { count: 26, color: Palette.accent, speed: 110, life: 0.55, size: 3 });
    FX.shake(5);
    Sound.ok();
    s.lastUsed = used;
    s.lastPar = par;
    s.lastImproved = improved;
  }
}

// ---------------------------------------------------------------- render

function levelRect(g, level) {
  const pad = 12;
  const availW = g.w - pad * 2;
  const availH = g.h - 60;
  const scale = Math.min(availW / (level.cols * TILE), availH / (level.rows * TILE));
  const w = level.cols * TILE * scale, h = level.rows * TILE * scale;
  return { x: (g.w - w) / 2, y: 40 + (availH - h) / 2, scale };
}

function drawChar(ctx, x, y, alpha, color, glow, faceEye) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  roundRect(ctx, x, y, PW, PH, 2.5);
  ctx.fill();
  ctx.shadowBlur = 0;
  if (faceEye) {
    ctx.fillStyle = Palette.bg;
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillRect(x + PW / 2 - 1, y + 3, 2, 2);
  }
  ctx.globalAlpha = 1;
}

function render(s, ctx, g) {
  const level = s.sim.level;
  const rect = levelRect(g, level);

  ctx.fillStyle = Palette.bg;
  ctx.fillRect(0, 0, g.w, g.h);

  ctx.save();
  ctx.translate(rect.x, rect.y);
  ctx.scale(rect.scale, rect.scale);

  const W = level.cols * TILE, H = level.rows * TILE;
  ctx.fillStyle = Palette.bg2;
  ctx.fillRect(0, 0, W, H);

  // door state (recompute for render, mirrors sim's plate logic loosely — visual only)
  const doorOpen = {};
  for (let id = 1; id <= 4; id++) {
    doorOpen[id] = false;
    for (const gh of s.sim.ghosts) {
      if (!gh.visible) continue;
      for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
        const ch = level.grid[r][c];
        if (ch >= '1' && ch <= '4' && ch.charCodeAt(0) - 48 === id) {
          if (gh.x < c * TILE + TILE + 3 && gh.x + PW > c * TILE - 3 && gh.y < r * TILE + TILE + 3 && gh.y + PH > r * TILE - 3) doorOpen[id] = true;
        }
      }
    }
    const p = s.sim.player;
    for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
      const ch = level.grid[r][c];
      if (ch >= '1' && ch <= '4' && ch.charCodeAt(0) - 48 === id) {
        if (p.x < c * TILE + TILE + 3 && p.x + PW > c * TILE - 3 && p.y < r * TILE + TILE + 3 && p.y + PH > r * TILE - 3) doorOpen[id] = true;
      }
    }
  }

  for (let r = 0; r < level.rows; r++) {
    for (let c = 0; c < level.cols; c++) {
      const ch = level.grid[r][c];
      const bx = c * TILE, by = r * TILE;
      if (ch === '#') {
        ctx.fillStyle = '#1c2436';
        ctx.fillRect(bx, by, TILE, TILE);
        ctx.fillStyle = '#28324a';
        if (r === 0 || level.grid[r - 1][c] !== '#') ctx.fillRect(bx, by, TILE, 2);
      } else if (ch === '^') {
        ctx.fillStyle = Palette.hot;
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          ctx.moveTo(bx + k * 4, by + TILE);
          ctx.lineTo(bx + k * 4 + 2, by + TILE - 7);
          ctx.lineTo(bx + k * 4 + 4, by + TILE);
        }
        ctx.fill();
      } else if (ch === '_') {
        ctx.fillStyle = '#3a4666';
        ctx.fillRect(bx, by + TILE - 4, TILE, 4);
      } else if (ch >= '1' && ch <= '4') {
        const id = ch.charCodeAt(0) - 48;
        const active = doorOpen[id];
        ctx.fillStyle = active ? Palette.accent : '#4a5578';
        ctx.fillRect(bx + 1, by + TILE - 5, TILE - 2, 5);
        ctx.globalAlpha = active ? 0.35 : 0.15;
        ctx.fillRect(bx + 1, by + TILE - 5, TILE - 2, 5);
        ctx.globalAlpha = 1;
        text(ctx, String(id), bx + TILE / 2, by + TILE - 3, { size: 7, color: Palette.bg, align: 'center', baseline: 'bottom', weight: 700 });
      } else if (ch >= 'a' && ch <= 'd') {
        const id = ch.charCodeAt(0) - 96;
        const open = doorOpen[id];
        if (!open) {
          ctx.fillStyle = Palette.warm;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(bx, by, TILE, TILE);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = Palette.warm;
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bx + 1.5, by + 1.5, TILE - 3, TILE - 3);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // goal
  const gx = level.goal.x * TILE, gy = level.goal.y * TILE;
  const pulse = 0.55 + 0.45 * Math.sin(s.timerT * 3);
  ctx.globalAlpha = s.sim.won ? 1 : pulse;
  ctx.strokeStyle = Palette.accent;
  ctx.lineWidth = 2;
  roundRect(ctx, gx + 2.5, gy + 2.5, TILE - 5, TILE - 5, 3);
  ctx.stroke();
  ctx.globalAlpha = 0.16 * (s.sim.won ? 1.6 : pulse);
  ctx.fillStyle = Palette.accent;
  ctx.fill();
  ctx.globalAlpha = 1;

  // ghosts (older = fainter), with a short trailing afterimage
  const n = s.sim.ghosts.length;
  for (let i = 0; i < n; i++) {
    const gh = s.sim.ghosts[i];
    if (!gh.visible) continue;
    const age = n - i; // 1 = newest
    const baseAlpha = clamp(0.55 - (age - 1) * 0.08, 0.14, 0.55);
    if (gh.trail) {
      for (let t = 0; t < gh.trail.length; t++) {
        const tp = gh.trail[t];
        const ta = baseAlpha * (t / gh.trail.length) * 0.35;
        drawChar(ctx, tp.x, tp.y, ta, Palette.violet, 0, false);
      }
    }
    drawChar(ctx, gh.x, gh.y, baseAlpha, Palette.violet, 6, false);
  }

  // player
  if (!s.sim.player.dead) {
    drawChar(ctx, s.sim.player.x, s.sim.player.y, 1, s.sim.won ? Palette.accent : Palette.warm, s.sim.won ? 14 : 8, true);
  }

  ctx.restore();

  FX.draw(ctx);

  // HUD
  const level_ = LEVELS[s.levelIndex];
  text(ctx, `${String(s.levelIndex + 1).padStart(2, '0')}/${String(LEVELS.length).padStart(2, '0')}  ${level_.name.toUpperCase()}`,
    12, 12, { size: 12, color: Palette.ink, weight: 700 });
  const best = Store.get('best' + s.levelIndex, null);
  text(ctx, `GHOST PAR ${level_.par}${best ? '  ·  BEST ' + best : ''}`, 12, 28, { size: 10, color: Palette.dim });
  text(ctx, `GHOSTS ${s.sim.ghosts.length}/${GHOST_CAP}`, g.w - 12, 12, { size: 11, color: Palette.dim, align: 'right' });
  text(ctx, `RUN ${s.sim.runsUsed}`, g.w - 12, 27, { size: 11, color: Palette.dim, align: 'right' });

  if (s.hintT > 0 && s.phase === 'play') {
    const a = clamp(s.hintT / 0.6, 0, 1);
    text(ctx, level_.hint, g.w / 2, g.h - 14, { size: 11, color: Palette.dim, align: 'center', alpha: a });
  }

  if (s.flash > 0) {
    ctx.globalAlpha = s.flash * 0.28;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalAlpha = 1;
  }

  if (s.phase === 'cleared' && s.lastUsed) {
    ctx.globalAlpha = clamp(s.timer / 0.6, 0, 1);
    text(ctx, `CLEARED IN ${s.lastUsed} RUN${s.lastUsed === 1 ? '' : 'S'}${s.lastImproved ? '  ·  NEW BEST' : ''}`,
      g.w / 2, g.h / 2, { size: 15, color: Palette.accent, align: 'center', weight: 700 });
    ctx.globalAlpha = 1;
  }

  if (s.phase === 'intro') {
    const narrow = g.w < 520;
    const k = narrow ? g.w / 520 : 1;
    ctx.fillStyle = 'rgba(7,8,13,0.88)';
    ctx.fillRect(0, 0, g.w, g.h);
    text(ctx, 'AFTERIMAGE', g.w / 2, g.h / 2 - 62, { size: 30 * Math.max(k, 0.62), color: Palette.accent, align: 'center', weight: 700 });
    text(ctx, 'Death or retry records your run as a ghost.', g.w / 2, g.h / 2 - 22, { size: 13 * Math.max(k, 0.72), color: Palette.ink, align: 'center' });
    text(ctx, 'Park a ghost on a plate to hold a door open.', g.w / 2, g.h / 2 - 2, { size: 12 * Math.max(k, 0.72), color: Palette.dim, align: 'center' });
    text(ctx, 'Climb a ghost\'s head to reach higher ledges.', g.w / 2, g.h / 2 + 18, { size: 12 * Math.max(k, 0.72), color: Palette.dim, align: 'center' });
    text(ctx, '←/→ jump SPACE  ·  R retries', g.w / 2, g.h / 2 + 46, { size: 12 * Math.max(k, 0.72), color: Palette.dim, align: 'center' });
    const p = 0.5 + 0.5 * Math.sin(g.t * 3);
    text(ctx, 'PRESS SPACE', g.w / 2, g.h / 2 + 78, { size: 13 * Math.max(k, 0.72), color: Palette.warm, align: 'center', weight: 700, alpha: 0.4 + p * 0.6 });
  }

  if (s.phase === 'complete') {
    ctx.fillStyle = 'rgba(7,8,13,0.9)';
    ctx.fillRect(0, 0, g.w, g.h);
    text(ctx, 'ALL LEVELS CLEARED', g.w / 2, g.h / 2 - 26, { size: 24, color: Palette.accent, align: 'center', weight: 700 });
    text(ctx, `${s.runDeaths} retries this run.`, g.w / 2, g.h / 2 + 4, { size: 13, color: Palette.ink, align: 'center' });
    text(ctx, 'ENTER to run it back', g.w / 2, g.h / 2 + 30, { size: 12, color: Palette.dim, align: 'center' });
  }

  s.timerT = g.t;
}

// wrap render to stamp g.t onto state before first call (kit calls render(state,...))
const _render = render;
function renderWrap(s, ctx, g) { s.timerT = g.t; _render(s, ctx, g); }

// ---------------------------------------------------------------- boot + self-test

const game = boot({ id: 'afterimage', title: 'Afterimage', seed: 1, init, update, render: renderWrap });

registerSelftest('afterimage', (check, log) => {
  const dt = 1 / 60;

  // 1. world initializes
  const s0 = makeSim(0, LEVELS);
  check('level 0 initializes with a player and empty ghost list', !!s0.player && s0.ghosts.length === 0,
    `ghosts=${s0.ghosts.length}`);
  check('every level parses with a spawn and goal', LEVELS.every((_, i) => {
    const s = makeSim(i, LEVELS);
    return s.level.spawn && s.level.goal && s.player.x > 0;
  }), `${LEVELS.length} levels`);

  // 2. input actually moves the player — assert a real state delta
  const s1 = makeSim(0, LEVELS);
  const x0 = s1.player.x;
  for (let i = 0; i < 30; i++) stepSim(s1, M_RIGHT, dt);
  check('RIGHT moves the player right', s1.player.x > x0 + 4, `dx=${(s1.player.x - x0).toFixed(1)}`);
  const y0 = s1.player.y;
  for (let i = 0; i < 12; i++) stepSim(s1, M_JUMP, dt);
  check('JUMP raises the player', s1.player.y < y0 + 40 && s1.player.y < 60, `y=${s1.player.y.toFixed(1)}`);

  // 3. progress event: retrying archives the run as a visible ghost
  const s2 = makeSim(0, LEVELS);
  for (let i = 0; i < 20; i++) stepSim(s2, M_RIGHT, dt);
  check('ghost list empty before any retry', s2.ghosts.length === 0);
  retryRun(s2, false);
  check('retry archives a ghost and respawns the player', s2.ghosts.length === 1 && s2.player.x < 30,
    `ghosts=${s2.ghosts.length} playerX=${s2.player.x.toFixed(1)}`);
  check('ghost cap recycles the oldest', (() => {
    const s = makeSim(0, LEVELS);
    for (let n = 0; n < GHOST_CAP + 3; n++) {
      for (let i = 0; i < 5; i++) stepSim(s, M_RIGHT, dt);
      retryRun(s, false);
    }
    return s.ghosts.length === GHOST_CAP;
  })(), `cap=${GHOST_CAP}`);

  // 4. WIN reachable — replay every level's hand-verified solution
  let solvedCount = 0;
  const unsolved = [];
  for (let i = 0; i < LEVELS.length; i++) {
    const sol = LEVELS[i].solution;
    if (!sol) { unsolved.push(`${i}:no-solution`); continue; }
    const s = replaySolution(i, LEVELS, sol);
    if (s.won) solvedCount++; else unsolved.push(`${i}:${s.dead ? 'died' : 'timeout'}`);
  }
  check('every level has a verified winning multi-run script', solvedCount === LEVELS.length,
    `${solvedCount}/${LEVELS.length}${unsolved.length ? ' · failed: ' + unsolved.join(',') : ''}`);

  // 5. LOSE reachable — a spike directly in the walking path kills on contact
  const spikeFixture = [{
    name: 'fixture', hint: '', par: 1,
    grid: ['######', '#....#', '#S^..#', '######'],
  }];
  const s3 = makeSim(0, spikeFixture);
  for (let i = 0; i < 60 && !s3.dead && !s3.won; i++) stepSim(s3, M_RIGHT, dt);
  check('lose condition reachable (spikes kill)', s3.dead === true, `dead=${s3.dead} won=${s3.won}`);

  // 6. no NaN/Infinity after >=600 varied frames, including repeated retries
  const s4 = makeSim(LEVELS.length - 1, LEVELS);
  let mask = 0;
  for (let i = 0; i < 900; i++) {
    if (i % 11 === 0) mask = [0, M_LEFT, M_RIGHT, M_JUMP, M_LEFT | M_JUMP, M_RIGHT | M_JUMP][Math.floor(i / 11) % 6];
    stepSim(s4, mask, dt);
    if (s4.dead || s4.won) retryRun(s4, s4.dead);
  }
  const fin = allFinite({ player: s4.player, ghosts: s4.ghosts.map((g) => ({ x: g.x, y: g.y, vx: g.vx, vy: g.vy })) });
  check('no NaN/Infinity after 900 simulated frames', fin.ok, fin.bad.slice(0, 3).join(','));

  // 7. nothing throws while stepping every level's spawn once
  let threw = null;
  try {
    for (let i = 0; i < LEVELS.length; i++) {
      const s = makeSim(i, LEVELS);
      for (let f = 0; f < 30; f++) stepSim(s, M_RIGHT, dt);
    }
  } catch (e) { threw = e; }
  check('stepping every level does not throw', !threw, threw ? String(threw) : '');

  // 8. the live game responds to real injected input through the kit
  game.restart();
  game.state.phase = 'play';
  const live0 = game.state.sim.player.x;
  game.input.press('right');
  game.step(30);
  game.input.release('right');
  check('live game responds to kit input', game.state.sim.player.x > live0 + 4,
    `dx=${(game.state.sim.player.x - live0).toFixed(1)}`);
  check('live state stays finite', allFinite({ player: game.state.sim.player }).ok);

  game.restart();
  log(`levels=${LEVELS.length} solved=${solvedCount}`);
});

// expose for the dev console / verification tooling
globalThis.__afterimage = { makeSim, stepSim, retryRun, replaySolution, LEVELS, M_LEFT, M_RIGHT, M_JUMP, GHOST_CAP };

export default game;
