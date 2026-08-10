// Petri — cellular-automata territory war.
// You never control units directly: you spend biomass to stamp Conway-style patterns onto a
// shared grid and they live, die and fight along their own rules. Same seed + same stamps
// always produces the same match — the sim below never touches Math.random()/Date.now().

import { boot, RNG, Palette, clamp, lerp, text, roundRect, allFinite, registerSelftest } from '../../shared/kit.js';
import { PATTERNS, patternById, rotatePattern, patternBounds, stampPattern } from './patterns.js';

// ---------------------------------------------------------------- constants

const GW = 120, GH = 80;
const CA_STEP = 1 / 11;              // CA ticks per second, independent of render
const DOMINANCE_PCT = 0.70;          // territory share needed to win
const DOMINANCE_HOLD = 4;            // seconds it must be sustained
const MIN_LIVE_FOR_EXTINCTION = 40;  // don't call extinction before the match has really begun
const REGEN_BASE = 2.2;              // biomass/sec baseline
const REGEN_PER_CELL = 0.028;        // biomass/sec per live cell you own

const LEVELS = [
  { name: 'Spore', aiInterval: 3.6, aiPatterns: ['glider', 'block'], aiSkill: 0 },
  { name: 'Colony', aiInterval: 2.8, aiPatterns: ['glider', 'blinker', 'seed'], aiSkill: 1 },
  { name: 'Bloom', aiInterval: 2.2, aiPatterns: ['glider', 'lwss', 'seed'], aiSkill: 2 },
  { name: 'Swarm', aiInterval: 1.7, aiPatterns: ['glider', 'lwss', 'gun', 'seed'], aiSkill: 3 },
  { name: 'Hive', aiInterval: 1.2, aiPatterns: ['glider', 'lwss', 'gun', 'seed', 'blinker'], aiSkill: 4 },
];

// ---------------------------------------------------------------- pure CA step

/** One Conway-ish generation. Majority-of-neighbors decides color; ties on birth cancel to empty. */
function stepCA(grid, next, gw, gh) {
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let n1 = 0, n2 = 0;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < gh - 1 ? y + 1 : gh - 1;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < gw - 1 ? x + 1 : gw - 1;
      for (let ny = y0; ny <= y1; ny++) {
        const row = ny * gw;
        for (let nx = x0; nx <= x1; nx++) {
          if (nx === x && ny === y) continue;
          const v = grid[row + nx];
          if (v === 1) n1++; else if (v === 2) n2++;
        }
      }
      const total = n1 + n2;
      const idx = y * gw + x;
      const c = grid[idx];
      if (c === 0) {
        next[idx] = total === 3 ? (n1 > n2 ? 1 : n2 > n1 ? 2 : 0) : 0;
      } else if (total === 2 || total === 3) {
        next[idx] = n1 === n2 ? c : (n1 > n2 ? 1 : 2);
      } else {
        next[idx] = 0;
      }
    }
  }
}

function countColors(grid) {
  let n1 = 0, n2 = 0;
  for (let i = 0; i < grid.length; i++) { if (grid[i] === 1) n1++; else if (grid[i] === 2) n2++; }
  return { n1, n2 };
}

// ---------------------------------------------------------------- sim (pure state, deterministic)

export function makeSim(seed, levelIndex = 0) {
  const level = LEVELS[clamp(levelIndex, 0, LEVELS.length - 1)];
  const sim = {
    seed, levelIndex, level: level.name,
    rng: new RNG(RNG.hash(String(seed)) ^ (levelIndex * 7919 + 1)),
    gw: GW, gh: GH,
    grid: new Uint8Array(GW * GH),
    next: new Uint8Array(GW * GH),
    caAccum: 0,
    tickCount: 0,
    matchTime: 0,
    biomassP: 40,
    biomassAI: 40,
    n1: 0, n2: 0, total: 0,
    pctP: 0, pctAI: 0,
    domTimerP: 0, domTimerAI: 0,
    aiTimer: level.aiInterval * 0.5,
    aiInterval: level.aiInterval,
    aiPatterns: level.aiPatterns,
    aiSkill: level.aiSkill,
    phase: 'playing', // 'playing' | 'won' | 'lost'
    lastStamp: null,
    lastAiStamp: null,
    shakeEvent: 0, // set >0 for one tick when a big colony dies, visual layer consumes it
  };
  seedColonies(sim);
  const c = countColors(sim.grid);
  sim.n1 = c.n1; sim.n2 = c.n2; sim.total = c.n1 + c.n2;
  updateTerritory(sim);
  return sim;
}

function seedColonies(sim) {
  // Player bottom-left, AI top-right — small starter colonies, mirrored for fairness.
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('glider'), 14, sim.gh - 14, 0, 1);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('block'), 8, sim.gh - 8, 0, 1);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('blinker'), 20, sim.gh - 20, 0, 1);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('glider'), sim.gw - 14, 14, 2, 2);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('block'), sim.gw - 8, 8, 0, 2);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('blinker'), sim.gw - 20, 20, 0, 2);
}

function updateTerritory(sim) {
  const c = countColors(sim.grid);
  sim.n1 = c.n1; sim.n2 = c.n2; sim.total = c.n1 + c.n2;
  sim.pctP = sim.total > 0 ? sim.n1 / sim.total : 0;
  sim.pctAI = sim.total > 0 ? sim.n2 / sim.total : 0;
}

function tryStamp(sim, patternId, x, y, rot, color) {
  const pattern = patternById(patternId);
  const budget = color === 1 ? sim.biomassP : sim.biomassAI;
  if (budget < pattern.cost) return false;
  stampPattern(sim.grid, sim.gw, sim.gh, pattern, x, y, rot, color);
  if (color === 1) { sim.biomassP -= pattern.cost; sim.lastStamp = { patternId, x, y, rot }; }
  else { sim.biomassAI -= pattern.cost; sim.lastAiStamp = { patternId, x, y, rot }; }
  return true;
}

/** Pick an AI stamp target: a contested cell along the front, or fall back to own territory edge. */
function pickAiTarget(sim) {
  const gw = sim.gw, gh = sim.gh, grid = sim.grid;
  const candidates = [];
  // Sample on a coarse stride for speed; look for empty/player cells adjacent to AI cells (the front).
  const stride = sim.aiSkill >= 3 ? 2 : 4;
  for (let y = 1; y < gh - 1; y += stride) {
    for (let x = 1; x < gw - 1; x += stride) {
      const v = grid[y * gw + x];
      if (v === 1) {
        // contested if an AI cell is nearby within radius 6
        candidates.push({ x, y, w: 2 });
      } else if (v === 0) {
        let nearAI = false, nearP = false;
        for (let dy = -2; dy <= 2 && !(nearAI && nearP); dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const nv = grid[ny * gw + nx];
            if (nv === 2) nearAI = true; else if (nv === 1) nearP = true;
          }
        }
        if (nearAI && nearP) candidates.push({ x, y, w: 3 });
      }
    }
  }
  if (candidates.length === 0) {
    // No visible front yet — aim near the player's known cluster (mirrored spawn corner).
    return { x: sim.gw - 1 - sim.rng.intRange(6, 24), y: sim.rng.intRange(6, 24) };
  }
  // Weighted pick biased toward higher-weight (more contested) candidates; higher skill = less random.
  const skillFocus = sim.aiSkill / 4; // 0..1
  if (sim.rng.bool(0.3 + skillFocus * 0.5)) {
    candidates.sort((a, b) => b.w - a.w);
    return candidates[0];
  }
  return sim.rng.pick(candidates);
}

function aiAct(sim, dt) {
  sim.aiTimer -= dt;
  if (sim.aiTimer > 0) return;
  sim.aiTimer = sim.aiInterval * (0.8 + sim.rng.next() * 0.4);
  const t = pickAiTarget(sim);
  const patId = sim.rng.pick(sim.aiPatterns);
  const rot = sim.aiSkill >= 2 ? sim.rng.intRange(0, 3) : 0;
  tryStamp(sim, patId, t.x, t.y, rot, 2);
}

/**
 * Advance the sim by one fixed frame (dt seconds). intent (optional) = {stamp:{patternId,x,y,rot}}
 * stamped for the player. Deterministic: only uses sim.rng and dt, never wall clock.
 */
export function stepSim(sim, intent, dt) {
  if (sim.phase !== 'playing') return sim;
  sim.matchTime += dt;

  if (intent && intent.stamp) {
    const { patternId, x, y, rot } = intent.stamp;
    tryStamp(sim, patternId, x, y, rot || 0, 1);
  }

  aiAct(sim, dt);

  sim.biomassP = Math.min(999, sim.biomassP + (REGEN_BASE + sim.n1 * REGEN_PER_CELL) * dt);
  sim.biomassAI = Math.min(999, sim.biomassAI + (REGEN_BASE + sim.n2 * REGEN_PER_CELL) * dt);

  sim.caAccum += dt;
  let stepped = false;
  while (sim.caAccum >= CA_STEP) {
    const prevN1 = sim.n1, prevN2 = sim.n2;
    stepCA(sim.grid, sim.next, sim.gw, sim.gh);
    const tmp = sim.grid; sim.grid = sim.next; sim.next = tmp;
    sim.tickCount++;
    sim.caAccum -= CA_STEP;
    stepped = true;
    updateTerritory(sim);
    // A colony "dying big" — used by the render layer to trigger screenshake.
    if (prevN1 - sim.n1 > 25 || prevN2 - sim.n2 > 25) sim.shakeEvent = Math.max(sim.shakeEvent, 1);
  }

  if (stepped) {
    const enoughLife = sim.total >= MIN_LIVE_FOR_EXTINCTION;
    if (sim.pctP >= DOMINANCE_PCT && sim.total > 0) sim.domTimerP += CA_STEP; else sim.domTimerP = 0;
    if (sim.pctAI >= DOMINANCE_PCT && sim.total > 0) sim.domTimerAI += CA_STEP; else sim.domTimerAI = 0;

    if (enoughLife && sim.n2 === 0 && sim.n1 > 0) sim.phase = 'won';
    else if (enoughLife && sim.n1 === 0 && sim.n2 > 0) sim.phase = 'lost';
    else if (sim.domTimerP >= DOMINANCE_HOLD) sim.phase = 'won';
    else if (sim.domTimerAI >= DOMINANCE_HOLD) sim.phase = 'lost';
  }

  return sim;
}

// ---------------------------------------------------------------- kit-facing game wrapper

const UI_TOP = 64, UI_BOTTOM = 86;

function boardArea(game) {
  const uiTop = UI_TOP;
  const areaH = Math.max(10, game.h - UI_TOP - UI_BOTTOM);
  return { uiTop, areaH };
}

function pointerToGrid(game) {
  const { uiTop, areaH } = boardArea(game);
  const gx = clamp(Math.floor((game.input.pointer.x / game.w) * GW), 0, GW - 1);
  const gy = clamp(Math.floor(((game.input.pointer.y - uiTop) / areaH) * GH), 0, GH - 1);
  return { gx, gy };
}

function init(game) {
  const level = Number(game.store.get('level', 0)) || 0;
  return {
    sim: makeSim(game.seed, level),
    levelIndex: level,
    selected: 'glider',
    rot: 0,
    introDone: false,
    fade: new Float32Array(GW * GH),
    imgData: null,
    offCanvas: null,
    offCtx: null,
    flashT: 0,
    territoryTone: 0,
    endTimer: 0,
    bestLevel: Number(game.store.get('bestLevel', 0)) || 0,
    fastestWin: game.store.get('fastestWin', null),
  };
}

function selectPatternFromInput(state, game) {
  for (const p of PATTERNS) {
    if (game.input.justPressed(p.key)) { state.selected = p.id; game.sound.blip(500); }
  }
  if (game.input.justPressed('r') || game.input.justPressed('KeyR')) {
    state.rot = (state.rot + 1) % 4;
    game.sound.blip(700);
  }
}

function update(state, dt, game) {
  if (!state.introDone) {
    if (game.input.justPressed('space') || game.input.pointerPressed) state.introDone = true;
    return;
  }

  if (state.sim.phase !== 'playing') {
    state.endTimer += dt;
    if (game.input.justPressed('space') || game.input.justPressed('enter')) {
      const won = state.sim.phase === 'won';
      const nextLevel = won ? Math.min(LEVELS.length - 1, state.levelIndex + 1) : state.levelIndex;
      state.levelIndex = nextLevel;
      if (won) game.store.set('level', nextLevel);
      state.sim = makeSim(game.seed + '#' + game.frame, nextLevel);
      state.endTimer = 0;
      state.fade.fill(0);
    }
    return;
  }

  selectPatternFromInput(state, game);

  let intent = null;
  if (game.input.pointerPressed) {
    const { gx, gy } = pointerToGrid(game);
    const pattern = patternById(state.selected);
    if (state.sim.biomassP >= pattern.cost) {
      intent = { stamp: { patternId: state.selected, x: gx, y: gy, rot: state.rot } };
      game.sound.tone({ freq: 220, dur: 0.05, type: 'square', gain: 0.1 });
    } else {
      game.sound.bad();
    }
  }

  const prevPhase = state.sim.phase;
  const prevPct = state.sim.pctP;
  stepSim(state.sim, intent, dt);

  if (state.sim.shakeEvent) { game.fx.shake(10); state.sim.shakeEvent = 0; }

  // rising tone as territory grows
  if (state.sim.pctP > prevPct + 0.002) {
    state.territoryTone += dt;
    if (state.territoryTone > 0.4) { game.sound.tone({ freq: 300 + state.sim.pctP * 500, dur: 0.08, type: 'sine', gain: 0.05 }); state.territoryTone = 0; }
  }

  if (prevPhase === 'playing' && state.sim.phase !== 'playing') {
    game.fx.shake(16);
    if (state.sim.phase === 'won') {
      game.sound.ok();
      game.store.best('bestLevel', state.levelIndex + 1, true);
      state.bestLevel = Math.max(state.bestLevel, state.levelIndex + 1);
      const isNewBest = game.store.best('fastestWin', Math.round(state.sim.matchTime), false);
      if (isNewBest) state.fastestWin = Math.round(state.sim.matchTime);
    } else {
      game.sound.bad();
    }
  }

  // cell fade toward alive/dead for smooth render
  const grid = state.sim.grid, fade = state.fade;
  for (let i = 0; i < grid.length; i++) {
    const target = grid[i] === 0 ? 0 : 1;
    fade[i] += (target - fade[i]) * Math.min(1, dt * 10);
  }
}

// ---------------------------------------------------------------- render

function ensureOffscreen(state) {
  if (!state.offCanvas) {
    state.offCanvas = document.createElement('canvas');
    state.offCanvas.width = GW; state.offCanvas.height = GH;
    state.offCtx = state.offCanvas.getContext('2d');
    state.imgData = state.offCtx.createImageData(GW, GH);
  }
}

const COL_P = [94, 242, 192];   // accent (mint) — player
const COL_AI = [255, 77, 109];  // hot (red) — AI

function renderGrid(state, ctx, game) {
  ensureOffscreen(state);
  const { grid } = state.sim;
  const data = state.imgData.data;
  const fade = state.fade;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    const a = fade[i];
    let r = 13, g = 16, b = 24; // bg2
    if (v === 1 || (v === 0 && a > 0.02)) {
      // fading-out cells keep the color they had; approximate with last known color via v when alive
    }
    if (v === 1) { r = COL_P[0]; g = COL_P[1]; b = COL_P[2]; }
    else if (v === 2) { r = COL_AI[0]; g = COL_AI[1]; b = COL_AI[2]; }
    const o = i * 4;
    const mix = v === 0 ? a * 0.5 : (0.4 + a * 0.6);
    data[o] = lerp(13, r, mix);
    data[o + 1] = lerp(16, g, mix);
    data[o + 2] = lerp(24, b, mix);
    data[o + 3] = 255;
  }
  state.offCtx.putImageData(state.imgData, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const { uiTop, areaH } = boardArea(game);
  ctx.drawImage(state.offCanvas, 0, 0, GW, GH, 0, uiTop, game.w, areaH);
  ctx.restore();
  return { uiTop, areaH };
}

function renderGhost(state, ctx, game, uiTop, areaH) {
  if (state.sim.phase !== 'playing') return;
  const { gx, gy } = pointerToGrid(game);
  const pattern = patternById(state.selected);
  const cells = rotatePattern(pattern.cells, state.rot);
  const { w, h } = patternBounds(cells);
  const ox = gx - ((w / 2) | 0), oy = gy - ((h / 2) | 0);
  const sx = game.w / GW, sy = areaH / GH;
  const affordable = state.sim.biomassP >= pattern.cost;
  ctx.save();
  ctx.fillStyle = affordable ? 'rgba(94,242,192,0.55)' : 'rgba(255,77,109,0.5)';
  for (const [dx, dy] of cells) {
    const x = ox + dx, y = oy + dy;
    if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
    ctx.fillRect(x * sx, uiTop + y * sy, Math.max(1, sx), Math.max(1, sy));
  }
  ctx.restore();
}

function renderTopbar(state, ctx, game) {
  const w = game.w;
  ctx.save();
  ctx.fillStyle = Palette.panel;
  ctx.fillRect(0, 0, w, 64);
  // territory bar
  const barX = 16, barY = 14, barW = w - 32, barH = 16;
  roundRect(ctx, barX, barY, barW, barH, 6); ctx.fillStyle = Palette.grid; ctx.fill();
  const pW = barW * state.sim.pctP, aW = barW * state.sim.pctAI;
  ctx.fillStyle = `rgb(${COL_P.join(',')})`;
  roundRect(ctx, barX, barY, pW, barH, 6); ctx.fill();
  ctx.fillStyle = `rgb(${COL_AI.join(',')})`;
  ctx.fillRect(barX + barW - aW, barY, aW, barH);
  text(ctx, `YOU ${(state.sim.pctP * 100).toFixed(0)}%`, barX + 4, barY - 2, { size: 11, color: Palette.dim, baseline: 'bottom' });
  text(ctx, `${(state.sim.pctAI * 100).toFixed(0)}% AI`, barX + barW - 4, barY - 2, { size: 11, color: Palette.dim, baseline: 'bottom', align: 'right' });

  text(ctx, `LVL ${state.levelIndex + 1}/${LEVELS.length} · ${state.sim.level}`, barX, barY + barH + 6, { size: 12, color: Palette.ink, weight: 700 });
  text(ctx, `t ${state.sim.matchTime.toFixed(1)}s`, w - barX, barY + barH + 6, { size: 12, color: Palette.dim, align: 'right' });
  ctx.restore();
}

function renderPalette(state, ctx, game) {
  const w = game.w, h = game.h;
  const y0 = h - 86;
  ctx.save();
  ctx.fillStyle = Palette.panel;
  ctx.fillRect(0, y0, w, 86);

  text(ctx, `BIOMASS ${state.sim.biomassP.toFixed(0)}`, 16, y0 + 10, { size: 13, color: Palette.accent, weight: 700 });

  const n = PATTERNS.length;
  const cellW = Math.min(150, (w - 32) / n);
  for (let i = 0; i < n; i++) {
    const p = PATTERNS[i];
    const x = 16 + i * cellW;
    const y = y0 + 30;
    const selected = state.selected === p.id;
    const affordable = state.sim.biomassP >= p.cost;
    roundRect(ctx, x, y, cellW - 8, 48, 8);
    ctx.fillStyle = selected ? 'rgba(94,242,192,0.16)' : 'rgba(255,255,255,0.03)';
    ctx.fill();
    if (selected) { ctx.strokeStyle = Palette.accent; ctx.lineWidth = 1.5; ctx.stroke(); }
    text(ctx, `${p.key}`, x + 8, y + 6, { size: 11, color: Palette.dim, weight: 700 });
    text(ctx, p.name, x + 8, y + 18, { size: 13, color: affordable ? Palette.ink : Palette.dim, weight: 700 });
    text(ctx, `${p.cost}bm`, x + 8, y + 34, { size: 11, color: affordable ? Palette.accent2 : Palette.hot });
  }
  text(ctx, 'R rotate · click to stamp', w - 16, y0 + 10, { size: 11, color: Palette.dim, align: 'right' });
  ctx.restore();
}

function renderIntro(state, ctx, game) {
  const w = game.w, h = game.h;
  ctx.save();
  ctx.fillStyle = 'rgba(7,8,13,0.92)';
  ctx.fillRect(0, 0, w, h);
  text(ctx, 'PETRI', w / 2, h * 0.28, { size: 48, color: Palette.ink, align: 'center', weight: 800, font: 'Georgia, "Times New Roman", serif' });
  text(ctx, 'You place seeds. The seeds live on their own — spread, fight, and take the grid.', w / 2, h * 0.28 + 46, { size: 15, color: Palette.dim, align: 'center' });
  text(ctx, 'Stamp Conway patterns with 1–6, rotate with R, click to place. Control 70% of the grid to win.', w / 2, h * 0.28 + 70, { size: 13, color: Palette.dim, align: 'center' });
  text(ctx, 'PRESS SPACE', w / 2, h * 0.6, { size: 20, color: Palette.accent, align: 'center', weight: 700 });
  ctx.restore();
}

function renderEnd(state, ctx, game) {
  const w = game.w, h = game.h;
  const won = state.sim.phase === 'won';
  ctx.save();
  ctx.fillStyle = 'rgba(7,8,13,0.85)';
  ctx.fillRect(0, 0, w, h);
  text(ctx, won ? 'TERRITORY SECURED' : 'COLONY LOST', w / 2, h * 0.42, {
    size: 36, align: 'center', weight: 800, color: won ? Palette.accent : Palette.hot,
    font: 'Georgia, "Times New Roman", serif',
  });
  text(ctx, won ? `${state.sim.level} cleared in ${state.sim.matchTime.toFixed(1)}s` : `${state.sim.level} — the AI colony took the grid`, w / 2, h * 0.42 + 40, { size: 15, align: 'center', color: Palette.dim });
  text(ctx, `best level ${state.bestLevel}/${LEVELS.length}` + (state.fastestWin ? ` · fastest win ${state.fastestWin}s` : ''), w / 2, h * 0.42 + 64, { size: 12, align: 'center', color: Palette.dim });
  text(ctx, won && state.levelIndex < LEVELS.length - 1 ? 'PRESS SPACE FOR NEXT COLONY' : 'PRESS SPACE TO RETRY', w / 2, h * 0.6, { size: 16, align: 'center', color: Palette.ink, weight: 700 });
  ctx.restore();
}

function render(state, ctx, game) {
  if (!state.introDone) { renderIntro(state, ctx, game); return; }
  const { uiTop, areaH } = renderGrid(state, ctx, game);
  renderGhost(state, ctx, game, uiTop, areaH);
  renderTopbar(state, ctx, game);
  renderPalette(state, ctx, game);
  if (state.sim.phase !== 'playing') renderEnd(state, ctx, game);
}

// ---------------------------------------------------------------- boot

const game = boot({
  id: 'petri',
  title: 'Petri',
  seed: 'petri-' + Math.floor(Math.random() * 1e9),
  init, update, render,
});

globalThis.__petri = { makeSim, stepSim, stepCA, countColors, PATTERNS, patternById, rotatePattern, stampPattern, LEVELS };

// ---------------------------------------------------------------- self-test

registerSelftest('petri', (check, log) => {
  // 8. CA correctness on a clean single-color board.
  {
    const gw = 10, gh = 10;
    const grid = new Uint8Array(gw * gh);
    const next = new Uint8Array(gw * gh);
    // block at (2,2)-(3,3)
    grid[2 * gw + 2] = 1; grid[2 * gw + 3] = 1; grid[3 * gw + 2] = 1; grid[3 * gw + 3] = 1;
    // blinker (vertical) at x=6, y=2..4
    grid[2 * gw + 6] = 1; grid[3 * gw + 6] = 1; grid[4 * gw + 6] = 1;
    const before = grid.slice();
    stepCA(grid, next, gw, gh);
    let g1 = next;
    const blockStable = g1[2 * gw + 2] === 1 && g1[2 * gw + 3] === 1 && g1[3 * gw + 2] === 1 && g1[3 * gw + 3] === 1;
    check('block is a still life after 1 gen', blockStable, JSON.stringify([...g1.slice(0, 40)]));
    const blinkerFlippedHoriz = g1[3 * gw + 5] === 1 && g1[3 * gw + 6] === 1 && g1[3 * gw + 7] === 1;
    check('blinker flips to horizontal after 1 gen', blinkerFlippedHoriz);
    const next2 = new Uint8Array(gw * gh);
    stepCA(g1, next2, gw, gh);
    const blinkerBackToVert = next2[2 * gw + 6] === 1 && next2[3 * gw + 6] === 1 && next2[4 * gw + 6] === 1;
    check('blinker returns to vertical after 2 gens (period 2)', blinkerBackToVert);

    // glider: after 4 generations, returns to original shape translated by (1,1)
    const gg = new Uint8Array(gw * gh);
    let gn = new Uint8Array(gw * gh);
    const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
    for (const [dx, dy] of glider) gg[(1 + dy) * gw + (1 + dx)] = 1;
    let cur = gg;
    for (let i = 0; i < 4; i++) {
      stepCA(cur, gn, gw, gh);
      const t = cur; cur = gn; gn = t;
    }
    let match = true;
    for (const [dx, dy] of glider) if (cur[(2 + dy) * gw + (2 + dx)] !== 1) match = false;
    let liveCount = 0;
    for (let i = 0; i < cur.length; i++) if (cur[i] === 1) liveCount++;
    check('glider returns to its shape translated by (1,1) after 4 gens', match && liveCount === 5, 'live=' + liveCount);
  }

  // 1. world initializes
  const sim = makeSim('selftest-seed', 0);
  check('world initializes: grid allocated', sim.grid.length === GW * GH);
  check('world initializes: both colonies seeded', sim.n1 > 0 && sim.n2 > 0, `n1=${sim.n1} n2=${sim.n2}`);
  check('world initializes: biomass starts correct', sim.biomassP === 40 && sim.biomassAI === 40);

  // 3. progress events: territory percentages update as the CA runs
  {
    const s = makeSim('progress-seed', 0);
    const p0 = s.pctP;
    for (let i = 0; i < 200; i++) stepSim(s, null, 1 / 60);
    check('territory percentages update over time', s.tickCount > 0 && (s.pctP !== p0 || s.pctAI !== 0));
  }

  // 4/5. win and lose are both reachable via scripted sims
  {
    const s = makeSim('win-seed', 0);
    // wipe AI cells, heavily seed player so it dominates & AI never respawns (no biomass either).
    for (let i = 0; i < s.grid.length; i++) if (s.grid[i] === 2) s.grid[i] = 0;
    s.biomassAI = 0; s.aiInterval = 999999; s.aiTimer = 999999;
    for (let y = 4; y < GH - 4; y += 3) {
      for (let x = 4; x < GW - 4; x += 3) {
        stampPattern(s.grid, s.gw, s.gh, patternById('block'), x, y, 0, 1);
      }
    }
    let steps = 0;
    while (s.phase === 'playing' && steps < 2000) { stepSim(s, null, 1 / 20); steps++; }
    check('WIN is reachable from a scripted dominant-player sim', s.phase === 'won', `phase=${s.phase} pctP=${s.pctP.toFixed(2)} steps=${steps}`);
  }
  {
    const s = makeSim('lose-seed', 0);
    for (let i = 0; i < s.grid.length; i++) if (s.grid[i] === 1) s.grid[i] = 0;
    s.biomassP = 0;
    for (let y = 4; y < GH - 4; y += 3) {
      for (let x = 4; x < GW - 4; x += 3) {
        stampPattern(s.grid, s.gw, s.gh, patternById('block'), x, y, 0, 2);
      }
    }
    let steps = 0;
    while (s.phase === 'playing' && steps < 2000) { stepSim(s, null, 1 / 20); steps++; }
    check('LOSE is reachable from a scripted dominant-AI sim', s.phase === 'lost', `phase=${s.phase} pctAI=${s.pctAI.toFixed(2)} steps=${steps}`);
  }

  // 6. finite state + legal cell enum over >=600 frames
  {
    const s = makeSim('finite-seed', 1);
    for (let i = 0; i < 620; i++) stepSim(s, null, 1 / 60);
    const fin = allFinite({ biomassP: s.biomassP, biomassAI: s.biomassAI, pctP: s.pctP, pctAI: s.pctAI, matchTime: s.matchTime });
    check('allFinite after >=600 frames', fin.ok, JSON.stringify(fin.bad));
    let legal = true;
    for (let i = 0; i < s.grid.length; i++) if (s.grid[i] !== 0 && s.grid[i] !== 1 && s.grid[i] !== 2) legal = false;
    check('grid contains only legal cell values (0/1/2)', legal);
  }

  // 2 + live game drive: injected pointer click stamps the selected pattern
  {
    const g = boot({
      id: 'petri-selftest', title: 'Petri (selftest)', seed: 'live-seed',
      init, update, render, autoStart: false,
    });
    g.state.introDone = true;
    const before = g.state.sim.n1;
    g.state.selected = 'glider';
    const patternCells = patternById('glider').cells.length;
    g.input.pointTo(g.w * 0.5, g.h * 0.5);
    g.input.pointDown(g.w * 0.5, g.h * 0.5);
    g.step(1);
    g.input.pointUp(g.w * 0.5, g.h * 0.5);
    const after = g.state.sim.n1;
    check('injected pointer click stamps the selected pattern', after - before === patternCells, `before=${before} after=${after} expected+${patternCells}`);

    // run the live game forward a bit to make sure nothing throws through the render/update path
    for (let i = 0; i < 120; i++) g.step(1);
    const fin2 = allFinite({ biomass: g.state.sim.biomassP, pct: g.state.sim.pctP });
    check('live game runs 120+ frames without producing non-finite state', fin2.ok, JSON.stringify(fin2.bad));
  }

  log('petri self-test complete');
});
