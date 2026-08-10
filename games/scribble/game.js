// Scribble — draw it into existence.
//
// You get a ball, a goal, and a pen. Everything you draw becomes a real verlet body:
// ramps, bridges, see-saws, pendulums, catapults. Ink is limited, so the puzzle is not
// "can you do it" but "how little handwriting does it take".
//
// Structure (same contract as the other Gamesx10 games):
//   physics.js  — PURE, DOM-free simulation. makeSim(level) + stepSim(sim, intent, dt).
//   levels.js   — plain data + a VERIFIED stroke script per level.
//   game.js     — input, rendering, juice, and the self-test that replays every script.
//
// The live game and window.__selftest() drive the identical stepSim, so anything the
// test proves is true of the game you actually play.

import {
  boot, registerSelftest, Palette, FX, Sound, Store,
  clamp, text, roundRect, allFinite, TAU,
  Type, HUD_H, hudStrip, stat, panel, meter, orb, vignette, titleCard,
  T, mountLangToggle,
} from '../../shared/kit.js';
import { LEVELS } from './levels.js';
import {
  WORLD_W, WORLD_H, makeSim, stepSim, prepareStroke, replaySolution,
  countParticles, countConstraints, totalKE, maxAbsCoord, maxSpeed,
  INK_R, BALL_R, WALL_R, SPIKE_R, PIN_COST, MAX_PARTICLES,
  TOOL_INK, TOOL_STATIC, TOOL_PIN, TOOL_ERASE, TOOLS,
} from './physics.js';

// ---------------------------------------------------------------- layout

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const TOOL_META = {
  [TOOL_INK]: { key: '1', labelEn: 'INK', labelZh: '墨水', color: Palette.warm, blurbEn: 'falls', blurbZh: '会掉落' },
  [TOOL_STATIC]: { key: '2', labelEn: 'STATIC', labelZh: '固定', color: Palette.accent2, blurbEn: 'pinned to world', blurbZh: '固定于世界' },
  [TOOL_PIN]: { key: '3', labelEn: 'PIN', labelZh: '钉子', color: Palette.violet, blurbEn: 'nail a point', blurbZh: '钉住一点' },
  [TOOL_ERASE]: { key: '4', labelEn: 'ERASE', labelZh: '擦除', color: Palette.hot, blurbEn: 'remove + refund', blurbZh: '移除并退还' },
};

/**
 * Chrome sizing. The HUD strip, the tool dock and the world viewport all derive from
 * one place, so the layout stays coherent from a 700x500 window up to a full desktop.
 * Below ~560px tall (or ~620px wide) everything switches to a compact variant rather
 * than eating the playfield.
 */
function metrics(g) {
  const compact = g.h < 560 || g.w < 620;
  const hudH = compact ? 44 : HUD_H;
  const chipH = compact ? 30 : 40;
  const dockH = chipH + (compact ? 14 : 20);
  return {
    compact, hudH, chipH, dockH,
    padX: compact ? 10 : 14,
    top: hudH + (compact ? 6 : 10),
    bot: dockH + (compact ? 6 : 10),
  };
}

function getView(g) {
  const m = metrics(g);
  const availH = Math.max(120, g.h - m.top - m.bot);
  const availW = Math.max(120, g.w - 16);
  const scale = Math.max(0.05, Math.min(availW / WORLD_W, availH / WORLD_H));
  return {
    scale,
    ox: (g.w - WORLD_W * scale) / 2,
    oy: m.top + (availH - WORLD_H * scale) / 2,
  };
}

const toWorld = (g, x, y) => { const v = getView(g); return { x: (x - v.ox) / v.scale, y: (y - v.oy) / v.scale }; };
const toScreen = (g, x, y) => { const v = getView(g); return { x: v.ox + x * v.scale, y: v.oy + y * v.scale }; };

function paletteRects(g) {
  const m = metrics(g);
  const n = TOOLS.length;
  const gap = m.compact ? 7 : 10;
  const w = Math.min(m.compact ? 132 : 170, Math.max(56, (g.w - 24 - gap * (n - 1)) / n));
  const h = m.chipH;
  const totalW = w * n + gap * (n - 1);
  const x0 = (g.w - totalW) / 2;
  const y = g.h - m.dockH + (m.dockH - h) / 2;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: x0 + i * (w + gap), y, w, h, tool: TOOLS[i] });
  return out;
}

function hitPalette(g, x, y) {
  const rs = paletteRects(g);
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y - 6 && y <= r.y + r.h + 6) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- game state

function newState(g, levelIndex) {
  return {
    levelIndex,
    sim: makeSim(levelIndex),
    tool: TOOL_STATIC,
    drawing: false,
    raw: [],
    phase: 'intro',        // intro | play
    hintT: 3.4,
    msg: '',
    msgT: 0,
    flash: 0,
    deadT: 0,
    winT: 0,
    wonHandled: false,
    newBest: false,
    best: Store.get('best:' + levelIndex, null),
    maxLevel: clamp(Store.get('maxLevel', 0), 0, LEVELS.length - 1),
    solved: Store.get('solved', 0),
  };
}

function init(g) {
  const start = clamp(Store.get('maxLevel', 0), 0, LEVELS.length - 1);
  return newState(g, start);
}

function loadLevel(s, idx) {
  s.levelIndex = clamp(idx, 0, LEVELS.length - 1);
  s.sim = makeSim(s.levelIndex);
  s.drawing = false;
  s.raw = [];
  s.deadT = 0;
  s.winT = 0;
  s.wonHandled = false;
  s.newBest = false;
  s.best = Store.get('best:' + s.levelIndex, null);
  s.hintT = 3.0;
  s.msg = '';
  s.msgT = 0;
}

function say(s, en, zh) { s.msgEn = en; s.msgZh = zh || en; s.msgT = 1.6; }

// ---------------------------------------------------------------- update

function update(s, dt, g) {
  const I = g.input;
  s.flash = Math.max(0, s.flash - dt * 2.6);
  if (s.msgT > 0) s.msgT -= dt;
  if (s.hintT > 0) s.hintT -= dt;

  if (s.phase === 'intro') {
    if (I.justPressed('space') || I.justPressed('enter') || I.pointerPressed) {
      s.phase = 'play';
      s.hintT = 3.4;
      Sound.init(); Sound.resume();
    }
    return;
  }

  let intent = null;
  const want = (k, v) => { (intent || (intent = {}))[k] = v; };

  // --- tools
  for (let i = 0; i < TOOLS.length; i++) {
    if (I.justPressed(String(i + 1))) {
      s.tool = TOOLS[i];
      const meta = TOOL_META[TOOLS[i]];
      say(s, meta.labelEn, meta.labelZh);
      Sound.blip(520 + i * 90);
    }
  }

  // --- level navigation
  if (I.justPressed('BracketLeft') && s.levelIndex > 0) { loadLevel(s, s.levelIndex - 1); return; }
  if (I.justPressed('BracketRight') && s.levelIndex < s.maxLevel) { loadLevel(s, s.levelIndex + 1); return; }

  if (s.sim.status === 'won') {
    s.winT += dt;
    if ((I.justPressed('space') || I.justPressed('enter')) && s.winT > 0.35) {
      const next = s.levelIndex + 1;
      if (next >= LEVELS.length) { loadLevel(s, 0); say(s, 'ALL FIFTY SOLVED — RUN IT BACK', '五十关全部通关——再来一轮'); }
      else loadLevel(s, next);
      return;
    }
  }

  // --- commands
  if (I.justPressed('z')) want('undo', true);
  if (I.justPressed('c')) want('clear', true);
  if (I.justPressed('r')) { want('reset', true); s.deadT = 0; s.wonHandled = false; s.winT = 0; }
  if (I.justPressed('space') && s.sim.status === 'play' && !s.sim.released) want('release', true);

  // --- death auto-retry (keeps your drawing)
  if (s.sim.status === 'dead') {
    s.deadT += dt;
    if (s.deadT > 0.9) { want('reset', true); s.deadT = 0; }
  }

  // --- pointer drawing
  const pw = toWorld(g, I.pointer.x, I.pointer.y);
  if (I.pointerPressed) {
    const chip = hitPalette(g, I.pointer.x, I.pointer.y);
    if (chip >= 0) {
      s.tool = TOOLS[chip];
      say(s, TOOL_META[s.tool].labelEn, TOOL_META[s.tool].labelZh);
      Sound.blip(520 + chip * 90);
    } else {
      s.drawing = true;
      s.raw = [{ x: pw.x, y: pw.y }];
    }
  }
  if (s.drawing && I.pointer.down) {
    const last = s.raw[s.raw.length - 1];
    if (!last || Math.hypot(pw.x - last.x, pw.y - last.y) > 1.5) {
      if (s.raw.length < 2400) s.raw.push({ x: pw.x, y: pw.y });
    }
  }
  if (s.drawing && I.pointerReleased) {
    s.drawing = false;
    want('stroke', s.raw);
    want('tool', s.tool);
    want('commit', true);
    s.raw = [];
  }

  stepSim(s.sim, intent, dt);

  // --- consume simulation events for juice
  for (const e of s.sim.events) {
    if (e.type === 'ink') {
      Sound.tone({ freq: 240 + Math.min(400, e.v), dur: 0.09, type: 'triangle', gain: 0.08 });
      FX.burst(e.x, e.y, { count: 5, color: TOOL_META[s.tool].color, speed: 34, life: 0.3, size: 2 });
    } else if (e.type === 'pin') {
      Sound.tone({ freq: 880, dur: 0.07, type: 'square', gain: 0.09 });
      FX.burst(e.x, e.y, { count: 10, color: Palette.violet, speed: 60, life: 0.35, size: 2 });
    } else if (e.type === 'erase') {
      Sound.tone({ freq: 190, dur: 0.07, type: 'sine', gain: 0.08 });
    } else if (e.type === 'reject') {
      Sound.bad();
      s.flash = 1;
      say(s,
        s.sim.inkUsed + 12 > s.sim.inkBudget ? 'OUT OF INK — Z UNDO / 4 ERASE' : 'THAT STROKE DID NOT TAKE',
        s.sim.inkUsed + 12 > s.sim.inkBudget ? '墨水用完了——Z 撤销 / 4 擦除' : '这一笔没有生效');
    } else if (e.type === 'release') {
      Sound.tone({ freq: 420, dur: 0.1, type: 'sine', gain: 0.1, slide: 180 });
    } else if (e.type === 'thud') {
      const p = clamp(e.v / 10, 0.1, 1);
      Sound.noise({ dur: 0.06 + p * 0.06, gain: 0.03 + p * 0.1, freq: 380 + p * 500 });
      if (p > 0.45) FX.shake(p * 3.5);
    } else if (e.type === 'die') {
      Sound.bad();
      FX.shake(9);
      FX.burst(e.x, e.y, { count: 24, color: Palette.hot, speed: 170, life: 0.5, size: 2.6, gravity: 420 });
      s.flash = 1;
    } else if (e.type === 'win') {
      Sound.ok();
      FX.shake(5);
      for (let k = 0; k < 3; k++) {
        FX.burst(e.x, e.y, { count: 16, color: k === 1 ? Palette.warm : Palette.accent, speed: 90 + k * 70, life: 0.7, size: 3 });
      }
    }
  }

  // --- scoring
  if (s.sim.status === 'won' && !s.wonHandled) {
    s.wonHandled = true;
    const ink = Math.round(s.sim.inkUsed);
    s.newBest = Store.best('best:' + s.levelIndex, ink, false);
    s.best = Store.get('best:' + s.levelIndex, ink);
    s.maxLevel = clamp(Math.max(s.maxLevel, Math.min(LEVELS.length - 1, s.levelIndex + 1)), 0, LEVELS.length - 1);
    Store.set('maxLevel', s.maxLevel);
    s.solved = Store.get('solved', 0) + 1;
    Store.set('solved', s.solved);
    if (ink <= LEVELS[s.levelIndex].par) Sound.tone({ freq: 1180, dur: 0.2, type: 'triangle', gain: 0.1, at: 0.14 });
  }
}

// ---------------------------------------------------------------- render helpers

function taperPath(ctx, pts, n, closed, half) {
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i > 0 ? i - 1 : (closed ? n - 1 : 0)];
    const c = pts[i < n - 1 ? i + 1 : (closed ? 0 : n - 1)];
    let dx = c.x - a.x, dy = c.y - a.y;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;
    let w = half;
    if (!closed && n > 2) {
      const t = i / (n - 1);
      w = half * (0.42 + 0.58 * Math.pow(Math.sin(Math.PI * t), 0.4));
    }
    L.push({ x: pts[i].x - dy * w, y: pts[i].y + dx * w });
    R.push({ x: pts[i].x + dy * w, y: pts[i].y - dx * w });
  }
  ctx.beginPath();
  ctx.moveTo(L[0].x, L[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i].x, L[i].y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i].x, R[i].y);
  ctx.closePath();
}

function drawSegments(ctx, segs, color, edge) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = WALL_R * 2;
  ctx.beginPath();
  for (const w of segs) { ctx.moveTo(w[0], w[1]); ctx.lineTo(w[2], w[3]); }
  ctx.stroke();
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const w of segs) {
      const dx = w[2] - w[0], dy = w[3] - w[1];
      const dl = Math.hypot(dx, dy) || 1;
      const nx = -dy / dl * (WALL_R - 0.8), ny = dx / dl * (WALL_R - 0.8);
      const s = ny < 0 ? 1 : -1;
      ctx.moveTo(w[0] + nx * s, w[1] + ny * s);
      ctx.lineTo(w[2] + nx * s, w[3] + ny * s);
    }
    ctx.stroke();
  }
}

function drawSpikes(ctx, segs, t) {
  ctx.fillStyle = Palette.hot;
  for (const s of segs) {
    const dx = s[2] - s[0], dy = s[3] - s[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    let nx = -uy, ny = ux;
    if (ny > 0) { nx = -nx; ny = -ny; }         // point the teeth "up"
    const step = 15;
    const count = Math.max(1, Math.floor(len / step));
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * len, b = ((i + 1) / count) * len;
      const m = (a + b) / 2;
      const h = 13 + Math.sin(t * 2 + i) * 1.2;
      ctx.moveTo(s[0] + ux * a, s[1] + uy * a);
      ctx.lineTo(s[0] + ux * m + nx * h, s[1] + uy * m + ny * h);
      ctx.lineTo(s[0] + ux * b, s[1] + uy * b);
    }
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = Palette.hot;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawGoal(ctx, goal, t, glow, won) {
  const pulse = 0.55 + 0.45 * Math.sin(t * 2.4);
  const r = goal.r;
  const gr = ctx.createRadialGradient(goal.x, goal.y, r * 0.1, goal.x, goal.y, r);
  gr.addColorStop(0, won ? 'rgba(94,242,192,0.42)' : `rgba(94,242,192,${0.12 + pulse * 0.1})`);
  gr.addColorStop(1, 'rgba(94,242,192,0)');
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(goal.x, goal.y, r, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.translate(goal.x, goal.y);
  ctx.rotate(t * (won ? 2.2 : 0.5));
  ctx.strokeStyle = Palette.accent;
  ctx.globalAlpha = won ? 1 : 0.55 + pulse * 0.4;
  ctx.lineWidth = 2.4;
  ctx.setLineDash([9, 7]);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.78, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();

  // inner target ring + cardinal ticks — makes the well read as a destination
  ctx.save();
  ctx.strokeStyle = Palette.accent;
  ctx.globalAlpha = 0.28 + pulse * 0.18;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(goal.x, goal.y, r * 0.4, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = i * (TAU / 4);
    const cx = Math.cos(a), sy = Math.sin(a);
    ctx.moveTo(goal.x + cx * r * 0.92, goal.y + sy * r * 0.92);
    ctx.lineTo(goal.x + cx * r * 1.04, goal.y + sy * r * 1.04);
  }
  ctx.stroke();
  ctx.restore();

  if (glow > 0 || won) {
    ctx.save();
    ctx.shadowColor = Palette.accent;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = Palette.accent;
    ctx.globalAlpha = won ? 0.5 : glow * 0.5;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(goal.x, goal.y, r * (won ? 1 + Math.sin(t * 4) * 0.05 : 1.2 - glow * 0.2), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

/** Trace a body's centreline. Callers decide fill/stroke. */
function inkPath(ctx, pts, n, closed) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (closed) ctx.closePath();
}

function drawBodies(ctx, sim, t) {
  for (const b of sim.bodies) {
    const n = b.closed ? b.pts.length - 1 : b.pts.length;
    if (n < 2) continue;
    const pinned = b.tool === TOOL_STATIC;
    const col = pinned ? Palette.accent2 : Palette.warm;

    // 1. bloom — a wide, low-alpha, glow-coloured pass under the crisp core, plus a
    //    real shadow blur. This is what stops drawn ink reading as a debug polyline.
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = col;
    ctx.shadowBlur = 14;
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = col;
    ctx.lineWidth = INK_R * 2.9;
    inkPath(ctx, b.pts, n, b.closed);
    ctx.stroke();
    ctx.restore();

    // 2. core — width tapers along the stroke, with real round caps at both ends.
    ctx.save();
    ctx.fillStyle = col;
    taperPath(ctx, b.pts, n, b.closed, INK_R);
    ctx.fill();
    if (!b.closed) {
      const capR = INK_R * 0.44;
      for (const e of [b.pts[0], b.pts[n - 1]]) {
        ctx.beginPath();
        ctx.arc(e.x, e.y, capR, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();

    // 3. wet-ink shine along the top edge of the stroke
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = pinned ? 0.3 : 0.38;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.1;
    ctx.translate(0, -INK_R * 0.34);
    inkPath(ctx, b.pts, n, b.closed);
    ctx.stroke();
    ctx.restore();

    // 4. static ink is bolted to the world — show the rivets
    if (pinned) {
      ctx.save();
      for (const e of [b.pts[0], b.pts[n - 1]]) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = Palette.accent2;
        ctx.beginPath();
        ctx.arc(e.x, e.y, INK_R * 0.95, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = Palette.bg;
        ctx.beginPath();
        ctx.arc(e.x, e.y, INK_R * 0.34, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // pins
  for (const b of sim.bodies) {
    for (const p of b.pts) {
      if (!p.pin) continue;
      ctx.save();
      ctx.shadowColor = Palette.violet;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = Palette.violet;
      ctx.lineWidth = 1.8;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7 + Math.sin(t * 3) * 0.8, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = Palette.violet;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
}

function drawBall(ctx, sim, t) {
  const b = sim.ball;
  if (!b.alive) return;

  // Motion trail. sim.trail is the fixed-step ring buffer of the last 26 ball
  // positions, so the taper is frame-rate independent instead of drifting with rAF.
  const tr = sim.trail;
  if (tr.length > 1) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = Palette.accent;
    ctx.shadowColor = Palette.accent;
    ctx.shadowBlur = 8;
    for (let i = 1; i < tr.length; i++) {
      const f = i / (tr.length - 1);
      ctx.globalAlpha = 0.04 + f * 0.3;
      ctx.lineWidth = BALL_R * (0.2 + f * 0.9);
      ctx.beginPath();
      ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
      ctx.lineTo(tr[i].x, tr[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (!sim.released) {
    ctx.save();
    ctx.strokeStyle = Palette.ink;
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t * 4);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R + 8, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // halo + core + rim, then a specular so it still reads as a sphere and not a disc
  orb(ctx, b.x, b.y, BALL_R, Palette.ink, { glow: 0.9, rim: true });
  ctx.save();
  const gr = ctx.createRadialGradient(
    b.x - BALL_R * 0.34, b.y - BALL_R * 0.4, 0.5,
    b.x - BALL_R * 0.34, b.y - BALL_R * 0.4, BALL_R * 1.15,
  );
  gr.addColorStop(0, 'rgba(255,255,255,0.95)');
  gr.addColorStop(0.42, 'rgba(255,255,255,0.16)');
  gr.addColorStop(1, 'rgba(120,132,156,0.35)');
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(b.x, b.y, BALL_R, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawPreview(ctx, s, prep) {
  if (!s.drawing || s.raw.length === 0) return;
  const meta = TOOL_META[s.tool];
  if (s.tool === TOOL_PIN || s.tool === TOOL_ERASE) {
    const p = s.raw[s.raw.length - 1];
    const r = s.tool === TOOL_PIN ? 12 : 20;
    ctx.save();
    ctx.shadowColor = meta.color;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = meta.color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.55, 0, TAU);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const over = s.sim.inkUsed + (prep && prep.ok ? prep.len : 0) > s.sim.inkBudget;
  const col = over ? Palette.hot : meta.color;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = col;
  ctx.shadowColor = col;
  ctx.shadowBlur = 12;
  ctx.globalAlpha = 0.2;
  ctx.lineWidth = INK_R * 2.8;
  inkPath(ctx, s.raw, s.raw.length, false);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = over ? 0.9 : 0.75;
  ctx.lineWidth = INK_R * 2;
  ctx.setLineDash(over ? [6, 6] : []);
  inkPath(ctx, s.raw, s.raw.length, false);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- HUD

/** Width a stat() block will occupy, so a row of them can be packed without collisions. */
function statWidth(ctx, label, value, valueSize, labelSize) {
  ctx.save();
  ctx.font = `700 ${valueSize}px ${MONO}`;
  const vw = ctx.measureText(String(value)).width;
  ctx.font = `600 ${labelSize}px ${MONO}`;
  const lw = ctx.measureText(String(label).toUpperCase()).width * 1.16;   // letterSpacing 0.14em
  ctx.restore();
  return Math.max(vw, lw);
}

/** A centred capsule for transient copy — hints, prompts, warnings. Auto-shrinks to fit. */
function pill(ctx, g, cy, str, { fg = Palette.ink, border = Palette.grid, alpha = 1, size = Type.small }) {
  const maxW = g.w - 28;
  let sz = size;
  ctx.save();
  ctx.font = `700 ${sz}px ${MONO}`;
  let tw = ctx.measureText(str).width;
  while (tw + 30 > maxW && sz > 9) {
    sz -= 1;
    ctx.font = `700 ${sz}px ${MONO}`;
    tw = ctx.measureText(str).width;
  }
  ctx.restore();
  const h = Math.round(sz * 1.95);
  const w = Math.min(maxW, tw + 30);
  const a = clamp(alpha, 0, 1);
  ctx.save();
  ctx.globalAlpha = a;
  panel(ctx, (g.w - w) / 2, cy - h / 2, w, h, {
    fill: 'rgba(9,11,18,0.9)', border, radius: h / 2, glowColor: border, glowBlur: 12,
  });
  ctx.restore();
  text(ctx, str, g.w / 2, cy + 0.5, {
    size: sz, color: fg, align: 'center', baseline: 'middle', weight: 700, alpha: a,
  });
}

/**
 * The top status strip: which level you are on, how much ink you have spent against
 * the budget, the par you are chasing and your personal best. The ink meter spans the
 * full strip width so it never has to compete with the numbers for horizontal room.
 */
function drawHud(s, ctx, g, m, prep) {
  const L0 = LEVELS[s.levelIndex];
  const L = { ...L0, name: T(L0.name, L0.nameZh || L0.name), hint: T(L0.hint, L0.hintZh || L0.hint) };
  hudStrip(ctx, g, { h: m.hudH });

  const padX = m.padX;
  const labelY = m.compact ? 16 : 19;
  const vs = m.compact ? 15 : 20;
  const ls = m.compact ? Type.micro : Type.label;

  const budget = Math.max(1, s.sim.inkBudget);
  const used = Math.round(s.sim.inkUsed);
  const frac = clamp(s.sim.inkUsed / budget, 0, 1);
  const low = frac > 0.86;
  const inkColor = low ? Palette.hot : (s.sim.inkUsed <= L.par ? Palette.accent : Palette.warm);

  const items = [
    { label: T('ink', '墨水'), value: `${used}/${s.sim.inkBudget}`, color: inkColor },
    { label: T('par', '标准'), value: String(L.par), color: Palette.ink },
    { label: T('best', '最佳'), value: s.best === null ? '—' : String(s.best), color: s.best === null ? Palette.dim : Palette.accent2 },
  ];
  const gap = m.compact ? 13 : 20;
  const widths = items.map((it) => statWidth(ctx, it.label, it.value, vs, ls));
  let total = gap * (items.length - 1);
  for (const w of widths) total += w;

  let cx = g.w - padX - total;
  const groupLeft = cx;
  for (let i = 0; i < items.length; i++) {
    cx += widths[i];
    stat(ctx, cx, labelY, items[i].label, items[i].value, {
      align: 'right', color: items[i].color, valueSize: vs, labelSize: ls,
    });
    cx += gap;
  }

  // level identity, sized down until it clears the numbers
  const nn = String(s.levelIndex + 1).padStart(2, '0');
  const NN = String(LEVELS.length).padStart(2, '0');
  const nameMax = Math.max(48, groupLeft - padX - 14);
  let nameSize = vs;
  ctx.save();
  ctx.font = `700 ${nameSize}px ui-serif, "New York", Palatino, Georgia, serif`;
  while (nameSize > 12 && ctx.measureText(L.name).width > nameMax) {
    nameSize -= 1;
    ctx.font = `700 ${nameSize}px ui-serif, "New York", Palatino, Georgia, serif`;
  }
  ctx.restore();
  stat(ctx, padX, labelY, T(`level ${nn}/${NN}`, `第 ${nn}/${NN} 关`), L.name, {
    valueSize: nameSize, labelSize: ls, mono: false, color: Palette.ink,
  });

  // ink meter, hugging the bottom edge of the strip
  const mH = m.compact ? 4 : 5;
  const mY = m.hudH - mH - (m.compact ? 5 : 6);
  const mX = padX;
  const mW = Math.max(20, g.w - padX * 2);
  meter(ctx, mX, mY, mW, mH, frac, { color: inkColor, track: 'rgba(255,255,255,0.06)' });

  // ghost of the stroke you are mid-way through drawing
  if (prep && prep.ok) {
    const pf = clamp((s.sim.inkUsed + prep.len) / budget, 0, 1);
    if (pf > frac) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = s.sim.inkUsed + prep.len > s.sim.inkBudget ? Palette.hot : Palette.ink;
      roundRect(ctx, mX + mW * frac, mY, Math.max(2, mW * (pf - frac)), mH, mH / 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // par marker
  const parFrac = clamp(L.par / budget, 0, 1);
  ctx.save();
  ctx.strokeStyle = Palette.ink;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(mX + mW * parFrac, mY - 3.5);
  ctx.lineTo(mX + mW * parFrac, mY + mH + 3.5);
  ctx.stroke();
  ctx.restore();

  if (s.flash > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(s.flash, 0, 1) * 0.7;
    ctx.strokeStyle = Palette.hot;
    ctx.lineWidth = 2;
    roundRect(ctx, mX - 2.5, mY - 2.5, mW + 5, mH + 5, (mH + 5) / 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** The bottom tool dock. Selected chip = accent border, glow, filled hotkey badge. */
function drawDock(s, ctx, g, m) {
  const dockTop = g.h - m.dockH;
  ctx.save();
  ctx.fillStyle = 'rgba(13,16,24,0.92)';
  ctx.fillRect(0, dockTop, g.w, m.dockH);
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, dockTop + 0.5);
  ctx.lineTo(g.w, dockTop + 0.5);
  ctx.stroke();
  ctx.restore();

  const labelSize = m.compact ? Type.label : Type.small;
  for (const r of paletteRects(g)) {
    const meta = TOOL_META[r.tool];
    const on = s.tool === r.tool;

    panel(ctx, r.x, r.y, r.w, r.h, {
      fill: on ? 'rgba(255,255,255,0.07)' : 'rgba(17,22,36,0.9)',
      border: on ? meta.color : Palette.grid,
      radius: 8,
      glowColor: on ? meta.color : null,
      glowBlur: 18,
    });
    if (on) {
      ctx.save();
      ctx.strokeStyle = meta.color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.6;
      roundRect(ctx, r.x + 0.9, r.y + 0.9, r.w - 1.8, r.h - 1.8, 8);
      ctx.stroke();
      ctx.restore();
    }

    // hotkey badge — filled in the tool colour when live, muted tint when not
    const bs = Math.min(r.h - 10, m.compact ? 19 : 23);
    const bx = r.x + (m.compact ? 7 : 9);
    const by = r.y + (r.h - bs) / 2;
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.26;
    ctx.fillStyle = meta.color;
    roundRect(ctx, bx, by, bs, bs, 5);
    ctx.fill();
    ctx.restore();
    text(ctx, meta.key, bx + bs / 2, by + bs / 2 + 0.5, {
      size: m.compact ? Type.label : Type.small,
      color: on ? Palette.bg : Palette.ink,
      align: 'center', baseline: 'middle', weight: 700, alpha: on ? 1 : 0.8,
    });

    const tx = bx + bs + (m.compact ? 6 : 9);
    const room = r.w - (tx - r.x) - 8;
    ctx.save();
    ctx.font = `700 ${labelSize}px ${MONO}`;
    let lab = T(meta.labelEn, meta.labelZh);
    if (ctx.measureText(lab).width > room) lab = lab.slice(0, 3);
    const blurb = T(meta.blurbEn, meta.blurbZh);
    const showBlurb = !m.compact && r.h >= 38 && ctx.measureText(blurb).width <= room;
    ctx.restore();

    text(ctx, lab, tx, showBlurb ? r.y + 10 : r.y + r.h / 2, {
      size: labelSize, color: on ? Palette.ink : Palette.dim, weight: 700,
      baseline: showBlurb ? 'top' : 'middle',
    });
    if (showBlurb) {
      text(ctx, blurb, tx, r.y + 25, {
        size: Type.micro, color: on ? Palette.ink : Palette.dim, alpha: on ? 0.8 : 0.55,
      });
    }
  }
}

/** One status slot above the dock, priority-ordered so nothing ever overlaps. */
function statusLine(s, g) {
  if (s.sim.status === 'dead') return { t: T('BALL LOST — RESETTING', '球丢了——正在重置'), color: Palette.hot, alpha: 1 };
  if (s.msgT > 0) return { t: T(s.msgEn, s.msgZh), color: Palette.warm, alpha: clamp(s.msgT / 0.5, 0, 1) };
  if (s.sim.status === 'play' && !s.sim.released && s.sim.bodies.length > 0) {
    const p = 0.45 + 0.55 * Math.sin(g.t * 3.4);
    return { t: T('SPACE  →  DROP THE BALL', 'SPACE  →  放球'), color: Palette.accent, alpha: 0.4 + p * 0.6 };
  }
  return null;
}

// ---------------------------------------------------------------- render

function render(s, ctx, g) {
  const t = g.t;
  const L0 = LEVELS[s.levelIndex];
  const L = { ...L0, name: T(L0.name, L0.nameZh || L0.name), hint: T(L0.hint, L0.hintZh || L0.hint) };
  const v = getView(g);
  const m = metrics(g);
  // One prepareStroke per frame, shared by the on-paper preview and the HUD ghost bar.
  const prep = (s.drawing && s.raw.length > 1 && (s.tool === TOOL_INK || s.tool === TOOL_STATIC))
    ? prepareStroke(s.raw) : null;

  ctx.save();
  ctx.fillStyle = Palette.bg;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.restore();

  // ---------------------------------------------------------------- world
  ctx.save();
  ctx.translate(v.ox, v.oy);
  ctx.scale(v.scale, v.scale);
  const hair = 1 / v.scale;             // hairlines that stay 1 CSS px at any zoom

  ctx.save();
  ctx.fillStyle = Palette.bg2;
  roundRect(ctx, 0, 0, WORLD_W, WORLD_H, 10);
  ctx.fill();
  ctx.clip();

  // paper shading — lit from above so the sheet reads as a surface, not a rectangle
  const sheet = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  sheet.addColorStop(0, 'rgba(255,255,255,0.035)');
  sheet.addColorStop(0.55, 'rgba(255,255,255,0)');
  sheet.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = sheet;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // graph paper: minor rule every 40, major every 200
  ctx.strokeStyle = Palette.grid;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = hair;
  ctx.beginPath();
  for (let x = 40; x < WORLD_W; x += 40) { if (x % 200 === 0) continue; ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); }
  for (let y = 40; y < WORLD_H; y += 40) { if (y % 200 === 0) continue; ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); }
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = hair * 1.4;
  ctx.beginPath();
  for (let x = 200; x < WORLD_W; x += 200) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); }
  for (let y = 200; y < WORLD_H; y += 200) { ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); }
  ctx.stroke();
  ctx.globalAlpha = 1;

  drawSpikes(ctx, L.spikes || [], t);
  drawSegments(ctx, L.walls || [], '#1e2739', '#38466a');
  drawGoal(ctx, L.goal, t, s.sim.goalGlow, s.sim.status === 'won');
  drawBodies(ctx, s.sim, t);
  drawBall(ctx, s.sim, t);
  drawPreview(ctx, s, prep);
  FX.draw(ctx);
  ctx.restore();                         // end paper clip

  ctx.save();
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = hair * 1.6;
  roundRect(ctx, 0, 0, WORLD_W, WORLD_H, 10);
  ctx.stroke();
  ctx.restore();

  ctx.restore();                         // end world transform

  // Focus the eye on the sheet. Everything above this is playfield; everything below
  // is chrome, and chrome stays crisp.
  vignette(ctx, g, 0.45);

  if (s.flash > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(s.flash, 0, 1) * 0.18;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
  }

  // ---------------------------------------------------------------- chrome
  drawHud(s, ctx, g, m, prep);
  drawDock(s, ctx, g, m);

  if (s.hintT > 0 && s.phase === 'play' && s.sim.status === 'play') {
    pill(ctx, g, m.hudH + (m.compact ? 17 : 21), L.hint, {
      fg: Palette.ink, border: Palette.grid,
      alpha: clamp(s.hintT / 0.8, 0, 1) * 0.95,
      size: m.compact ? Type.label : Type.small,
    });
  }

  if (s.phase === 'play' && s.sim.status !== 'won') {
    const info = statusLine(s, g);
    if (info) {
      pill(ctx, g, g.h - m.dockH - (m.compact ? 18 : 23), info.t, {
        fg: info.color, border: info.color, alpha: info.alpha,
        size: m.compact ? Type.label : Type.small,
      });
    }
  }

  // ---------------------------------------------------------------- overlays
  if (s.sim.status === 'won') {
    const ink = Math.round(s.sim.inkUsed);
    const underPar = ink <= L.par;
    const last = s.levelIndex === LEVELS.length - 1;
    titleCard(ctx, g, {
      title: last ? T('SKETCHBOOK FULL', '画本已满') : T('SOLVED', '已解决'),
      tagline: T(`${ink} INK   ·   PAR ${L.par}`, `${ink} 墨水   ·   标准 ${L.par}`),
      lines: [
        T(`${L.name}  ·  level ${s.levelIndex + 1} of ${LEVELS.length}`,
          `${L.name}  ·  第 ${s.levelIndex + 1} / ${LEVELS.length} 关`),
        s.best === null ? '' : T(`your best here: ${s.best}`, `本关最佳: ${s.best}`),
      ].filter(Boolean),
      prompt: last ? T('SPACE  →  START OVER', 'SPACE  →  重新开始') : T('SPACE  →  NEXT LEVEL', 'SPACE  →  下一关'),
      t,
      accent: underPar ? Palette.accent : Palette.warm,
    });
    if (s.newBest || underPar) {
      pill(ctx, g, g.h / 2 - 128, s.newBest ? T('NEW PERSONAL BEST', '个人最佳纪录') : T('UNDER PAR', '低于标准'), {
        fg: Palette.warm, border: Palette.warm, size: Type.small,
      });
    }
  }

  if (s.phase === 'intro') {
    titleCard(ctx, g, {
      title: T('SCRIBBLE', '涂鸦'),
      tagline: T('Draw anything. It becomes real physics.', '画出任何东西,它都会成为真实的物理实体。'),
      lines: [
        T('Ramps, bridges, see-saws, catapults — get the ball home.', '斜坡、桥梁、跷跷板、投石机——想办法送球回家。'),
        '',
        T('DRAG  ·  draw a stroke', 'DRAG  ·  绘制一笔'),
        T('1 / 2  ·  falling ink  ·  world-pinned ink', '1 / 2  ·  会掉落的墨水  ·  固定于世界的墨水'),
        T('3 / 4  ·  pin a point  ·  erase + refund', '3 / 4  ·  钉住一点  ·  擦除并退还'),
        T('SPACE  ·  drop the ball', 'SPACE  ·  放下球'),
        T('R / Z / C  ·  reset  ·  undo  ·  clear', 'R / Z / C  ·  重置  ·  撤销  ·  清空'),
        T('[ / ]  ·  previous / next level', '[ / ]  ·  上一关 / 下一关'),
      ],
      prompt: T('DRAW SOMETHING', '画点什么'),
      t,
      accent: Palette.accent,
    });
  }
}

// ---------------------------------------------------------------- boot

const game = boot({ id: 'scribble', title: 'Scribble', seed: 1, init, update, render });
mountLangToggle();

// ---------------------------------------------------------------- self-test

registerSelftest('scribble', (check, log) => {
  const dt = 1 / 60;
  const BOUND_OK = 5000;
  const SPEED_OK = 20;   // px per fixed frame; the solver's hard clamp is 14

  // ---- 1. the world initialises
  let parsed = 0;
  const badLevels = [];
  for (let i = 0; i < LEVELS.length; i++) {
    const L = LEVELS[i];
    const s = makeSim(i);
    const ok = !!L.ball && Number.isFinite(L.ball.x) && Number.isFinite(L.ball.y)
      && !!L.goal && Number.isFinite(L.goal.x) && Number.isFinite(L.goal.y) && L.goal.r > 0
      && Number.isFinite(L.ink) && L.ink > 0 && Number.isFinite(L.par) && L.par > 0
      && Array.isArray(L.walls) && L.walls.length > 0
      && s.inkBudget === L.ink && s.ball.x === L.ball.x && s.status === 'play';
    if (ok) parsed++; else badLevels.push(i);
  }
  check('all 50 levels parse with ball start, goal and ink budget',
    parsed === LEVELS.length && LEVELS.length === 50, `${parsed}/${LEVELS.length} bad=[${badLevels}]`);

  // ---- 2. input creates geometry
  const s2 = makeSim(0);
  const p0 = countParticles(s2), c0 = countConstraints(s2);
  stepSim(s2, { stroke: [[120, 300], [420, 340], [640, 300]], tool: 'static', commit: true }, dt);
  check('a committed stroke creates particles and constraints',
    countParticles(s2) > p0 && countConstraints(s2) > c0,
    `particles ${p0}->${countParticles(s2)} constraints ${c0}->${countConstraints(s2)}`);

  // ---- 3. progress: ink increments, and reaching the goal completes the level
  check('ink used increments when you draw', s2.inkUsed > 100, `ink=${s2.inkUsed.toFixed(1)}`);
  const inkBefore = s2.inkUsed;
  stepSim(s2, { stroke: [[500, 120], [520, 121]], tool: 'ink', commit: true }, dt);
  check('a second stroke adds more ink', s2.inkUsed > inkBefore, `${inkBefore.toFixed(0)} -> ${s2.inkUsed.toFixed(0)}`);
  stepSim(s2, { undo: true }, dt);
  check('undo refunds the ink it removed', Math.abs(s2.inkUsed - inkBefore) < 0.01, `ink=${s2.inkUsed.toFixed(2)}`);
  const overshoot = makeSim(10);
  let rejected = false;
  for (let k = 0; k < 8; k++) {
    stepSim(overshoot, { stroke: [[40, 60 + k * 20], [900, 60 + k * 20]], tool: 'static', commit: true }, dt);
    if (overshoot.events.some((e) => e.type === 'reject')) rejected = true;
  }
  check('the ink budget actually refuses strokes',
    rejected && overshoot.inkUsed <= overshoot.inkBudget,
    `used=${overshoot.inkUsed.toFixed(0)}/${overshoot.inkBudget}`);

  // ---- 4. WIN is reachable — replay every authored solution through the real stepSim
  let solved = 0;
  const failed = [];
  const inks = [];
  for (let i = 0; i < LEVELS.length; i++) {
    const sol = LEVELS[i].solution;
    if (!sol) { failed.push(`${i}:none`); continue; }
    const r = replaySolution(i, sol);
    inks.push(Math.round(r.ink));
    if (r.won && r.ink <= LEVELS[i].ink) solved++;
    else failed.push(`${i}:${r.won ? 'over-budget' : (r.dead ? 'died' : 'timeout')}`);
  }
  check('every level has a verified winning stroke script',
    solved === LEVELS.length, `${solved}/${LEVELS.length} inks=[${inks}] ${failed.length ? 'failed: ' + failed.join(',') : ''}`);

  // ---- 5. LOSE is reachable
  const s5 = makeSim(1);
  stepSim(s5, { release: true }, dt);
  for (let i = 0; i < 400 && s5.status === 'play'; i++) stepSim(s5, null, dt);
  check('lose condition reachable (undrawn ball falls out of the world)',
    s5.status === 'dead' && s5.ball.alive === false, `status=${s5.status}`);
  const s5b = makeSim(6);
  stepSim(s5b, { stroke: [[220, 348], [520, 470]], tool: 'static', commit: true }, dt);
  stepSim(s5b, { release: true }, dt);
  for (let i = 0; i < 400 && s5b.status === 'play'; i++) stepSim(s5b, null, dt);
  check('lose condition reachable (spikes kill the ball)', s5b.status === 'dead', `status=${s5b.status}`);

  // ---- 6. no NaN and no runaway after 600+ frames with a LOT of geometry
  const s6 = makeSim(8);
  s6.inkBudget = 1e9;                       // stress the solver, not the budget
  for (let k = 0; k < 26; k++) {
    const pts = [];
    for (let j = 0; j < 12; j++) {
      pts.push([70 + ((k * 61 + j * 43) % 820), 40 + ((k * 37 + j * 53) % 300) + j * 6]);
    }
    stepSim(s6, { stroke: pts, tool: k % 3 === 0 ? 'static' : 'ink', commit: true }, dt);
  }
  stepSim(s6, { release: true }, dt);
  for (let i = 0; i < 650; i++) stepSim(s6, null, dt);
  const fin6 = allFinite(s6);
  check('no NaN/Infinity after 650 frames of heavy geometry', fin6.ok, fin6.bad.slice(0, 3).join(','));
  check('geometry stress actually built a lot of bodies',
    countParticles(s6) > 120 && countParticles(s6) <= MAX_PARTICLES,
    `bodies=${s6.bodies.length} particles=${countParticles(s6)} constraints=${countConstraints(s6)}`);
  check('no particle escapes a sane position bound', maxAbsCoord(s6) < BOUND_OK, `max|coord|=${maxAbsCoord(s6).toFixed(0)}`);
  check('no particle exceeds the velocity clamp', maxSpeed(s6) < SPEED_OK, `max speed=${maxSpeed(s6).toFixed(2)} px/frame`);

  // ---- 8. a drawn structure settles and stays settled
  const s8 = makeSim(0);
  stepSim(s8, { stroke: [[600, 300], [800, 300]], tool: 'ink', commit: true }, dt);
  stepSim(s8, { stroke: [[620, 250], [780, 250]], tool: 'ink', commit: true }, dt);
  stepSim(s8, { stroke: [[640, 200], [760, 205]], tool: 'ink', commit: true }, dt);
  for (let i = 0; i < 600; i++) stepSim(s8, null, dt);
  const ke600 = totalKE(s8);
  const anchor = { x: s8.bodies[0].pts[0].x, y: s8.bodies[0].pts[0].y };
  for (let i = 0; i < 300; i++) stepSim(s8, null, dt);
  const drift = Math.hypot(s8.bodies[0].pts[0].x - anchor.x, s8.bodies[0].pts[0].y - anchor.y);
  check('a drawn structure settles (kinetic energy -> ~0)', ke600 < 0.5, `KE@600=${ke600.toFixed(5)}`);
  check('and it does not drift or vibrate forever',
    drift < 3 && totalKE(s8) <= ke600 + 0.02,
    `drift=${drift.toFixed(3)}px KE@900=${totalKE(s8).toFixed(5)}`);

  // ---- 9. degenerate input never throws and never produces NaN
  const degenerate = [
    ['zero-length', []],
    ['null stroke', null],
    ['single point', [[300, 300]]],
    ['same point x64', Array.from({ length: 64 }, () => [300, 300])],
    ['NaN / Infinity', [[NaN, 3], [4, Infinity], [420, 300], [520, 320]]],
    ['non-numeric', [['x', 'y'], [420, 300], [500, 330]]],
    ['astronomical', [[1e12, -1e12], [3, 4]]],
    ['2000-point scribble', Array.from({ length: 2000 },
      (_, i) => [420 + Math.sin(i * 0.71) * 130, 260 + Math.cos(i * 0.29) * 90])],
  ];
  let degOk = true;
  const degNotes = [];
  for (const [name, pts] of degenerate) {
    try {
      const sd = makeSim(0);
      sd.inkBudget = 1e9;
      stepSim(sd, { stroke: pts, tool: 'ink', commit: true }, dt);
      for (let i = 0; i < 90; i++) stepSim(sd, null, dt);
      const f = allFinite(sd);
      if (!f.ok || maxAbsCoord(sd) > BOUND_OK) { degOk = false; degNotes.push(name + ':nan'); }
      degNotes.push(`${name}=${sd.bodies.length ? 'accepted(' + countParticles(sd) + 'p)' : 'rejected'}`);
    } catch (e) {
      degOk = false;
      degNotes.push(`${name}:threw ${e.message}`);
    }
  }
  check('degenerate strokes are accepted or rejected, never NaN, never throwing',
    degOk, degNotes.join(' '));
  const bigScribble = prepareStroke(degenerate[7][1]);
  check('a 2000-point scribble is simplified down to a sane particle count',
    bigScribble.ok && bigScribble.pts.length <= 72, `pts=${bigScribble.pts.length}`);

  // ---- LIVE game: real injected pointer input through the kit, drawing the SAME
  // stroke that replaySolution() already proved wins level 0 (levels.js LEVELS[0]
  // .solution — a single static ramp from (30,240) to (600,470)). Using verified
  // geometry here means this check proves the real Input->pointer->stroke pipeline
  // matches the pure-sim path, rather than re-litigating whether some ad hoc line
  // happens to be a working ramp.
  //
  // The page's own boot() call already started a live rAF/watchdog loop (the game
  // may genuinely be running when a user opens the console and calls this). That
  // loop calls game.step() on its own clock, concurrently with the manual
  // game.step() calls below — harmless for a coarse "did it move" check, but this
  // check's outcome depends on hundreds of frames of exact physics, where even one
  // extra or missing frame compounds into a different result. Pause the loop for
  // the deterministic portion and restore whatever state it was in afterward.
  // game.restart() re-reads Store('maxLevel') rather than resetting to level 0, and
  // committing/winning below writes real progress back to that same Store key — so
  // without isolating it, this check plays differently after its own first pass
  // (starts on whatever level it last advanced the player to) and quietly overwrites
  // real saved progress. Snapshot every key it can touch and restore them after.
  const wasPaused = game.paused;
  const savedMaxLevel = Store.get('maxLevel', 0);
  const savedBest0 = Store.get('best:0', null);
  const savedSolved = Store.get('solved', 0);
  game.paused = true;
  game.restart();
  loadLevel(game.state, 0);
  game.state.phase = 'play';
  game.state.tool = 'static';
  const sol0 = LEVELS[0].solution;
  const [rampStart, rampEnd] = sol0.strokes[0].points;
  const livePts = countParticles(game.state.sim);
  const STEPS = 14;
  const a = toScreen(game, rampStart[0], rampStart[1]);
  game.input.pointDown(a.x, a.y);
  game.step(1);
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const q = toScreen(game, rampStart[0] + (rampEnd[0] - rampStart[0]) * t, rampStart[1] + (rampEnd[1] - rampStart[1]) * t);
    game.input.pointTo(q.x, q.y);
    game.step(1);
  }
  const b = toScreen(game, rampEnd[0], rampEnd[1]);
  game.input.pointUp(b.x, b.y);
  game.step(2);
  check('live game: an injected pointer drag creates a body',
    countParticles(game.state.sim) > livePts && game.state.sim.bodies.length === 1,
    `particles ${livePts}->${countParticles(game.state.sim)} ink=${game.state.sim.inkUsed.toFixed(0)}`);

  // Let the drawn ramp settle under gravity before releasing the ball onto it —
  // replaySolution() does the same (solution.settle), and dropping the ball onto
  // still-relaxing geometry is a different, harder physics problem than the one
  // the verified solution actually solves.
  const settle = sol0.settle ?? 30;
  for (let i = 0; i < settle; i++) game.step(1);

  game.input.tap('space');
  game.step(1);
  check('live game: SPACE releases the ball', game.state.sim.released === true);
  const maxFrames = (sol0.maxFrames || 900) + 60;
  for (let i = 0; i < maxFrames && game.state.sim.status === 'play'; i++) game.step(1);
  check('live game: the drawn ramp delivers the ball to the goal',
    game.state.sim.status === 'won', `status=${game.state.sim.status} frames=${game.state.sim.runFrames}`);
  check('live game: state stays finite after the run', allFinite(game.state.sim).ok);

  game.input.clear();
  Store.set('maxLevel', savedMaxLevel);
  Store.set('best:0', savedBest0);
  Store.set('solved', savedSolved);
  game.restart();
  game.paused = wasPaused;
  log(`levels=${LEVELS.length} verified=${solved} solutionInk=[${inks}]`);
});

// dev console handle
globalThis.__scribble = { makeSim, stepSim, replaySolution, prepareStroke, LEVELS, countParticles, totalKE };

export default game;
