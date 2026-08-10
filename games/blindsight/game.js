// Blindsight — echolocation stealth.
//
// The screen is black. A ping raycasts outward and writes its hit points into a
// decaying reveal buffer, so geometry surfaces and then rots back into nothing.
// The thing in the maze hears every ping you send: the more you see, the more it
// knows. Sim lives in ./sim.js and is pure — this file is input, audio and paint.

import {
  boot, registerSelftest, Palette, FX, Sound, Store,
  clamp, lerp, text, allFinite, TAU, randomSeedString,
  Type, hudStrip, stat, meter, orb, vignette, titleCard,
} from '../../shared/kit.js';
import {
  makeSim, stepSim, teleport,
  TILE, PING, SHARD_COUNT, SELF_GLOW_R, REVEAL_LIFE, ECHO_LIFE,
  PLAYER_R, RUN_SPEED, HUNTER_SPEED, CATCH_DIST,
  mapFromRows, bfsField, faceIndex, castRay, hasLOS, tileOf,
  FACE_N, FACE_E, FACE_S, FACE_W,
} from './sim.js';

// ---------------------------------------------------------------- palette

const VOID = '#04050a';
const ECHO_COOL = [110, 245, 255];
const ECHO_WARM = [130, 255, 205];
const CORE_TINT = [235, 255, 250];
const HOT = [255, 77, 109];
const ACCENT_RGB = [94, 242, 192];     // Palette.accent
const ACCENT2_RGB = [59, 167, 255];    // Palette.accent2

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// Chrome geometry. The strip is deliberately slim and low-opacity: this game is
// dark by design, so the HUD has to structure the frame without lighting the room.
const HUD = 46;
const HUD_LABEL_Y = 17;   // value baseline lands at 17 + valueSize + 2, inside 46px
const TOPPAD = HUD + 12;
const BOTPAD = 60;
const DREAD_CAP = 0.26;   // the danger wash must never fully obscure the playfield

// ---------------------------------------------------------------- state

function freshSeed() {
  const stored = Store.get('lastSeed', null);
  if (typeof stored === 'string' && stored.length >= 3) return stored;
  return randomSeedString(6);
}

function init(g) {
  const seed = typeof g.seed === 'string' && g.seed.length >= 3 ? g.seed : freshSeed();
  g.seed = seed;
  return {
    seedStr: seed,
    sim: makeSim(seed),
    phase: 'intro',        // intro | play | caught | won
    view: null,
    flash: 0,
    endT: 0,
    beat: 0,
    beatSide: 0,
    aimT: 0,
    aim: 0,
    hintT: 6,
    runs: Store.get('runs', 0),
  };
}

function resetRun(s, g, seed) {
  g.seed = seed;
  s.seedStr = seed;
  s.sim = makeSim(seed);
  s.phase = 'play';
  s.flash = 0;
  s.endT = 0;
  s.beat = 0;
  s.aimT = 0;
  s.hintT = 4;
  FX.reset();
  Store.set('lastSeed', seed);
}

// ---------------------------------------------------------------- view transform

function computeView(g, sim) {
  const worldW = sim.tw * TILE, worldH = sim.th * TILE;
  const avail = g.h - TOPPAD - BOTPAD;
  const s = Math.max(0.15, Math.min((g.w - 36) / worldW, avail / worldH));
  return {
    s,
    ox: (g.w - worldW * s) / 2,
    oy: TOPPAD + Math.max(0, (avail - worldH * s) / 2),
  };
}
const sx = (v, x) => v.ox + x * v.s;
const sy = (v, y) => v.oy + y * v.s;

// ---------------------------------------------------------------- input -> intent

function readIntent(g, s) {
  const I = g.input;
  let mx = 0, my = 0;
  if (I.anyDown('left', 'a')) mx -= 1;
  if (I.anyDown('right', 'd')) mx += 1;
  if (I.anyDown('up', 'w')) my -= 1;
  if (I.anyDown('down', 's')) my += 1;

  let ping = null;
  if (I.justPressed('space')) ping = 'wide';
  else if (I.justPressed('f') || I.justPressed('j') || I.pointerPressed) ping = 'narrow';

  const sneak = I.anyDown('shift', 'ShiftRight');
  const aim = s.aimT > 0 ? s.aim : null;
  return { mx, my, ping, sneak, aim };
}

/** Track a mouse aim for the narrow ping; keyboard-only play falls back to facing. */
function updateAim(g, s, dt) {
  const I = g.input;
  if (s.view && (I.pointer.moved || I.pointerPressed)) {
    const wx = (I.pointer.x - s.view.ox) / s.view.s;
    const wy = (I.pointer.y - s.view.oy) / s.view.s;
    const p = s.sim.player;
    if (Math.hypot(wx - p.x, wy - p.y) > 6) {
      s.aim = Math.atan2(wy - p.y, wx - p.x);
      s.aimT = 3;
    }
  }
  if (s.aimT > 0) s.aimT -= dt;
}

// ---------------------------------------------------------------- audio (never gates logic)

function panFor(s, x) {
  const p = s.sim.player;
  return clamp((x - p.x) / 240, -1, 1);
}

function playFx(s, ev) {
  const p = s.sim.player;
  const d = Math.hypot((ev.x || p.x) - p.x, (ev.y || p.y) - p.y);
  const pan = panFor(s, ev.x === undefined ? p.x : ev.x);
  switch (ev.type) {
    case 'ping':
      if (ev.kind === 'wide') {
        Sound.tone({ freq: 940, dur: 0.26, type: 'sine', gain: 0.15, slide: -640 });
        Sound.noise({ dur: 0.32, gain: 0.05, freq: 2600 });
      } else {
        Sound.tone({ freq: 1580, dur: 0.07, type: 'sine', gain: 0.055, slide: -420 });
      }
      break;
    case 'step': {
      const g = clamp(0.2 * (1 - d / 340), 0, 0.2) * (0.55 + ev.alert * 0.6);
      if (g > 0.004) {
        Sound.tone({ freq: 74 + ev.alert * 26, dur: 0.1, type: 'triangle', gain: g, pan, slide: -22 });
        Sound.noise({ dur: 0.07, gain: g * 0.5, freq: 420 });
      }
      break;
    }
    case 'shardPing':
      Sound.tone({ freq: 1460, dur: 0.3, type: 'sine', gain: clamp(0.06 * (1 - d / 520), 0.008, 0.06), pan });
      break;
    case 'exitPing':
      Sound.tone({ freq: 320, dur: 0.34, type: 'sine', gain: 0.045, pan });
      break;
    case 'hunterSeen':
      Sound.tone({ freq: 148, dur: 0.4, type: 'sawtooth', gain: 0.075, pan, slide: -52 });
      break;
    case 'spotted':
      Sound.tone({ freq: 300, dur: 0.5, type: 'sawtooth', gain: 0.1, slide: 240 });
      Sound.noise({ dur: 0.4, gain: 0.07, freq: 900 });
      break;
    case 'shard':
      Sound.tone({ freq: 880, dur: 0.1, type: 'triangle', gain: 0.11 });
      Sound.tone({ freq: 1320, dur: 0.2, type: 'triangle', gain: 0.09, at: 0.07 });
      break;
    case 'exitOpen':
      Sound.tone({ freq: 220, dur: 0.7, type: 'sine', gain: 0.12, slide: 220 });
      break;
    case 'caught':
      Sound.tone({ freq: 420, dur: 0.7, type: 'sawtooth', gain: 0.17, slide: -360 });
      Sound.noise({ dur: 0.6, gain: 0.16, freq: 300 });
      break;
    case 'win':
      Sound.tone({ freq: 523, dur: 0.16, type: 'triangle', gain: 0.13 });
      Sound.tone({ freq: 784, dur: 0.16, type: 'triangle', gain: 0.12, at: 0.13 });
      Sound.tone({ freq: 1046, dur: 0.42, type: 'triangle', gain: 0.12, at: 0.26 });
      break;
    default: break;
  }
}

function heartbeat(s, dt) {
  const dread = s.sim.dread;
  s.beat -= dt;
  if (s.beat > 0) return;
  s.beat = lerp(1.45, 0.4, dread);
  if (dread < 0.05 || s.phase !== 'play') return;
  const g = 0.05 + dread * 0.14;
  Sound.tone({ freq: 56, dur: 0.13, type: 'sine', gain: g });
  Sound.tone({ freq: 46, dur: 0.15, type: 'sine', gain: g * 0.8, at: 0.17 });
}

// ---------------------------------------------------------------- update

function drainFx(s, g) {
  const q = s.sim.fxq;
  for (let i = 0; i < q.length; i++) {
    const ev = q[i];
    playFx(s, ev);
    if (!s.view) continue;
    const v = s.view;
    if (ev.type === 'shard') {
      FX.burst(sx(v, ev.x), sy(v, ev.y), { count: 22, color: Palette.warm, speed: 110, life: 0.7, size: 2.4, drag: 0.9 });
    } else if (ev.type === 'caught') {
      FX.burst(sx(v, ev.x), sy(v, ev.y), { count: 40, color: Palette.hot, speed: 220, life: 0.8, size: 3.2 });
      FX.shake(20);
    } else if (ev.type === 'win') {
      FX.burst(sx(v, ev.x), sy(v, ev.y), { count: 34, color: Palette.accent, speed: 150, life: 0.9, size: 3 });
      FX.shake(5);
    } else if (ev.type === 'spotted') {
      FX.shake(6);
    }
  }
  q.length = 0;
}

function recordResult(s) {
  const key = s.seedStr;
  Store.best('shards:' + key, s.sim.collected, true);
  Store.best('shardsAll', s.sim.collected, true);
  if (s.sim.won) {
    Store.best('time:' + key, Math.round(s.sim.time * 100) / 100, false);
    Store.best('timeAll', Math.round(s.sim.time * 100) / 100, false);
  }
  Store.set('runs', (s.runs = s.runs + 1));
}

function update(s, dt, g) {
  s.flash = Math.max(0, s.flash - dt * 2.6);
  if (s.hintT > 0) s.hintT -= dt;

  if (s.phase === 'intro') {
    if (g.input.justPressed('space') || g.input.justPressed('enter') || g.input.pointerPressed) {
      Sound.init(); Sound.resume();
      resetRun(s, g, s.seedStr);
    }
    if (g.input.justPressed('n')) { s.seedStr = randomSeedString(6); s.sim = makeSim(s.seedStr); }
    return;
  }

  if (s.phase === 'caught' || s.phase === 'won') {
    s.endT += dt;
    // keep the world decaying underneath the overlay
    stepSim(s.sim, { mx: 0, my: 0, ping: null }, dt);
    drainFx(s, g);
    if (s.endT > 0.35) {
      if (g.input.justPressed('r') || g.input.justPressed('space') || g.input.justPressed('enter')) {
        resetRun(s, g, s.seedStr);
      } else if (g.input.justPressed('n')) {
        resetRun(s, g, randomSeedString(6));
      }
    }
    return;
  }

  // --- playing
  if (g.input.justPressed('r')) { resetRun(s, g, s.seedStr); return; }
  if (g.input.justPressed('n')) { resetRun(s, g, randomSeedString(6)); return; }

  updateAim(g, s, dt);
  stepSim(s.sim, readIntent(g, s), dt);
  drainFx(s, g);
  heartbeat(s, dt);

  if (s.sim.dead) { s.phase = 'caught'; s.endT = 0; s.flash = 1; recordResult(s); }
  else if (s.sim.won) { s.phase = 'won'; s.endT = 0; recordResult(s); }
}

// ---------------------------------------------------------------- render

const NBUCKET = 12;
const faceBuckets = [];
for (let i = 0; i < NBUCKET; i++) faceBuckets.push([]);
const echoBuckets = [[], [], [], [], []];

// A revealed surface is drawn as three stacked strokes: a wide dim halo, a mid
// glow, and a thin bright core tinted toward white. One flat line reads as a plot;
// this reads as drawn light.
const WALL_PASSES = [
  { w: 8.0, min: 4, a: 0.05, floor: 0.00, mix: 0.00 },
  { w: 3.4, min: 2, a: 0.17, floor: 0.05, mix: 0.14 },
  { w: 1.15, min: 1, a: 0.88, floor: 0.12, mix: 0.45 },
];

function drawGeometry(ctx, s, v) {
  const sim = s.sim, rv = sim.reveal, tw = sim.tw;
  for (let i = 0; i < NBUCKET; i++) faceBuckets[i].length = 0;

  for (let i = 0; i < rv.length; i++) {
    const val = rv[i];
    if (val <= 0.012) continue;
    const ti = i >> 2, f = i & 3;
    const tx = ti % tw, ty = (ti / tw) | 0;
    const x0 = tx * TILE, y0 = ty * TILE, x1 = x0 + TILE, y1 = y0 + TILE;
    let ax, ay, bx, by;
    if (f === FACE_N) { ax = x0; ay = y0; bx = x1; by = y0; }
    else if (f === FACE_S) { ax = x0; ay = y1; bx = x1; by = y1; }
    else if (f === FACE_W) { ax = x0; ay = y0; bx = x0; by = y1; }
    else { ax = x1; ay = y0; bx = x1; by = y1; }
    const b = Math.min(NBUCKET - 1, (Math.pow(clamp(val, 0, 1), 0.7) * NBUCKET) | 0);
    faceBuckets[b].push(sx(v, ax), sy(v, ay), sx(v, bx), sy(v, by));
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let pi = 0; pi < WALL_PASSES.length; pi++) {
    const P = WALL_PASSES[pi];
    ctx.lineWidth = Math.max(P.min, P.w * v.s);
    for (let b = 0; b < NBUCKET; b++) {
      const seg = faceBuckets[b];
      if (!seg.length) continue;
      const t = (b + 0.5) / NBUCKET;
      const fade = Math.pow(t, 0.8);
      const col = [
        Math.round(lerp(lerp(ECHO_COOL[0], ECHO_WARM[0], t), CORE_TINT[0], P.mix)),
        Math.round(lerp(lerp(ECHO_COOL[1], ECHO_WARM[1], t), CORE_TINT[1], P.mix)),
        Math.round(lerp(lerp(ECHO_COOL[2], ECHO_WARM[2], t), CORE_TINT[2], P.mix)),
      ];
      const a = P.a * (P.floor + (1 - P.floor) * fade);
      if (a <= 0.004) continue;
      ctx.strokeStyle = rgba(col, a.toFixed(4));
      ctx.beginPath();
      for (let i = 0; i < seg.length; i += 4) {
        ctx.moveTo(seg[i], seg[i + 1]);
        ctx.lineTo(seg[i + 2], seg[i + 3]);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawEchoes(ctx, s, v) {
  const es = s.sim.echoes;
  if (!es.length) return;
  for (let i = 0; i < echoBuckets.length; i++) echoBuckets[i].length = 0;
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    if (e.t < 0) continue;
    const rise = clamp(e.t / 0.06, 0, 1);
    const fall = clamp(1 - e.t / ECHO_LIFE, 0, 1);
    const a = rise * fall * fall * clamp(e.str, 0, 1);
    if (a <= 0.02) continue;
    const b = Math.min(echoBuckets.length - 1, (a * echoBuckets.length) | 0);
    echoBuckets[b].push(sx(v, e.x), sy(v, e.y));
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const sz = Math.max(0.9, 1.25 * v.s);
  for (let b = 0; b < echoBuckets.length; b++) {
    const pts = echoBuckets[b];
    if (!pts.length) continue;
    const f = (b + 0.5) / echoBuckets.length;
    ctx.fillStyle = rgba(ECHO_WARM, (f * 0.82).toFixed(4));
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      ctx.moveTo(pts[i] + sz, pts[i + 1]);
      ctx.arc(pts[i], pts[i + 1], sz, 0, TAU);
    }
    ctx.fill();
  }
  ctx.restore();
}

function drawRings(ctx, s, v) {
  const rings = s.sim.rings;
  if (!rings.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < rings.length; i++) {
    const R = rings[i];
    const t = clamp(R.r / R.range, 0, 1);
    const a = Math.pow(1 - t, 1.7) * (R.kind === 'wide' ? 0.55 : 0.36);
    if (a <= 0.01 || R.r <= 0) continue;
    const X = sx(v, R.x), Y = sy(v, R.y);
    const rr = Math.max(0.5, R.r * v.s);
    const band = Math.max(1.4, (R.kind === 'wide' ? 3.0 : 2.1) * v.s);

    // A radial gradient across the stroke's own width: transparent behind, bright
    // at the leading edge, transparent in front. That is what makes it read as a
    // wavefront rather than a hard-edged circle.
    const r0 = Math.max(0, rr - band * 1.8);
    const r1 = rr + band * 1.0;
    const gr = ctx.createRadialGradient(X, Y, r0, X, Y, r1);
    gr.addColorStop(0, rgba(ECHO_WARM, 0));
    gr.addColorStop(0.55, rgba(ECHO_WARM, (a * 0.32).toFixed(4)));
    gr.addColorStop(0.86, rgba(ECHO_WARM, a.toFixed(4)));
    gr.addColorStop(1, rgba(ECHO_WARM, 0));
    ctx.strokeStyle = gr;
    ctx.lineWidth = band * 2.6;
    ctx.beginPath();
    if (R.spread >= TAU - 1e-6) {
      ctx.arc(X, Y, rr, 0, TAU);
    } else {
      ctx.arc(X, Y, rr, R.dir - R.spread / 2, R.dir + R.spread / 2);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawShards(ctx, s, v, t) {
  const sim = s.sim;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < sim.shards.length; i++) {
    const sh = sim.shards[i];
    if (sh.taken || sh.glow <= 0.01) continue;
    const a = sh.glow;
    const X = sx(v, sh.x), Y = sy(v, sh.y);
    const rad = (5 + Math.sin(t * 4 + i) * 1.2) * v.s;
    const gr = ctx.createRadialGradient(X, Y, 0, X, Y, rad * 4);
    gr.addColorStop(0, `rgba(255,220,120,${a * 0.5})`);
    gr.addColorStop(1, 'rgba(255,200,87,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(X - rad * 4, Y - rad * 4, rad * 8, rad * 8);
    ctx.strokeStyle = `rgba(255,225,150,${a})`;
    ctx.lineWidth = Math.max(1, 1.5 * v.s);
    ctx.beginPath();
    const sp = sh.spin;
    for (let k = 0; k < 4; k++) {
      const ang = sp + k * (TAU / 4);
      const px = X + Math.cos(ang) * rad, py = Y + Math.sin(ang) * rad;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // exit — dark until pinged; once every shard is in, it becomes a beacon
  const ex = sim.exit;
  const beacon = ex.active ? 0.34 + 0.26 * Math.sin(t * 2.4) : 0;
  const ea = Math.max(ex.glow, beacon);
  if (ea > 0.01) {
    const X = sx(v, ex.x), Y = sy(v, ex.y);
    const col = ex.active ? [94, 242, 192] : [160, 107, 255];
    const rad = 9 * v.s;
    const gr = ctx.createRadialGradient(X, Y, 0, X, Y, rad * 4);
    gr.addColorStop(0, rgba(col, ea * 0.42));
    gr.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(X - rad * 4, Y - rad * 4, rad * 8, rad * 8);
    ctx.strokeStyle = rgba(col, ea);
    ctx.lineWidth = Math.max(1, 1.6 * v.s);
    ctx.beginPath();
    ctx.arc(X, Y, rad * (ex.active ? 1 + 0.1 * Math.sin(t * 3) : 1), 0, TAU);
    ctx.stroke();
    if (ex.active) {
      ctx.beginPath();
      ctx.arc(X, Y, rad * (1.5 + 0.9 * ((t * 0.5) % 1)), 0, TAU);
      ctx.strokeStyle = rgba(col, ea * (1 - ((t * 0.5) % 1)) * 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawHunter(ctx, s, v, t) {
  const h = s.sim.hunter;
  if (!h || h.glow <= 0.012) return;
  const a = h.glow;
  const X = sx(v, h.x), Y = sy(v, h.y);
  const rad = 8 * v.s;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const gr = ctx.createRadialGradient(X, Y, 0, X, Y, rad * 5);
  gr.addColorStop(0, `rgba(255,60,90,${a * 0.5})`);
  gr.addColorStop(1, 'rgba(255,60,90,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(X - rad * 5, Y - rad * 5, rad * 10, rad * 10);

  ctx.strokeStyle = rgba(HOT, a);
  ctx.lineWidth = Math.max(1, 1.7 * v.s);
  ctx.beginPath();
  const spikes = 9;
  for (let k = 0; k <= spikes; k++) {
    const ang = (k / spikes) * TAU + t * 0.7;
    const r = rad * (k % 2 ? 0.5 : 1) * (0.85 + 0.3 * Math.sin(t * 9 + k));
    const px = X + Math.cos(ang) * r, py = Y + Math.sin(ang) * r;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(ctx, s, v, t) {
  const p = s.sim.player;
  const X = sx(v, p.x), Y = sy(v, p.y);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rad = Math.max(1, SELF_GLOW_R * v.s);
  const gr = ctx.createRadialGradient(X, Y, 0, X, Y, rad);
  gr.addColorStop(0, 'rgba(120,255,220,0.15)');
  gr.addColorStop(0.4, 'rgba(90,200,255,0.05)');
  gr.addColorStop(1, 'rgba(90,200,255,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(X - rad, Y - rad, rad * 2, rad * 2);

  const r = Math.max(2, PLAYER_R * 0.62 * v.s);
  orb(ctx, X, Y, r, `rgba(186,255,238,${(0.82 + 0.18 * Math.sin(t * 5)).toFixed(3)})`, { glow: 0.55 });

  ctx.strokeStyle = 'rgba(150,240,255,0.55)';
  ctx.lineWidth = Math.max(1, 1.3 * v.s);
  ctx.beginPath();
  ctx.moveTo(X + Math.cos(p.face) * r * 1.3, Y + Math.sin(p.face) * r * 1.3);
  ctx.lineTo(X + Math.cos(p.face) * r * 3.1, Y + Math.sin(p.face) * r * 3.1);
  ctx.stroke();
  ctx.restore();
}

/**
 * The room is already black — a heavy vignette on top of that just eats the game.
 * So: a light vignette for framing, and a danger wash that is hard-capped in alpha
 * and pushed to the edges so it can never hide what you are looking at.
 * (This only shapes the RENDER. sim.dread itself is untouched.)
 */
function drawAtmosphere(ctx, g, s) {
  vignette(ctx, g, 0.2);

  const dread = s.sim.dread;
  ctx.save();
  if (dread > 0.03) {
    const cx = g.w / 2, cy = g.h / 2;
    const R = Math.max(1, Math.hypot(cx, cy));
    const pulse = 0.5 + 0.5 * Math.sin(g.t * lerp(3, 9, dread));
    const a = Math.min(DREAD_CAP, dread * dread * 0.42 * (0.55 + pulse * 0.45));
    const gr = ctx.createRadialGradient(cx, cy, R * 0.46, cx, cy, R);
    gr.addColorStop(0, 'rgba(255,40,70,0)');
    gr.addColorStop(1, `rgba(255,40,70,${a.toFixed(4)})`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, g.w, g.h);
  }
  if (s.flash > 0) {
    ctx.fillStyle = `rgba(255,60,90,${(s.flash * 0.26).toFixed(4)})`;
    ctx.fillRect(0, 0, g.w, g.h);
  }
  ctx.restore();
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

function drawHud(ctx, s, g) {
  const sim = s.sim;
  const compact = g.w < 760;
  const tiny = g.w < 520;
  const vs = tiny ? 17 : 20;
  const vs2 = tiny ? 12 : Type.body;

  // Slim, low-opacity strip: structure without light.
  hudStrip(ctx, g, { h: HUD, fill: 'rgba(13,16,24,0.55)' });

  stat(ctx, 18, HUD_LABEL_Y, 'shards', `${sim.collected}/${sim.shards.length}`, {
    color: sim.exit.active ? Palette.accent : Palette.ink, valueSize: vs,
  });
  stat(ctx, 18 + (tiny ? 96 : 128), HUD_LABEL_Y, 'time', fmtTime(sim.time), {
    color: Palette.ink, valueSize: vs,
  });

  stat(ctx, g.w - 18, HUD_LABEL_Y, 'seed', s.seedStr, {
    align: 'right', valueSize: vs2, color: Palette.dim,
  });
  if (!compact) {
    const bt = Store.get('time:' + s.seedStr, null);
    stat(ctx, g.w - 122, HUD_LABEL_Y, 'best', bt === null ? '—' : fmtTime(bt), {
      align: 'right', valueSize: vs2, color: Palette.dim,
    });
  }

  // ping readiness, bottom-left on the same 18px gutter as the strip
  const mw = compact ? 76 : 98, mh = 5, mx = 18 + 58;
  const rows = [
    ['wide', 1 - clamp(sim.cool.wide / PING.wide.cool, 0, 1), ACCENT_RGB],
    ['narrow', 1 - clamp(sim.cool.narrow / PING.narrow.cool, 0, 1), ACCENT2_RGB],
  ];
  for (let i = 0; i < rows.length; i++) {
    const label = rows[i][0], frac = rows[i][1], col = rows[i][2];
    const y = g.h - 30 + i * 14;
    text(ctx, label.toUpperCase(), 18, y + mh / 2, {
      size: Type.micro, color: Palette.dim, alpha: 0.75, baseline: 'middle',
    });
    meter(ctx, mx, y, mw, mh, frac, {
      color: rgba(col, frac >= 1 ? 0.92 : 0.42),
      track: 'rgba(255,255,255,0.05)',
      radius: mh / 2,
      glow: frac >= 1,
    });
  }

  if (s.hintT > 0 && s.phase === 'play') {
    const a = clamp(s.hintT / 1.5, 0, 1) * 0.8;
    const line = tiny ? 'SPACE ping  ·  F cone  ·  SHIFT sneak'
      : compact ? 'SPACE loud ping  ·  F quiet cone  ·  SHIFT sneak'
        : 'SPACE = loud ping (it hears you)   ·   F = quiet cone   ·   SHIFT = sneak';
    text(ctx, line, g.w / 2, g.h - 46, {
      size: compact ? Type.label : Type.small,
      color: Palette.dim, align: 'center', baseline: 'middle', alpha: a,
    });
  }
}

/** A slow expanding ring over the card, so the idea reads before you press anything. */
function introSweep(ctx, g, t) {
  const span = Math.max(80, Math.min(g.w, g.h) * 0.46);
  const r = (t * 90) % span;
  const a = 0.14 * (1 - r / span);
  if (a <= 0.004) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = rgba(ECHO_WARM, a.toFixed(4));
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(g.w / 2, g.h / 2, Math.max(0.5, r), 0, TAU);
  ctx.stroke();
  ctx.restore();
}

function drawIntro(ctx, s, g) {
  const compact = g.w < 820;
  titleCard(ctx, g, {
    title: 'BLINDSIGHT',
    tagline: compact
      ? 'Ping to see — it hears every ping.'
      : 'You are blind. Every ping shows you the maze — and shows the maze where you are.',
    lines: compact
      ? [
        `Find ${SHARD_COUNT} shards, then reach the exit.`,
        'WASD move  ·  SPACE loud ping  ·  F cone',
        'SHIFT sneak  ·  R retry  ·  N new seed',
        `SEED ${s.seedStr}`,
      ]
      : [
        `Find ${SHARD_COUNT} shards, then reach the exit. Something in here hunts by sound.`,
        'WASD / arrows move   ·   SPACE loud ping   ·   F quiet cone   ·   SHIFT sneak',
        `R restart seed   ·   N new seed   ·   SEED ${s.seedStr}`,
      ],
    prompt: 'PRESS SPACE',
    t: g.t,
    accent: Palette.accent,
  });
  introSweep(ctx, g, g.t);
}

function drawEnd(ctx, s, g) {
  const won = s.phase === 'won';
  const a = clamp(s.endT / 0.5, 0, 1);
  const bt = Store.get('time:' + s.seedStr, null);
  const lines = [`${s.sim.collected}/${s.sim.shards.length} shards  ·  seed ${s.seedStr}`];
  if (bt !== null) lines.push(`best on this seed  ${fmtTime(bt)}`);

  ctx.save();
  ctx.globalAlpha = a;
  titleCard(ctx, g, {
    title: won ? 'ESCAPED' : 'CAUGHT',
    tagline: won ? fmtTime(s.sim.time) : `survived ${fmtTime(s.sim.time)}`,
    lines,
    prompt: a > 0.9 ? 'SPACE / R  retry seed      N  new seed' : null,
    t: g.t,
    accent: won ? Palette.accent : Palette.hot,
  });
  ctx.restore();
}

function render(s, ctx, g) {
  const v = computeView(g, s.sim);
  s.view = v;

  ctx.save();
  ctx.fillStyle = VOID;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.restore();

  // The playfield is clipped to the band below the strip, so nothing the maze
  // throws outward (rings, halos, particles) can ever paint over the HUD.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HUD, g.w, Math.max(0, g.h - HUD));
  ctx.clip();
  drawGeometry(ctx, s, v);
  drawEchoes(ctx, s, v);
  drawRings(ctx, s, v);
  drawShards(ctx, s, v, g.t);
  drawHunter(ctx, s, v, g.t);
  if (s.phase !== 'caught') drawPlayer(ctx, s, v, g.t);
  FX.draw(ctx);
  ctx.restore();

  drawAtmosphere(ctx, g, s);
  drawHud(ctx, s, g);
  if (s.phase === 'intro') drawIntro(ctx, s, g);
  else if (s.phase === 'caught' || s.phase === 'won') drawEnd(ctx, s, g);
}

// ---------------------------------------------------------------- boot

const game = boot({
  id: 'blindsight',
  title: 'Blindsight',
  seed: freshSeed(),
  init, update, render,
});

// ---------------------------------------------------------------- self-test

registerSelftest('blindsight', (check, log) => {
  const dt = 1 / 60;
  const NOP = { mx: 0, my: 0, ping: null };
  const tileAt = (sim, x, y) => tileOf(x, y);

  // ---- 1. world initializes, and everything is genuinely reachable (flood fill)
  const SEEDS = [];
  for (let i = 0; i < 24; i++) SEEDS.push('BS' + i + 'X');
  const bad = [];
  let checkedShards = 0;
  for (const sd of SEEDS) {
    const sim = makeSim(sd);
    const sp = tileAt(sim, sim.player.x, sim.player.y);
    if (sim.map.solid[sp.ty * sim.tw + sp.tx]) { bad.push(sd + ':spawn-in-wall'); continue; }
    const field = bfsField(sim.map, sp.tx, sp.ty);
    const reach = (x, y) => { const t = tileAt(sim, x, y); return field[t.ty * sim.tw + t.tx] >= 0; };
    if (sim.shards.length !== SHARD_COUNT) bad.push(sd + ':shards=' + sim.shards.length);
    for (const sh of sim.shards) { checkedShards++; if (!reach(sh.x, sh.y)) bad.push(sd + ':shard-unreachable'); }
    if (!reach(sim.exit.x, sim.exit.y)) bad.push(sd + ':exit-unreachable');
    if (!sim.hunter || !reach(sim.hunter.x, sim.hunter.y)) bad.push(sd + ':hunter-unreachable');
  }
  check('24 seeds: spawn walkable + all shards/exit/hunter flood-fill reachable',
    bad.length === 0, bad.length ? bad.slice(0, 4).join(' ') : `${checkedShards} shards verified`);

  // ---- 2. the player responds to input, and walls actually stop it
  const CORRIDOR = [
    '##########',
    '#........#',
    '#######.##',
    '#######.##',
    '##########',
  ];
  const mv = makeSim('MOVE', {
    map: mapFromRows(CORRIDOR), spawnTile: { x: 1, y: 1 },
    exitTile: { x: 7, y: 3 }, shardCount: 0, hunter: false,
  });
  const startX = mv.player.x;
  for (let i = 0; i < 20; i++) stepSim(mv, { mx: 1, my: 0, ping: null }, dt);
  const dx20 = mv.player.x - startX;
  check('player moves on injected RIGHT', dx20 > 20, `dx=${dx20.toFixed(1)} after 20 frames`);

  for (let i = 0; i < 260; i++) stepSim(mv, { mx: 1, my: 0, ping: null }, dt);
  const wallX = 9 * TILE - PLAYER_R;   // corridor interior ends at tile 9
  const stride = RUN_SPEED / 60;
  check('walls block movement (never tunnels through)',
    mv.player.x <= wallX + 1e-6 && mv.player.x > wallX - stride - 0.01,
    `x=${mv.player.x.toFixed(2)} wall limit=${wallX.toFixed(2)}`);

  for (let i = 0; i < 40; i++) stepSim(mv, { mx: 0, my: -1, ping: null }, dt);
  const upY = mv.player.y;
  for (let i = 0; i < 40; i++) stepSim(mv, { mx: 0, my: -1, ping: null }, dt);
  check('solid wall above halts the player and holds it there',
    mv.player.y === upY && upY >= TILE + PLAYER_R - 1e-6 && upY < TILE + PLAYER_R + stride,
    `y=${upY.toFixed(2)} limit=${(TILE + PLAYER_R).toFixed(2)}`);

  // ---- 3. progress event: collecting a shard increments the count
  const prog = makeSim('PROGRESS');
  const s0 = prog.shards[0];
  teleport(prog, s0.x, s0.y);
  stepSim(prog, NOP, dt);
  const gotEvent = prog.fxq.some((e) => e.type === 'shard');
  check('collecting a shard increments the count and fires an event',
    prog.collected === 1 && gotEvent && prog.shards[0].taken === true,
    `collected=${prog.collected} event=${gotEvent}`);

  // ---- 4. WIN is reachable
  const win = makeSim('WINRUN');
  for (const sh of win.shards) { teleport(win, sh.x, sh.y); stepSim(win, NOP, dt); }
  const allShards = win.collected;
  const exitOpened = win.exit.active;
  teleport(win, win.exit.x, win.exit.y);
  stepSim(win, NOP, dt);
  check('win reachable: all shards then the exit -> won',
    win.won === true && allShards === SHARD_COUNT && exitOpened,
    `collected=${allShards} active=${exitOpened} won=${win.won} dead=${win.dead}`);

  const early = makeSim('WINRUN');
  teleport(early, early.exit.x, early.exit.y);
  stepSim(early, NOP, dt);
  check('exit is inert until every shard is collected',
    early.won === false && early.exit.active === false, `won=${early.won}`);

  // ---- 5. LOSE is reachable: the hunter runs down a stationary player
  const HALL = ['##########', '#........#', '##########'];
  const doom = makeSim('DOOM', {
    map: mapFromRows(HALL), spawnTile: { x: 1, y: 1 },
    hunterTile: { x: 8, y: 1 }, shardCount: 0,
  });
  let doomFrames = 0;
  while (!doom.over && doomFrames < 600) { stepSim(doom, NOP, dt); doomFrames++; }
  check('lose reachable: the hunter catches a stationary player',
    doom.dead === true && doom.over === true,
    `dead=${doom.dead} frames=${doomFrames} state=${doom.hunter.state}`);

  // ---- the core risk/reward: loudness decides whether it hears you at all
  const pathTiles = (sim) => {
    const pt = tileOf(sim.player.x, sim.player.y);
    const f = bfsField(sim.map, pt.tx, pt.ty);
    const ht = tileOf(sim.hunter.x, sim.hunter.y);
    return f[ht.ty * sim.tw + ht.tx];
  };
  const loud = makeSim('HEARME');
  const euclid = Math.hypot(loud.hunter.x - loud.player.x, loud.hunter.y - loud.player.y);
  const pathBefore = pathTiles(loud);
  stepSim(loud, { mx: 0, my: 0, ping: 'wide' }, dt);
  const alerted = loud.hunter.state;
  for (let i = 0; i < 600 && !loud.over; i++) stepSim(loud, NOP, dt);
  const pathAfter = pathTiles(loud);
  check('a WIDE ping is heard across the maze and the hunter closes in',
    (alerted === 'hunt' || alerted === 'chase') && (loud.over || pathAfter < pathBefore),
    `state=${alerted} path ${pathBefore}->${pathAfter} tiles (euclid ${euclid.toFixed(0)}px)`);

  const quiet = makeSim('HEARME');
  stepSim(quiet, { mx: 0, my: 0, ping: 'narrow' }, dt);
  check('a NARROW ping from that same distance is too quiet to be heard',
    quiet.hunter.state === 'patrol' && euclid > 300,
    `state=${quiet.hunter.state} at ${euclid.toFixed(0)}px`);

  // ---- 6. no NaN/Infinity after a long run of movement + pinging
  const longRun = makeSim('LONGRUN');
  const intent = { mx: 0, my: 0, ping: null, sneak: false };
  for (let i = 0; i < 720; i++) {
    intent.mx = Math.sin(i * 0.11) > 0 ? 1 : -1;
    intent.my = Math.cos(i * 0.073) > 0 ? 1 : -1;
    intent.ping = i % 90 === 0 ? 'wide' : (i % 37 === 0 ? 'narrow' : null);
    intent.sneak = (i % 220) > 170;
    stepSim(longRun, intent, dt);
  }
  const fin = allFinite(longRun);
  check('allFinite after 720 simulated frames of movement + pinging',
    fin.ok, fin.bad.slice(0, 4).join(','));
  check('long run actually pinged and revealed geometry',
    longRun.pingCount >= 10 && longRun.reveal.some((x) => x > 0),
    `pings=${longRun.pingCount} frames=${longRun.frames}`);

  // ---- 8. ECHOLOCATION CORRECTNESS on a known layout
  //   left room (x1..9) | solid wall column x=10 | right room (x11..13)
  const LOS_MAP = [
    '###############',
    '#.........#...#',
    '#.........#...#',
    '#.........#...#',
    '###############',
  ];
  const mkLos = () => makeSim('LOS', {
    map: mapFromRows(LOS_MAP), spawnTile: { x: 1, y: 2 }, shardCount: 0, hunter: false,
  });
  const los = mkLos();
  const visibleFace = faceIndex(los.map, 10, 2, FACE_W);   // wall facing the player, 204px away
  const hiddenFace = faceIndex(los.map, 10, 2, FACE_E);    // same wall, far side — occluded
  const hiddenFar = faceIndex(los.map, 14, 2, FACE_W);     // right room's wall — occluded
  const nearFace = faceIndex(los.map, 0, 2, FACE_E);       // wall right next to the player

  stepSim(los, { mx: 0, my: 0, ping: 'wide' }, dt);
  for (let i = 0; i < 50; i++) stepSim(los, NOP, dt);

  check('ping REVEALS a wall in line of sight',
    los.reveal[visibleFace] > 0.05 && los.reveal[nearFace] > 0.05,
    `visible=${los.reveal[visibleFace].toFixed(3)} near=${los.reveal[nearFace].toFixed(3)}`);
  check('ping does NOT reveal geometry behind a wall',
    los.reveal[hiddenFace] === 0 && los.reveal[hiddenFar] === 0,
    `backface=${los.reveal[hiddenFace]} farRoom=${los.reveal[hiddenFar]}`);

  const cone = mkLos();
  stepSim(cone, { mx: 0, my: 0, ping: 'narrow', aim: Math.PI }, dt);   // aimed WEST
  for (let i = 0; i < 50; i++) stepSim(cone, NOP, dt);
  check('narrow ping only reveals inside its cone',
    cone.reveal[visibleFace] === 0 && cone.reveal[nearFace] > 0.05,
    `east(out of cone)=${cone.reveal[visibleFace]} west(in cone)=${cone.reveal[nearFace].toFixed(3)}`);

  const conePos = mkLos();
  stepSim(conePos, { mx: 0, my: 0, ping: 'narrow', aim: 0 }, dt);      // aimed EAST
  for (let i = 0; i < 50; i++) stepSim(conePos, NOP, dt);
  check('narrow ping aimed at a wall does reveal it',
    conePos.reveal[visibleFace] > 0.05, `east=${conePos.reveal[visibleFace].toFixed(3)}`);

  const rayA = castRay(los.map, 36, 60, 1, 0, 600);
  check('raycast stops at the first solid tile',
    rayA.hit === 1 && rayA.tx === 10 && rayA.face === FACE_W && Math.abs(rayA.dist - 204) < 0.5,
    `tx=${rayA.tx} face=${rayA.face} dist=${rayA.dist.toFixed(2)}`);
  check('line of sight is blocked by the wall column',
    hasLOS(los.map, 36, 60, 200, 60) === true && hasLOS(los.map, 36, 60, 300, 60) === false);

  // ---- 9. determinism
  const script = [];
  for (let i = 0; i < 420; i++) {
    script.push({
      mx: i % 3 === 0 ? 1 : (i % 5 === 0 ? -1 : 0),
      my: i % 4 === 0 ? 1 : (i % 7 === 0 ? -1 : 0),
      ping: i % 80 === 0 ? 'wide' : (i % 41 === 0 ? 'narrow' : null),
      sneak: (i % 130) > 100,
    });
  }
  const a1 = makeSim('DETERMINISM');
  const a2 = makeSim('DETERMINISM');
  for (const it of script) { stepSim(a1, it, dt); stepSim(a2, it, dt); }
  const same = a1.player.x === a2.player.x && a1.player.y === a2.player.y
    && a1.hunter.x === a2.hunter.x && a1.hunter.y === a2.hunter.y
    && a1.collected === a2.collected && a1.hunter.state === a2.hunter.state;
  check('same seed + same intents => identical player and hunter positions', same,
    `p=(${a1.player.x.toFixed(4)},${a1.player.y.toFixed(4)})/(${a2.player.x.toFixed(4)},${a2.player.y.toFixed(4)}) ` +
    `h=(${a1.hunter.x.toFixed(4)},${a1.hunter.y.toFixed(4)})/(${a2.hunter.x.toFixed(4)},${a2.hunter.y.toFixed(4)})`);

  const b1 = makeSim('SEED-ONE');
  const b2 = makeSim('SEED-TWO');
  check('different seeds build different mazes',
    b1.map.solid.join(',') !== b2.map.solid.join(','));

  // ---- LIVE: drive the real game through the kit's input injection
  game.restart(game.seed);
  game.state.phase = 'play';
  game.state.aimT = 0;
  const liveX = game.state.sim.player.x;
  game.input.press('right');
  game.step(30);
  game.input.release('right');
  const liveDx = game.state.sim.player.x - liveX;
  check('LIVE game responds to game.input.press("right") + game.step(30)',
    liveDx > 12, `dx=${liveDx.toFixed(2)}`);

  const pingsBefore = game.state.sim.pingCount;
  game.input.tap('space');
  game.step(1);
  game.step(20);
  check('LIVE game emits a ping on SPACE and reveals geometry',
    game.state.sim.pingCount === pingsBefore + 1 && game.state.sim.echoes.length > 40,
    `pings=${game.state.sim.pingCount} echoes=${game.state.sim.echoes.length}`);
  check('LIVE state stays finite', allFinite(game.state.sim).ok);

  game.input.clear();
  game.restart(game.seed);

  check('nothing threw', true);
  log(`seedsChecked=${SEEDS.length} shardsPerRun=${SHARD_COUNT} tiles=${a1.tw}x${a1.th} faces=${a1.reveal.length}`);
});

// dev console handle
globalThis.__blindsight = {
  makeSim, stepSim, teleport, castRay, hasLOS, bfsField, mapFromRows, faceIndex,
  FACE_N, FACE_E, FACE_S, FACE_W, TILE, PING, RUN_SPEED, HUNTER_SPEED, CATCH_DIST, REVEAL_LIFE,
};

export default game;
