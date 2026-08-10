// Pulse — a procedurally-composed rhythm runner.
//
// A six-character seed writes a whole track: tempo, key, chord progression, bassline,
// drum kit and a lead melody with motif/variation/fill. That produces a NOTE TABLE,
// and the note table produces two things at once — the music you hear (synth.js) and
// the obstacle course you run (compose.js -> buildChart). Sync is not tuned, it is
// structural: the level literally IS the song.
//
//   compose.js  seed -> { bpm, key, scale, notes[], chart[], cues[] }   pure, DOM-free
//   sim.js      makeSim(seed) / stepSim(sim, intent, dt)                pure, DOM-free
//   synth.js    note table -> WebAudio, 25ms lookahead scheduler
//   game.js     input, clock, rendering, self-test                      (this file)
//
// The clock comes from Sound.ctx.currentTime while the song plays, and falls back to
// the kit's fixed-timestep accumulator when there is no audio — so the whole game is
// playable, and provable, with WebAudio never initialised.

import {
  boot, registerSelftest, Palette, FX, Sound, Store,
  clamp, text, roundRect, allFinite, randomSeedString, TAU,
} from '../../shared/kit.js';
import { compose, verifyChart, PHYS } from './compose.js';
import { makeSim, stepSim, autoRun, idleRun, playerHeight } from './sim.js';
import { Sequencer } from './synth.js';

const { SPIKE_H, CEIL_BOTTOM, STAND_H, SLIDE_H, PLAYER_W_T, LIVES } = PHYS;

const SEED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const START_SEED = 'PULSE1';

// ---------------------------------------------------------------- layout

function layout(g) {
  const groundY = Math.round(g.h * 0.74);
  const pxPerSec = clamp(g.w / 3.1, 150, 560);
  const vScale = clamp((groundY - 44) / 230, 0.55, 3.4);
  const playerX = Math.round(g.w * 0.27);
  const bandTop = Math.min(g.h * 0.12, groundY - SPIKE_H * vScale - 90);
  const bandBot = Math.max(bandTop + 24, groundY - 150 * vScale * 0.55);
  return { groundY, pxPerSec, vScale, playerX, bandTop, bandBot, u: clamp(Math.min(g.w / 960, g.h / 600), 0.55, 1.7) };
}

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}

// ---------------------------------------------------------------- state

const seq = new Sequencer(Sound);

function init(g) {
  const seed = String(g.seed || START_SEED).toUpperCase();
  const sim = makeSim(seed);
  let lo = Infinity, hi = -Infinity;
  for (const n of sim.song.notes) {
    if (n.kind !== 'lead') continue;
    if (n.freq < lo) lo = n.freq;
    if (n.freq > hi) hi = n.freq;
  }
  if (!Number.isFinite(lo) || hi <= lo) { lo = 220; hi = 880; }
  return {
    seed,
    sim,
    synth: seq,
    phase: 'intro',          // intro | play | over | win
    leadLo: lo, leadHi: hi,
    seedEdit: false,
    seedBuf: '',
    copied: 0,
    hint: 0,
    overT: 0,
    noAudio: false,
    best: Store.get('best', 0),
    seedBest: Store.get('seed:' + seed, 0),
    muted: Sound.muted,
  };
}

function startAudio(s) {
  if (s.noAudio) return;
  Sound.init();
  Sound.resume();
  if (Sound.ctx) s.synth.play(s.sim.song);
}

function restartRun(g, seed) {
  seq.stop();
  g.restart(seed === undefined ? g.seed : String(seed).toUpperCase());
  const s = g.state;
  s.phase = 'play';
  s.hint = 4;
  startAudio(s);
}

// ---------------------------------------------------------------- update

function seedTyping(s, g) {
  const I = g.input;
  for (let i = 0; i < SEED_CHARS.length; i++) {
    const ch = SEED_CHARS[i];
    if (I.justPressed(ch) && s.seedBuf.length < 10) s.seedBuf += ch;
  }
  if (I.justPressed('backspace')) s.seedBuf = s.seedBuf.slice(0, -1);
  if (I.justPressed('esc')) { s.seedEdit = false; s.synth.resume(); return true; }
  if (I.justPressed('enter')) {
    s.seedEdit = false;
    const next = s.seedBuf.trim() || s.seed;
    restartRun(g, next);
    return true;
  }
  return false;
}

function update(s, dt, g) {
  const I = g.input;
  if (s.copied > 0) s.copied -= dt;
  if (s.hint > 0) s.hint -= dt;

  if (s.seedEdit) { seedTyping(s, g); return; }

  // --- seed controls, live in every phase
  if (I.justPressed('s')) {
    s.seedEdit = true; s.seedBuf = '';
    s.synth.suspend();
    return;
  }
  if (I.justPressed('n')) { restartRun(g, randomSeedString(6)); return; }
  if (I.justPressed('r')) { restartRun(g, s.seed); return; }
  if (I.justPressed('c')) {
    s.copied = 1.6;
    try { navigator.clipboard && navigator.clipboard.writeText(s.seed); } catch { /* denied */ }
  }
  if (I.justPressed('m')) { s.muted = !s.muted; Sound.setMuted(s.muted); }

  if (s.phase === 'intro') {
    if (I.justPressed('space') || I.justPressed('enter') || I.pointerPressed || I.justPressed('up')) {
      s.phase = 'play';
      s.hint = 4;
      startAudio(s);
    }
    return;
  }

  if (s.phase === 'over' || s.phase === 'win') {
    s.overT += dt;
    if (I.justPressed('space') || I.justPressed('enter') || I.pointerPressed) { restartRun(g, s.seed); }
    return;
  }

  // --- playing: the clock is the audio clock whenever the song is actually running
  let step = dt;
  if (s.synth.running) step = clamp(s.synth.songTime - s.sim.t, 0, 0.25);

  const intent = {
    jump: I.justPressed('space') || I.justPressed('up') || I.justPressed('w') || I.pointerPressed,
    held: I.isDown('space') || I.isDown('up') || I.isDown('w') || I.pointer.down,
    slide: I.justPressed('down') || I.justPressed('shift'),
  };

  const sim = s.sim;
  stepSim(sim, intent, step);

  // --- juice, driven entirely by simulation events
  const L = layout(g);
  const px = L.playerX;
  const py = L.groundY - sim.y * L.vScale;
  for (const e of sim.events) {
    switch (e.type) {
      case 'kick': FX.shake(0.9 * (e.v || 1)); break;
      case 'judge':
        if (e.rank === 'perfect') {
          FX.shake(2.2);
          FX.burst(px, py, { count: 12, color: Palette.accent, speed: 190, life: 0.34, size: 2.6, drag: 0.86 });
        } else {
          FX.burst(px, py, { count: 6, color: Palette.accent2, speed: 130, life: 0.28, size: 2.2 });
        }
        break;
      case 'slam':
        FX.shake(4.5);
        FX.burst(px, L.groundY, { count: 16, color: Palette.violet, speed: 240, life: 0.3, size: 2.4, spread: 1.2, angle: Math.PI });
        break;
      case 'land':
        FX.burst(px, L.groundY, { count: 4, color: Palette.dim, speed: 70, life: 0.2, size: 2, spread: 1.4, angle: Math.PI });
        break;
      case 'hit':
        FX.shake(13);
        FX.burst(px, py, { count: 26, color: Palette.hot, speed: 260, life: 0.5, size: 3, gravity: 420 });
        Sound.bad();
        break;
      case 'miss': break;
      default: break;
    }
  }

  if (sim.dead && s.phase === 'play') {
    s.phase = 'over'; s.overT = 0;
    seq.stop();
    Store.best('best', sim.score);
    Store.best('seed:' + s.seed, sim.score);
    s.best = Store.get('best', 0);
    s.seedBest = Store.get('seed:' + s.seed, 0);
  } else if (sim.won && s.phase === 'play') {
    s.phase = 'win'; s.overT = 0;
    Sound.ok();
    Store.best('best', sim.score);
    Store.best('seed:' + s.seed, sim.score);
    s.best = Store.get('best', 0);
    s.seedBest = Store.get('seed:' + s.seed, 0);
    Store.set('cleared', Store.get('cleared', 0) + 1);
  }
}

// ---------------------------------------------------------------- render

function drawBackdrop(s, ctx, g, L, beat) {
  const sim = s.sim;
  const grd = ctx.createLinearGradient(0, 0, 0, g.h);
  grd.addColorStop(0, Palette.bg);
  grd.addColorStop(0.62, Palette.bg2);
  grd.addColorStop(1, '#05060a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, g.w, g.h);

  // horizon glow — breathes on every kick
  const k = sim.kickP;
  ctx.save();
  ctx.globalAlpha = 0.1 + k * 0.4;
  const gl = ctx.createLinearGradient(0, L.groundY - 190 * L.vScale * 0.5, 0, L.groundY);
  gl.addColorStop(0, 'rgba(94,242,192,0)');
  gl.addColorStop(1, sim.bassP > 0.4 ? 'rgba(160,107,255,0.55)' : 'rgba(59,167,255,0.4)');
  ctx.fillStyle = gl;
  ctx.fillRect(0, L.groundY - 190 * L.vScale * 0.5, g.w, 190 * L.vScale * 0.5);
  ctx.restore();

  // beat grid, parallaxed
  const song = sim.song;
  const t0 = sim.t - L.playerX / L.pxPerSec;
  const t1 = sim.t + (g.w - L.playerX) / L.pxPerSec;
  ctx.lineWidth = 1;
  let b = Math.floor(t0 / song.spb) - 1;
  for (; b * song.spb < t1; b++) {
    const bt = b * song.spb;
    const x = L.playerX + (bt - sim.t) * L.pxPerSec;
    if (x < -4 || x > g.w + 4) continue;
    const bar = ((b % 4) + 4) % 4 === 0;
    ctx.strokeStyle = bar ? Palette.grid : '#10131d';
    ctx.globalAlpha = bar ? 0.9 : 0.55;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, L.bandTop - 10);
    ctx.lineTo(Math.round(x) + 0.5, L.groundY);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // the melody, floating above the track — this is the note table, drawn
  const notes = song.notes;
  let i = lowerBound(notes, t0);
  const span = Math.max(1e-6, Math.log2(s.leadHi / s.leadLo));
  const bandH = Math.max(20, L.bandBot - L.bandTop);
  for (; i < notes.length && notes[i].time < t1; i++) {
    const n = notes[i];
    if (n.kind !== 'lead' && n.kind !== 'pad') continue;
    const x = L.playerX + (n.time - sim.t) * L.pxPerSec;
    const norm = clamp(Math.log2(n.freq / s.leadLo) / span, 0, 1);
    const y = L.bandBot - norm * bandH;
    const dtp = sim.t - n.time;
    const hot = dtp >= 0 && dtp < 0.22;
    if (n.kind === 'pad') {
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = Palette.violet;
      ctx.fillRect(x, y - 1, Math.max(2, n.dur * L.pxPerSec), 2);
      continue;
    }
    const size = (n.velocity >= 1 ? 5 : 3.4) * (hot ? 2 : 1);
    ctx.globalAlpha = hot ? 1 : 0.42;
    ctx.fillStyle = hot ? Palette.ink : Palette.accent2;
    ctx.beginPath();
    ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // bar-line pillars behind the track keep the tempo readable at a glance
  ctx.globalAlpha = 0.14 + beat * 0.1;
  ctx.fillStyle = Palette.panel;
  for (let bb = Math.floor(t0 / song.barDur) - 1; bb * song.barDur < t1; bb++) {
    const x = L.playerX + (bb * song.barDur - sim.t) * L.pxPerSec;
    ctx.fillRect(x - 1.5, L.groundY - 26 * L.vScale, 3, 26 * L.vScale);
  }
  ctx.globalAlpha = 1;
}

function drawTrack(s, ctx, g, L) {
  const sim = s.sim;
  const chart = sim.chart;
  const t0 = sim.t - L.playerX / L.pxPerSec - 0.4;
  const t1 = sim.t + (g.w - L.playerX) / L.pxPerSec + 0.4;
  const X = (t) => L.playerX + (t - sim.t) * L.pxPerSec;
  const Y = (u) => L.groundY - u * L.vScale;

  // --- ground, with holes where the pits are
  const holes = [];
  for (const o of chart) {
    if (o.type !== 'pit') continue;
    if (o.t + o.w < t0 || o.t - o.w > t1) continue;
    holes.push([X(o.t - (o.w - PLAYER_W_T) / 2), X(o.t + (o.w - PLAYER_W_T) / 2)]);
  }
  holes.sort((a, b) => a[0] - b[0]);
  ctx.fillStyle = '#12182a';
  ctx.fillRect(0, L.groundY, g.w, g.h - L.groundY);
  ctx.strokeStyle = Palette.accent;
  ctx.globalAlpha = 0.35 + sim.kickP * 0.65;
  ctx.lineWidth = 2 + sim.kickP * 2.5;
  ctx.beginPath();
  let cur = 0;
  for (const [a, b] of holes) {
    if (a > cur) { ctx.moveTo(cur, L.groundY); ctx.lineTo(Math.min(a, g.w), L.groundY); }
    cur = Math.max(cur, b);
  }
  if (cur < g.w) { ctx.moveTo(cur, L.groundY); ctx.lineTo(g.w, L.groundY); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  // black out the pits so the floor really is missing
  ctx.fillStyle = '#05060a';
  for (const [a, b] of holes) ctx.fillRect(a, L.groundY, b - a, g.h - L.groundY);

  // --- obstacles
  for (let i = 0; i < chart.length; i++) {
    const o = chart[i];
    if (o.t + o.w < t0 || o.t - o.w > t1) continue;
    const vw = (o.w - PLAYER_W_T) * L.pxPerSec;
    const cx = X(o.t);
    const near = clamp(1 - Math.abs(o.t - sim.t) / 1.4, 0, 1);
    const done = sim.obDone[i];

    if (o.type === 'spike') {
      const h = SPIKE_H * L.vScale;
      ctx.fillStyle = done ? '#4a2233' : Palette.hot;
      ctx.globalAlpha = done ? 0.4 : 0.75 + near * 0.25;
      ctx.beginPath();
      const teeth = 3;
      for (let k = 0; k < teeth; k++) {
        const x0 = cx - vw / 2 + (vw / teeth) * k;
        ctx.moveTo(x0, L.groundY);
        ctx.lineTo(x0 + vw / teeth / 2, L.groundY - h);
        ctx.lineTo(x0 + vw / teeth, L.groundY);
      }
      ctx.fill();
      ctx.globalAlpha = 0.25 * near;
      ctx.fillRect(cx - vw / 2, L.groundY - h - 3, vw, 2);
    } else if (o.type === 'pit') {
      ctx.globalAlpha = done ? 0.3 : 0.6 + near * 0.4;
      ctx.strokeStyle = Palette.warm;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - vw / 2, L.groundY); ctx.lineTo(cx - vw / 2, L.groundY + 14);
      ctx.moveTo(cx + vw / 2, L.groundY); ctx.lineTo(cx + vw / 2, L.groundY + 14);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      const yb = Y(CEIL_BOTTOM);
      ctx.globalAlpha = done ? 0.28 : 0.7 + near * 0.3;
      ctx.fillStyle = Palette.violet;
      roundRect(ctx, cx - vw / 2, L.bandBot + 8, vw, yb - L.bandBot - 8, 4);
      ctx.fill();
      ctx.globalAlpha = 0.3 * near;
      ctx.fillStyle = Palette.ink;
      ctx.fillRect(cx - vw / 2, yb - 3, vw, 3);
    }
    ctx.globalAlpha = 1;
  }

  // --- cue markers: press ON the marker, the beat and the obstacle are the same event
  const cues = sim.cues;
  let ci = lowerBound(cues, t0);
  for (; ci < cues.length && cues[ci].time < t1; ci++) {
    const c = cues[ci];
    const x = X(c.time);
    const lead = c.time - sim.t;
    const done = sim.cueDone[ci];
    const col = c.kind === 'slam' ? Palette.violet : Palette.warm;
    ctx.globalAlpha = done ? 0.16 : clamp(1.15 - Math.abs(lead) / 2.2, 0.18, 1);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (c.kind === 'slam') {
      ctx.moveTo(x - 7, L.groundY + 9); ctx.lineTo(x, L.groundY + 17); ctx.lineTo(x + 7, L.groundY + 9);
    } else {
      ctx.moveTo(x - 7, L.groundY + 17); ctx.lineTo(x, L.groundY + 9); ctx.lineTo(x + 7, L.groundY + 17);
    }
    ctx.stroke();
    if (!done && lead > 0 && lead < 0.75) {
      ctx.globalAlpha = clamp(1 - lead / 0.75, 0, 1) * 0.85;
      const r = 6 + lead * 34;
      ctx.beginPath();
      ctx.arc(x, L.groundY + 13, r, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.lineWidth = 1;

  // --- the strike line
  ctx.strokeStyle = Palette.ink;
  ctx.globalAlpha = 0.1;
  ctx.beginPath();
  ctx.moveTo(L.playerX + 0.5, L.bandTop); ctx.lineTo(L.playerX + 0.5, L.groundY + 22);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawRunner(s, ctx, g, L) {
  const sim = s.sim;
  const ph = playerHeight(sim);
  const w = PLAYER_W_T * L.pxPerSec;
  const h = ph * L.vScale;
  const x = L.playerX - w / 2;
  const y = L.groundY - sim.y * L.vScale - h;
  const blink = sim.invuln > 0 && Math.floor(sim.invuln * 18) % 2 === 0;

  // motion trail
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = Palette.accent;
  for (let k = 1; k <= 3; k++) {
    const tx = x - k * 9;
    ctx.globalAlpha = 0.16 / k;
    roundRect(ctx, tx, y + k, w, h, 4);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (blink) return;
  const col = sim.slide > 0 ? Palette.violet : (sim.diving ? Palette.accent2 : Palette.accent);
  ctx.save();
  ctx.shadowColor = col;
  ctx.shadowBlur = 10 + sim.leadP * 18;
  ctx.fillStyle = col;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.restore();
  // eye
  ctx.fillStyle = Palette.bg;
  ctx.fillRect(x + w * 0.58, y + h * 0.22, Math.max(2, w * 0.16), Math.max(2, h * 0.14));
}

function drawHud(s, ctx, g, L) {
  const sim = s.sim;
  const song = sim.song;
  const u = L.u;

  // progress
  const p = clamp(sim.t / song.duration, 0, 1);
  ctx.fillStyle = Palette.grid;
  ctx.fillRect(0, 0, g.w, 3);
  ctx.fillStyle = Palette.accent;
  ctx.fillRect(0, 0, g.w * p, 3);

  text(ctx, String(sim.score).padStart(6, '0'), 12, 12, { size: 24 * u, color: Palette.ink, weight: 700 });
  if (sim.combo > 1) {
    text(ctx, `x${sim.mult}  ${sim.combo} combo`, 12, 12 + 28 * u, {
      size: 12 * u, color: sim.mult > 1 ? Palette.warm : Palette.dim, weight: 700,
    });
  }

  // lives
  for (let i = 0; i < LIVES; i++) {
    ctx.globalAlpha = i < sim.lives ? 1 : 0.2;
    ctx.fillStyle = i < sim.lives ? Palette.hot : Palette.dim;
    roundRect(ctx, g.w - 14 - (i + 1) * 14 * u, 12, 9 * u, 9 * u, 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  text(ctx, `SEED ${s.seed}`, g.w - 12, 12 + 16 * u, { size: 11 * u, color: Palette.dim, align: 'right' });
  text(ctx, `${song.bpm} BPM · ${song.key} ${song.scale.toUpperCase()}`, g.w - 12, 12 + 31 * u,
    { size: 10 * u, color: Palette.dim, align: 'right', alpha: 0.8 });
  if (s.seedBest > 0) {
    text(ctx, `SEED BEST ${s.seedBest}`, g.w - 12, 12 + 45 * u, { size: 10 * u, color: Palette.dim, align: 'right', alpha: 0.7 });
  }

  // judgement pop
  if (sim.judgeAge < 0.5 && sim.lastJudge) {
    const a = clamp(1 - sim.judgeAge / 0.5, 0, 1);
    const rise = (1 - a) * 26;
    text(ctx, sim.lastJudge === 'perfect' ? 'PERFECT' : 'GOOD',
      L.playerX, L.groundY - 120 - rise, {
        size: (sim.lastJudge === 'perfect' ? 18 : 14) * u,
        color: sim.lastJudge === 'perfect' ? Palette.accent : Palette.accent2,
        align: 'center', weight: 700, alpha: a,
      });
  }

  if (s.hint > 0 && s.phase === 'play') {
    text(ctx, 'SPACE on the marker  ·  SPACE again in midair to slam-slide',
      g.w / 2, g.h - 18, { size: 11 * u, color: Palette.dim, align: 'center', alpha: clamp(s.hint, 0, 1) * 0.9 });
  }
  if (s.copied > 0) {
    text(ctx, `copied ${s.seed}`, g.w / 2, 20, { size: 11 * u, color: Palette.accent, align: 'center', alpha: clamp(s.copied, 0, 1) });
  }
  if (s.muted) text(ctx, 'MUTED', 12, g.h - 20, { size: 10 * u, color: Palette.dim });
}

function panel(ctx, g, w, h) {
  const x = (g.w - w) / 2, y = (g.h - h) / 2;
  ctx.fillStyle = 'rgba(7,8,13,0.9)';
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.fillStyle = Palette.panel;
  ctx.globalAlpha = 0.9;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = Palette.grid;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 12);
  ctx.stroke();
  return { x, y };
}

function drawOverlays(s, ctx, g, L) {
  const u = L.u;
  const cx = g.w / 2;
  const sim = s.sim;

  if (s.phase === 'intro') {
    panel(ctx, g, Math.min(g.w - 32, 560), Math.min(g.h - 40, 340));
    let y = g.h / 2 - 132;
    text(ctx, 'PULSE', cx, y, { size: 40 * u, color: Palette.accent, align: 'center', weight: 700 });
    y += 52 * u;
    text(ctx, 'The seed writes the song. The song writes the level.', cx, y, { size: 13 * u, color: Palette.ink, align: 'center' });
    y += 20 * u;
    text(ctx, 'Every note you hear is an obstacle you run — press on the beat.', cx, y, { size: 11 * u, color: Palette.dim, align: 'center' });
    y += 30 * u;
    text(ctx, 'SPACE / CLICK — jump   (hold for height)', cx, y, { size: 12 * u, color: Palette.warm, align: 'center' });
    y += 18 * u;
    text(ctx, 'SPACE again in midair — slam down and slide under', cx, y, { size: 12 * u, color: Palette.violet, align: 'center' });
    y += 26 * u;
    text(ctx, `SEED ${s.seed}   ·   ${sim.song.bpm} BPM   ·   ${sim.song.key} ${sim.song.scale}`,
      cx, y, { size: 12 * u, color: Palette.ink, align: 'center', weight: 700 });
    y += 17 * u;
    text(ctx, `${sim.song.notes.length} notes · ${sim.chart.length} obstacles · ${Math.round(sim.song.duration)}s`,
      cx, y, { size: 10 * u, color: Palette.dim, align: 'center' });
    y += 17 * u;
    text(ctx, 'S type a seed   ·   N re-roll   ·   C copy   ·   R restart   ·   M mute',
      cx, y, { size: 10 * u, color: Palette.dim, align: 'center', alpha: 0.85 });
    const p = 0.5 + 0.5 * Math.sin(s.introT * 3);
    text(ctx, 'PRESS SPACE', cx, g.h / 2 + 122, {
      size: 14 * u, color: Palette.warm, align: 'center', weight: 700, alpha: 0.35 + p * 0.65,
    });
  }

  if (s.phase === 'over' || s.phase === 'win') {
    const won = s.phase === 'win';
    panel(ctx, g, Math.min(g.w - 32, 480), Math.min(g.h - 40, 268));
    let y = g.h / 2 - 100;
    text(ctx, won ? 'TRACK CLEARED' : 'RUN ENDED', cx, y, {
      size: 26 * u, color: won ? Palette.accent : Palette.hot, align: 'center', weight: 700,
    });
    y += 40 * u;
    text(ctx, String(sim.score), cx, y, { size: 32 * u, color: Palette.ink, align: 'center', weight: 700 });
    y += 40 * u;
    const total = sim.perfect + sim.good + sim.missed;
    const acc = total ? Math.round((sim.perfect / total) * 100) : 0;
    text(ctx, `${sim.perfect} perfect · ${sim.good} good · ${sim.missed} missed · ${acc}% perfect`,
      cx, y, { size: 11 * u, color: Palette.dim, align: 'center' });
    y += 18 * u;
    text(ctx, `best combo ${sim.maxCombo} · ${sim.cleared}/${sim.chart.length} obstacles cleared`,
      cx, y, { size: 11 * u, color: Palette.dim, align: 'center' });
    y += 26 * u;
    text(ctx, `SEED ${s.seed}   best ${Math.max(s.seedBest, sim.score)}   ·   all-time ${Math.max(s.best, sim.score)}`,
      cx, y, { size: 11 * u, color: Palette.warm, align: 'center' });
    y += 26 * u;
    text(ctx, 'SPACE retry   ·   N new seed   ·   S type a seed   ·   C copy', cx, y,
      { size: 11 * u, color: Palette.dim, align: 'center' });
  }

  if (s.seedEdit) {
    panel(ctx, g, Math.min(g.w - 32, 420), 170);
    text(ctx, 'SEED', cx, g.h / 2 - 56, { size: 12 * u, color: Palette.dim, align: 'center', weight: 700 });
    const shown = s.seedBuf + (Math.floor(s.introT * 2.6) % 2 ? '_' : ' ');
    text(ctx, shown || '_', cx, g.h / 2 - 22, { size: 30 * u, color: Palette.accent, align: 'center', weight: 700 });
    text(ctx, 'type or paste · ENTER to play · ESC to cancel', cx, g.h / 2 + 28,
      { size: 11 * u, color: Palette.dim, align: 'center' });
  }
}

function render(s, ctx, g) {
  s.introT = g.t;
  const L = layout(g);
  const sim = s.sim;
  const beat = sim.kickP;

  drawBackdrop(s, ctx, g, L, beat);
  drawTrack(s, ctx, g, L);
  drawRunner(s, ctx, g, L);
  FX.draw(ctx);
  drawHud(s, ctx, g, L);

  if (sim.flash > 0.01) {
    ctx.globalAlpha = sim.flash * 0.3;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalAlpha = 1;
  }

  drawOverlays(s, ctx, g, L);
}

// ---------------------------------------------------------------- boot

const game = boot({ id: 'pulse', title: 'Pulse', seed: START_SEED, init, update, render });

// paste a seed straight into the seed prompt
addEventListener('paste', (e) => {
  const s = game.state;
  if (!s || !s.seedEdit) return;
  const raw = (e.clipboardData && e.clipboardData.getData('text')) || '';
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (cleaned) s.seedBuf = cleaned;
  e.preventDefault();
});

// keep the audio clock and the game clock from drifting apart across tab switches
document.addEventListener('visibilitychange', () => {
  if (document.hidden) seq.suspend(); else if (game.state && !game.state.seedEdit) seq.resume();
});

// ---------------------------------------------------------------- self-test

const TEST_SEEDS = (() => {
  const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out = ['ABC123', 'PULSE1', 'K7QP2M'];
  for (let i = 1; i <= 27; i++) {
    let s = '', n = (Math.imul(i, 2654435761) >>> 0);
    for (let k = 0; k < 6; k++) { s += AB[n % AB.length]; n = Math.floor(n / AB.length) + i * 31 + k * 7; }
    out.push(s);
  }
  return out;
})();

registerSelftest('pulse', (check, log) => {
  const dt = 1 / 60;
  const audioBefore = Sound.ctx;

  // 1 — the composer is deterministic
  const a = compose('ABC123');
  const b = compose('ABC123');
  const sameSong = JSON.stringify(a.notes) === JSON.stringify(b.notes);
  const sameChart = JSON.stringify(a.chart) === JSON.stringify(b.chart);
  const differs = JSON.stringify(compose('ABC124').notes) !== JSON.stringify(a.notes);
  check('composer is deterministic (identical note table + chart)', sameSong && sameChart,
    `notes=${a.notes.length} chart=${a.chart.length} bytes=${JSON.stringify(a.notes).length}`);
  check('a different seed writes a different song', differs);

  // 2 — the music is musically sane
  let offKey = 0, badFreq = 0, monotonic = true, last = -1, pitched = 0;
  const inScale = new Set(a.scaleSteps);
  for (const n of a.notes) {
    if (n.time < last - 1e-9) monotonic = false;
    last = n.time;
    if (!Number.isFinite(n.freq) || n.freq < 20 || n.freq > 16000) badFreq++;
    if (!Number.isFinite(n.dur) || n.dur <= 0) badFreq++;
    if (n.kind === 'lead' || n.kind === 'bass' || n.kind === 'pad') {
      pitched++;
      if (!inScale.has((((n.midi - a.keyMidi) % 12) + 12) % 12)) offKey++;
    }
  }
  check('note times are monotonically non-decreasing', monotonic);
  check('every pitched note is in key', offKey === 0, `${pitched} pitched notes, ${offKey} off-key, ${a.key} ${a.scale}`);
  check('every frequency is finite and audible', badFreq === 0, `${a.notes.length} notes checked`);
  check('the piece has real length and density', a.duration > 20 && a.notes.length > 200 && a.chart.length > 15,
    `${a.duration.toFixed(1)}s · ${a.notes.length} notes · ${a.chart.length} obstacles · ${a.bpm}bpm`);

  // 3 — the runner responds to input
  const s3 = makeSim('ABC123');
  const y0 = s3.y;
  stepSim(s3, { jump: true, held: true }, dt);
  for (let i = 0; i < 7; i++) stepSim(s3, { jump: false, held: true }, dt);
  check('a jump raises the runner', s3.y > y0 + 20, `y ${y0.toFixed(2)} -> ${s3.y.toFixed(2)}`);
  const yTop = s3.y;
  stepSim(s3, { jump: true, held: true }, dt);
  for (let i = 0; i < 4; i++) stepSim(s3, { jump: false, held: false }, dt);
  check('a second midair tap slams back down', s3.y < yTop && (s3.slide > 0 || s3.diving),
    `y ${yTop.toFixed(2)} -> ${s3.y.toFixed(2)} slide=${s3.slide.toFixed(2)}`);

  // 4 — a well-timed press scores and builds combo
  const s4 = makeSim('ABC123');
  const cue = s4.cues[0].time;
  let guard = 0;
  while (s4.t < cue - dt && guard++ < 6000) stepSim(s4, { jump: false, held: false }, dt);
  const before = s4.score;
  stepSim(s4, { jump: true, held: true }, dt);
  check('a well-timed press scores and starts a combo',
    s4.score > before && s4.combo === 1 && s4.perfect === 1,
    `score ${before}->${s4.score} combo=${s4.combo} judge=${s4.lastJudge} delta=${(s4.judgeDelta * 1000).toFixed(1)}ms`);

  // 5 + 6 + 9 — fairness across many seeds: analytic verifier AND a scripted run
  let verified = 0, beaten = 0, died = 0, failures = [];
  let minOb = 1e9, maxOb = 0, totalOb = 0;
  for (const seed of TEST_SEEDS) {
    const song = compose(seed);
    const v = verifyChart(song.chart);
    if (v.ok) verified++; else failures.push(`${seed}:${v.problems[0]}`);
    const won = autoRun(seed);
    if (won.won && won.hits === 0 && won.missed === 0) beaten++;
    else failures.push(`${seed}:auto(won=${won.won},hits=${won.hits},missed=${won.missed})`);
    const lost = idleRun(seed);
    if (lost.dead) died++; else failures.push(`${seed}:idle-survived`);
    minOb = Math.min(minOb, song.chart.length);
    maxOb = Math.max(maxOb, song.chart.length);
    totalOb += song.chart.length;
  }
  const N = TEST_SEEDS.length;
  check(`chart fairness: all ${N} seeds pass the completability verifier`, verified === N,
    `${verified}/${N} verified · obstacles ${minOb}-${maxOb} (avg ${(totalOb / N).toFixed(1)})`);
  check(`WIN reachable: scripted one-button run beats all ${N} seeds untouched`, beaten === N,
    `${beaten}/${N}${failures.length ? ' · ' + failures.slice(0, 2).join(' | ') : ''}`);
  check(`LOSE reachable: a no-input run dies on all ${N} seeds`, died === N, `${died}/${N}`);

  // 7 + live game — drive the real boot()ed game through the kit
  game.restart('ABC123');
  game.state.noAudio = true;
  game.state.phase = 'play';
  const live = game.state.sim;
  const liveCue = live.cues[0].time;
  game.step(Math.max(1, Math.floor(liveCue * 60) - 1));
  const scoreBefore = live.score;
  const yBefore = live.y;
  game.input.tap('space');
  game.step(1);
  const scoredLive = live.score > scoreBefore;
  game.step(6);
  check('LIVE game: input.tap("space") + step() scores on the cue and lifts the runner',
    scoredLive && live.y > yBefore + 8,
    `score ${scoreBefore}->${live.score} y ${yBefore.toFixed(2)}->${live.y.toFixed(2)} judge=${live.lastJudge}`);

  game.step(700);
  const snap = Object.assign({}, game.state, { synth: undefined });
  const fin = allFinite(snap);
  check('allFinite(state) after 700+ simulated frames', fin.ok, fin.bad.slice(0, 4).join(',') || 'clean');
  check('an unattended live run reaches the lose state', game.state.phase === 'over',
    `phase=${game.state.phase} lives=${live.lives} hits=${live.hits}`);

  // 10 — none of the above needed audio
  check('the whole self-test ran with WebAudio never initialised',
    Sound.ctx === audioBefore && !seq.playing,
    `Sound.ctx=${Sound.ctx ? 'pre-existing' : 'null'} synth.playing=${seq.playing}`);

  game.restart(START_SEED);
  log(`seeds tested: ${N} · ${a.bpm}bpm ${a.key} ${a.scale} · notes=${a.notes.length} chart=${a.chart.length}`);
});

// dev console handles
globalThis.__pulse = { compose, verifyChart, makeSim, stepSim, autoRun, idleRun, seq, PHYS, TEST_SEEDS };

export default game;
