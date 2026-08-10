// Orbital — n-body gravity golf.
//
// Drag back from the probe, let go, and the only thing acting on it after that is
// gravity. Sink it in the ring under par.
//
// Everything physical lives in sim.js, which imports no DOM at all: the live game, the
// self-test and the node solver (tools-solve.mjs) all drive the same stepSim(), so a
// flight in your browser is bit-for-bit the flight the solver verified.

import {
  boot, registerSelftest, Palette, FX, Sound, Store, RNG,
  clamp, approach, text, roundRect, allFinite, TAU,
} from '../../shared/kit.js';

import {
  makeSim, launch as launchSim, stepSim, predict, previewSteps,
  solve, replaySolution, flightResult,
  MAX_POWER, MIN_POWER, PROBE_R, HOLE_COUNT,
} from './sim.js';

import { HOLES, TOTAL_PAR } from './holes.js';

// ---------------------------------------------------------------- look-up tables

const BODY_STYLE = {
  planet:    { core: '#20406e', edge: '#0b1526', rim: '#5aa0ff', halo: 'rgba(59,167,255,', label: 'PLANET' },
  moon:      { core: '#4a5468', edge: '#161c28', rim: '#a8b8d0', halo: 'rgba(168,184,208,', label: 'MOON' },
  blackhole: { core: '#000000', edge: '#000000', rim: '#a06bff', halo: 'rgba(160,107,255,', label: 'BLACK HOLE' },
  repulsor:  { core: '#5c1f30', edge: '#20090f', rim: '#ff4d6d', halo: 'rgba(255,77,109,',  label: 'REPULSOR' },
  wormhole:  { core: '#1a1030', edge: '#0a0618', rim: '#a06bff', halo: 'rgba(160,107,255,', label: 'WORMHOLE' },
};

const MEDALS = [
  [-3, 'ALBATROSS', Palette.warm],
  [-2, 'EAGLE', Palette.warm],
  [-1, 'BIRDIE', Palette.accent],
  [0, 'PAR', Palette.accent2],
  [1, 'BOGEY', Palette.dim],
  [2, 'DOUBLE BOGEY', Palette.hot],
];

function medalFor(strokes, par) {
  const d = strokes - par;
  if (d <= -3) return MEDALS[0];
  if (d === -2) return MEDALS[1];
  if (d === -1) return MEDALS[2];
  if (d === 0) return MEDALS[3];
  if (d === 1) return MEDALS[4];
  return MEDALS[5];
}

const rel = (n) => (n === 0 ? 'E' : n > 0 ? '+' + n : String(n));

// ---------------------------------------------------------------- camera / view

function viewRect(g) {
  const top = 46, bot = 30, side = 14;
  return { x: side, y: top, w: Math.max(60, g.w - side * 2), h: Math.max(60, g.h - top - bot) };
}

function fitScale(v, w, h) { return Math.min(v.w / Math.max(1, w), v.h / Math.max(1, h)); }

function worldToScreen(s, g, wx, wy) {
  const v = viewRect(g);
  return {
    x: v.x + v.w / 2 + (wx - s.cam.cx) * s.cam.scale,
    y: v.y + v.h / 2 + (wy - s.cam.cy) * s.cam.scale,
  };
}

function screenToWorld(s, g, sx, sy) {
  const v = viewRect(g);
  return {
    x: (sx - (v.x + v.w / 2)) / s.cam.scale + s.cam.cx,
    y: (sy - (v.y + v.h / 2)) / s.cam.scale + s.cam.cy,
  };
}

/** Where the camera wants to be this frame. Wide while aiming, tight while flying. */
function camTarget(s, g) {
  const v = viewRect(g);
  const b = s.sim.bounds;
  const base = fitScale(v, b.w + 70, b.h + 70);

  if (s.phase !== 'fly') {
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, scale: base };
  }

  const p = s.sim.probe, gl = s.sim.goal;
  const minx = Math.min(p.x - 330, gl.x - 130), maxx = Math.max(p.x + 330, gl.x + 130);
  const miny = Math.min(p.y - 330, gl.y - 130), maxy = Math.max(p.y + 330, gl.y + 130);
  let scale = clamp(fitScale(v, maxx - minx, maxy - miny), base, base * 1.55);

  let cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const halfW = v.w / (2 * scale), halfH = v.h / (2 * scale);
  const padL = b.x - 40, padR = b.x + b.w + 40, padT = b.y - 40, padB = b.y + b.h + 40;
  cx = (padR - padL) <= halfW * 2 ? (padL + padR) / 2 : clamp(cx, padL + halfW, padR - halfW);
  cy = (padB - padT) <= halfH * 2 ? (padT + padB) / 2 : clamp(cy, padT + halfH, padB - halfH);
  return { cx, cy, scale };
}

function snapCam(s, g) {
  const t = camTarget(s, g);
  s.cam.cx = t.cx; s.cam.cy = t.cy; s.cam.scale = t.scale;
}

// ---------------------------------------------------------------- aim mapping

/** Longest useful pull, in screen pixels. Scales with the canvas so any size feels the same. */
function pullMax(g) { return Math.max(90, Math.min(g.w, g.h) * 0.34); }

function pullToPower(px, g) {
  const t = clamp(px / pullMax(g), 0, 1);
  return MIN_POWER + (MAX_POWER - MIN_POWER) * t;
}

function powerToPull(power, g) {
  const t = clamp((power - MIN_POWER) / (MAX_POWER - MIN_POWER), 0, 1);
  return t * pullMax(g);
}

// ---------------------------------------------------------------- state

const STAR_COUNT = 190;

function makeStars(holeIndex, b) {
  const rng = new RNG(holeIndex * 7919 + 104729);
  const out = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const layer = rng.int(3);
    out.push({
      x: b.x - 200 + rng.next() * (b.w + 400),
      y: b.y - 200 + rng.next() * (b.h + 400),
      r: 0.6 + layer * 0.55 + rng.next() * 0.7,
      a: 0.14 + layer * 0.16 + rng.next() * 0.18,
      layer,
    });
  }
  return out;
}

function loadHole(s, g, idx, keepRound) {
  s.holeIndex = clamp(idx, 0, HOLE_COUNT - 1);
  s.sim = makeSim(s.holeIndex);
  s.stars = makeStars(s.holeIndex, s.sim.bounds);
  s.strokes = 0;
  s.ghosts = [];
  s.lastTrail = null;
  s.preview = null;
  s.drag.active = false;
  s.phase = s.phase === 'intro' ? 'intro' : 'aim';
  s.hintT = 4.2;
  s.resultT = 0;
  s.banner = null;
  s.warpFlash = 0;
  if (!keepRound) { s.scores = []; s.totalStrokes = 0; }
  if (g) snapCam(s, g);
}

function init(g) {
  const s = {
    holeIndex: 0,
    sim: makeSim(0),
    phase: 'intro',              // intro | aim | fly | result | sunk | round
    strokes: 0,
    totalStrokes: 0,
    scores: [],                  // strokes for each completed hole
    cam: { cx: 720, cy: 450, scale: 0.5 },
    drag: { active: false, x: 0, y: 0, pull: 0, angle: 0, power: 0 },
    preview: null,
    ghosts: [],
    lastTrail: null,
    stars: [],
    hintT: 4.2,
    resultT: 0,
    banner: null,                // { title, sub, color, t }
    message: '',
    messageT: 0,
    warpFlash: 0,
    lastTone: -1,
    bestRound: Store.get('bestRound', null),
    bestHoles: HOLES.map((_, i) => Store.get('hole' + i, null)),
    roundsPlayed: Store.get('rounds', 0),
    t: 0,
  };
  loadHole(s, g, 0, false);
  s.phase = 'intro';
  snapCam(s, g);
  return s;
}

// ---------------------------------------------------------------- update

function beginShot(s, g, angle, power) {
  if (s.lastTrail && s.lastTrail.length > 3) {
    s.ghosts.push(s.lastTrail);
    if (s.ghosts.length > 5) s.ghosts.shift();
  }
  launchSim(s.sim, angle, power);
  s.strokes++;
  s.totalStrokes++;
  s.phase = 'fly';
  s.preview = null;
  s.lastTrail = null;
  s.message = '';
  s.hintT = 0;
  Sound.tone({ freq: 220 + power * 0.6, dur: 0.2, type: 'triangle', gain: 0.1, slide: 260 });
  Sound.noise({ dur: 0.16, gain: 0.05, freq: 900 });
  FX.burst(s.sim.probe.x, s.sim.probe.y, {
    count: 14, color: Palette.accent, speed: 90, life: 0.4, size: 5, drag: 0.86,
    angle: angle + Math.PI, spread: 1.1,
  });
}

function finishHole(s) {
  const par = HOLES[s.holeIndex].par;
  const m = medalFor(s.strokes, par);
  s.scores[s.holeIndex] = s.strokes;
  const prev = s.bestHoles[s.holeIndex];
  const isBest = prev === null || s.strokes < prev;
  if (isBest) { s.bestHoles[s.holeIndex] = s.strokes; Store.set('hole' + s.holeIndex, s.strokes); }
  s.phase = 'sunk';
  s.resultT = 2.4;
  s.banner = {
    title: m[1],
    sub: `${s.strokes} stroke${s.strokes === 1 ? '' : 's'} · par ${par}${isBest ? ' · personal best' : ''}`,
    color: m[2],
    t: 0,
  };
  Sound.tone({ freq: 170, dur: 0.26, type: 'sine', gain: 0.17 });
  Sound.tone({ freq: 340, dur: 0.3, type: 'triangle', gain: 0.1, at: 0.05 });
  Sound.ok();
  FX.burst(s.sim.goal.x, s.sim.goal.y, { count: 44, color: m[2], speed: 210, life: 0.85, size: 5, drag: 0.9 });
  FX.burst(s.sim.goal.x, s.sim.goal.y, { count: 22, color: Palette.ink, speed: 110, life: 1.1, size: 3, drag: 0.93 });
  FX.shake(5);
}

function failShot(s, reason) {
  s.lastTrail = s.sim.trail.slice();
  s.phase = 'result';
  s.resultT = 0.75;
  s.message = reason;
  s.messageT = 2.2;
  Sound.thud();
  Sound.bad();
  FX.shake(10);
  const p = s.sim.probe;
  FX.burst(p.x, p.y, { count: 30, color: Palette.hot, speed: 220, life: 0.55, size: 5, drag: 0.9 });
  FX.burst(p.x, p.y, { count: 14, color: Palette.warm, speed: 120, life: 0.8, size: 3, drag: 0.94 });
}

function endRound(s) {
  s.phase = 'round';
  s.resultT = 0;
  const total = s.totalStrokes;
  const improved = s.bestRound === null || total < s.bestRound;
  if (improved) { s.bestRound = total; Store.set('bestRound', total); }
  s.roundsPlayed++;
  Store.set('rounds', s.roundsPlayed);
  s.roundBest = improved;
  Sound.tone({ freq: 300, dur: 0.3, type: 'triangle', gain: 0.12 });
  Sound.tone({ freq: 450, dur: 0.34, type: 'triangle', gain: 0.1, at: 0.12 });
  Sound.tone({ freq: 600, dur: 0.4, type: 'triangle', gain: 0.09, at: 0.26 });
}

function nextHole(s, g) {
  if (s.holeIndex + 1 >= HOLE_COUNT) { endRound(s); return; }
  const keep = true;
  loadHole(s, g, s.holeIndex + 1, keep);
  s.phase = 'aim';
}

function update(s, dt, g) {
  s.t += dt;
  if (s.messageT > 0) s.messageT -= dt;
  if (s.hintT > 0) s.hintT -= dt;
  if (s.warpFlash > 0) s.warpFlash = Math.max(0, s.warpFlash - dt * 3);
  if (s.banner) s.banner.t += dt;

  const I = g.input;

  // --- intro
  if (s.phase === 'intro') {
    if (I.justPressed('space') || I.justPressed('enter') || I.pointerReleased) {
      s.phase = 'aim';
      s.hintT = 4.2;
      Sound.init(); Sound.resume();
    }
    const t = camTarget(s, g);
    s.cam.scale = approach(s.cam.scale, t.scale, 0.05, dt);
    return;
  }

  // --- round summary
  if (s.phase === 'round') {
    if (I.justPressed('enter') || I.justPressed('r') || I.pointerReleased) {
      s.scores = []; s.totalStrokes = 0;
      loadHole(s, g, 0, false);
      s.phase = 'aim';
    }
    return;
  }

  // --- global keys
  if (I.justPressed('r') && s.phase !== 'sunk') {
    s.totalStrokes -= s.strokes;
    loadHole(s, g, s.holeIndex, true);
    s.message = 'HOLE RESET';
    s.messageT = 1.4;
  }
  if (I.justPressed('n') && I.isDown('shift')) { // dev skip
    if (s.holeIndex + 1 < HOLE_COUNT) { loadHole(s, g, s.holeIndex + 1, true); s.phase = 'aim'; }
  }
  if (I.justPressed('p') && I.isDown('shift')) {
    if (s.holeIndex > 0) { loadHole(s, g, s.holeIndex - 1, true); s.phase = 'aim'; }
  }

  // --- aiming
  if (s.phase === 'aim') {
    const probe = worldToScreen(s, g, s.sim.start.x, s.sim.start.y);
    if (I.pointerPressed) {
      s.drag.active = true;
      s.lastTone = -1;
    }
    if (s.drag.active) {
      const dx = probe.x - I.pointer.x, dy = probe.y - I.pointer.y;
      s.drag.pull = Math.hypot(dx, dy);
      s.drag.angle = Math.atan2(dy, dx);
      s.drag.power = pullToPower(s.drag.pull, g);
      s.drag.x = I.pointer.x; s.drag.y = I.pointer.y;

      if (s.drag.pull > 10) {
        s.preview = predict(s.holeIndex, s.drag.angle, s.drag.power, previewSteps(s.holeIndex));
        const frac = clamp(s.drag.pull / pullMax(g), 0, 1);
        if (Math.abs(frac - s.lastTone) > 0.05) {
          s.lastTone = frac;
          Sound.tone({ freq: 160 + frac * 520, dur: 0.045, type: 'sine', gain: 0.03 });
        }
      } else {
        s.preview = null;
      }

      if (I.pointerReleased) {
        s.drag.active = false;
        if (s.drag.pull > 10) beginShot(s, g, s.drag.angle, s.drag.power);
        else { s.message = 'PULL FURTHER BACK'; s.messageT = 1.4; }
        s.preview = null;
      }
    }
  }

  // --- flight
  if (s.phase === 'fly') {
    const turbo = I.isDown('space') ? 3 : 1;
    for (let k = 0; k < turbo && s.sim.status === 'flying'; k++) {
      const evBefore = s.sim.events.length;
      stepSim(s.sim, dt);
      for (let e = evBefore; e < s.sim.events.length; e++) {
        const ev = s.sim.events[e];
        if (ev.type === 'warp') {
          s.warpFlash = 1;
          Sound.tone({ freq: 880, dur: 0.2, type: 'sine', gain: 0.09, slide: -620 });
          FX.burst(ev.x, ev.y, { count: 18, color: Palette.violet, speed: 160, life: 0.5, size: 4 });
          FX.burst(ev.ex, ev.ey, { count: 18, color: Palette.accent2, speed: 160, life: 0.5, size: 4 });
        }
      }
    }
    if (s.sim.status === 'sunk') {
      s.lastTrail = s.sim.trail.slice();
      finishHole(s);
    } else if (s.sim.status === 'crashed') {
      const what = s.sim.crashType === 'blackhole' ? 'SWALLOWED BY THE BLACK HOLE'
        : s.sim.crashType === 'repulsor' ? 'SMACKED THE REPULSOR CORE'
        : s.sim.crashType === 'moon' ? 'CRASHED INTO A MOON'
        : 'CRASHED INTO A PLANET';
      failShot(s, what);
    } else if (s.sim.status === 'oob') {
      failShot(s, 'LEFT THE SYSTEM');
    } else if (s.sim.status === 'lost') {
      failShot(s, 'LOST IN SPACE');
    }
  }

  // --- shot failed: brief beat, then back to the tee
  if (s.phase === 'result') {
    s.resultT -= dt;
    if (s.resultT <= 0 || I.justPressed('enter')) {
      s.sim = makeSim(s.holeIndex);
      s.phase = 'aim';
      s.drag.active = false;
    }
  }

  // --- sunk: celebrate, then next hole
  if (s.phase === 'sunk') {
    s.resultT -= dt;
    if (s.resultT <= 0 || I.justPressed('enter') || I.justPressed('space') || I.pointerReleased) {
      nextHole(s, g);
    }
  }

  // --- camera easing
  const t = camTarget(s, g);
  s.cam.cx = approach(s.cam.cx, t.cx, 0.09, dt);
  s.cam.cy = approach(s.cam.cy, t.cy, 0.09, dt);
  s.cam.scale = approach(s.cam.scale, t.scale, 0.07, dt);
}

// ---------------------------------------------------------------- render helpers

function drawStars(s, ctx, g) {
  const b = s.sim.bounds;
  for (const st of s.stars) {
    const par = 1 - st.layer * 0.13;
    const x = b.x + b.w / 2 + (st.x - b.x - b.w / 2) * par;
    const y = b.y + b.h / 2 + (st.y - b.y - b.h / 2) * par;
    ctx.globalAlpha = st.a * (0.75 + 0.25 * Math.sin(s.t * 1.1 + st.x * 0.01));
    ctx.fillStyle = st.layer === 2 ? Palette.ink : Palette.dim;
    ctx.beginPath();
    ctx.arc(x, y, st.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawBounds(s, ctx) {
  const b = s.sim.bounds, px = 1 / s.cam.scale;
  ctx.save();
  ctx.strokeStyle = Palette.grid;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.5 * px;
  ctx.setLineDash([10 * px, 9 * px]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawField(s, ctx) {
  // Faint contour rings so the pull of each body is legible before you commit.
  const px = 1 / s.cam.scale;
  ctx.save();
  ctx.lineWidth = 1 * px;
  for (const b of s.sim.bodies) {
    if (b.gm === 0) continue;
    const st = BODY_STYLE[b.type] || BODY_STYLE.planet;
    const reach = Math.sqrt(Math.abs(b.gm) / 90);
    for (let k = 1; k <= 3; k++) {
      const rr = b.r + (reach - b.r) * (k / 3);
      if (rr <= b.r) continue;
      ctx.strokeStyle = st.halo + (0.085 - k * 0.021).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(b.px, b.py, rr, 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawBody(s, ctx, b) {
  const st = BODY_STYLE[b.type] || BODY_STYLE.planet;
  const px = 1 / s.cam.scale;
  ctx.save();

  if (b.orbit) {
    ctx.strokeStyle = 'rgba(120,132,156,0.20)';
    ctx.lineWidth = 1 * px;
    ctx.setLineDash([7 * px, 8 * px]);
    ctx.beginPath();
    ctx.arc(b.orbit.cx, b.orbit.cy, b.orbit.r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (b.type === 'wormhole') {
    const other = s.sim.bodies[b.link];
    if (other && b.index < b.link) {
      ctx.strokeStyle = 'rgba(160,107,255,0.16)';
      ctx.lineWidth = 1.4 * px;
      ctx.setLineDash([5 * px, 12 * px]);
      ctx.beginPath();
      ctx.moveTo(b.px, b.py);
      ctx.lineTo(other.px, other.py);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const spin = s.t * 1.6 + b.index * 1.3;
    for (let k = 0; k < 4; k++) {
      const rr = b.r * (1 - k * 0.19);
      ctx.strokeStyle = k % 2 ? 'rgba(59,167,255,0.75)' : 'rgba(160,107,255,0.85)';
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(b.px, b.py, rr, spin + k * 1.1, spin + k * 1.1 + 4.1);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(12,8,26,0.9)';
    ctx.beginPath();
    ctx.arc(b.px, b.py, b.r * 0.42, 0, TAU);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (b.type === 'blackhole') {
    const gr = ctx.createRadialGradient(b.px, b.py, b.r * 0.7, b.px, b.py, b.r * 3.4);
    gr.addColorStop(0, 'rgba(160,107,255,0.34)');
    gr.addColorStop(0.45, 'rgba(90,50,150,0.10)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(b.px, b.py, b.r * 3.4, 0, TAU); ctx.fill();

    ctx.strokeStyle = Palette.violet;
    ctx.lineWidth = 2.2 * px;
    ctx.beginPath(); ctx.arc(b.px, b.py, b.r * 1.7, s.t * 0.9, s.t * 0.9 + 2.4); ctx.stroke();
    ctx.strokeStyle = Palette.hot;
    ctx.lineWidth = 1.6 * px;
    ctx.beginPath(); ctx.arc(b.px, b.py, b.r * 2.15, -s.t * 0.7 + 2.2, -s.t * 0.7 + 4.3); ctx.stroke();

    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(b.px, b.py, b.r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(160,107,255,0.9)';
    ctx.lineWidth = 1.2 * px;
    ctx.beginPath(); ctx.arc(b.px, b.py, b.r, 0, TAU); ctx.stroke();
    ctx.restore();
    return;
  }

  if (b.type === 'repulsor') {
    const pulse = (s.t * 0.9) % 1;
    for (let k = 0; k < 3; k++) {
      const f = (pulse + k / 3) % 1;
      ctx.strokeStyle = `rgba(255,77,109,${(0.30 * (1 - f)).toFixed(3)})`;
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(b.px, b.py, b.r * (1 + f * 1.9), 0, TAU);
      ctx.stroke();
    }
  }

  const gr = ctx.createRadialGradient(
    b.px - b.r * 0.35, b.py - b.r * 0.35, b.r * 0.12,
    b.px, b.py, b.r
  );
  gr.addColorStop(0, st.core);
  gr.addColorStop(1, st.edge);
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(b.px, b.py, b.r, 0, TAU); ctx.fill();

  ctx.strokeStyle = st.rim;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.6 * px;
  ctx.beginPath(); ctx.arc(b.px, b.py, b.r, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1 * px;
  ctx.beginPath(); ctx.arc(b.px, b.py, b.r * 1.12, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawGoal(s, ctx) {
  const gl = s.sim.goal, px = 1 / s.cam.scale;
  const pulse = 0.5 + 0.5 * Math.sin(s.t * 2.4);
  ctx.save();
  const gr = ctx.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, gl.r * 2.6);
  gr.addColorStop(0, 'rgba(94,242,192,0.20)');
  gr.addColorStop(1, 'rgba(94,242,192,0)');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(gl.x, gl.y, gl.r * 2.6, 0, TAU); ctx.fill();

  ctx.strokeStyle = Palette.accent;
  ctx.lineWidth = 2.4 * px;
  ctx.globalAlpha = 0.55 + pulse * 0.45;
  ctx.beginPath(); ctx.arc(gl.x, gl.y, gl.r, 0, TAU); ctx.stroke();

  ctx.lineWidth = 1.2 * px;
  ctx.globalAlpha = 0.3 + pulse * 0.4;
  ctx.beginPath(); ctx.arc(gl.x, gl.y, gl.r * (1.25 + pulse * 0.3), 0, TAU); ctx.stroke();

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = Palette.accent;
  ctx.beginPath(); ctx.arc(gl.x, gl.y, 2.6 * px + 1.5, 0, TAU); ctx.fill();

  // crosshair ticks
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.4 * px;
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + s.t * 0.4;
    ctx.beginPath();
    ctx.moveTo(gl.x + Math.cos(a) * gl.r * 1.5, gl.y + Math.sin(a) * gl.r * 1.5);
    ctx.lineTo(gl.x + Math.cos(a) * gl.r * 1.85, gl.y + Math.sin(a) * gl.r * 1.85);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTrail(s, ctx, pts, color, maxAlpha, width) {
  if (!pts || pts.length < 2) return;
  const px = 1 / s.cam.scale;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = width * px;
  const n = pts.length;
  // Break the polyline wherever the probe teleported, so warps do not draw a straight seam.
  let started = false;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (i > 0) {
      const q = pts[i - 1];
      if (Math.abs(p.x - q.x) > 260 || Math.abs(p.y - q.y) > 260) { started = false; }
    }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
    else ctx.lineTo(p.x, p.y);
  }
  ctx.globalAlpha = maxAlpha;
  ctx.stroke();
  ctx.restore();
}

function drawPreview(s, ctx) {
  if (!s.preview || s.preview.points.length < 2) return;
  const pts = s.preview.points;
  const px = 1 / s.cam.scale;
  ctx.save();
  ctx.lineCap = 'round';
  const n = pts.length;
  const seg = Math.max(1, Math.floor(n / 190));
  for (let i = seg; i < n; i += seg) {
    const a = pts[i - seg], b = pts[i];
    if (Math.abs(b.x - a.x) > 260 || Math.abs(b.y - a.y) > 260) continue;
    const f = i / n;
    ctx.globalAlpha = 0.85 * (1 - f * 0.65);
    ctx.strokeStyle = s.preview.status === 'sunk' ? Palette.accent : Palette.accent2;
    ctx.lineWidth = (2.2 - f * 1.1) * px;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const tip = pts[n - 1];
  ctx.globalAlpha = 1;
  if (s.preview.status === 'sunk') {
    ctx.strokeStyle = Palette.accent;
    ctx.lineWidth = 2.4 * px;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, 13, 0, TAU); ctx.stroke();
  } else if (s.preview.status === 'crashed') {
    ctx.strokeStyle = Palette.hot;
    ctx.lineWidth = 2.4 * px;
    const k = 9;
    ctx.beginPath();
    ctx.moveTo(tip.x - k, tip.y - k); ctx.lineTo(tip.x + k, tip.y + k);
    ctx.moveTo(tip.x + k, tip.y - k); ctx.lineTo(tip.x - k, tip.y + k);
    ctx.stroke();
  } else {
    ctx.fillStyle = Palette.accent2;
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, 3.4 * px + 1, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawProbe(s, ctx) {
  const p = s.phase === 'fly' || s.phase === 'sunk' ? s.sim.probe : s.sim.start;
  const px = 1 / s.cam.scale;
  const idle = s.phase === 'aim' || s.phase === 'result';
  const pulse = idle ? 0.5 + 0.5 * Math.sin(s.t * 3.2) : 1;

  ctx.save();
  const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26);
  gr.addColorStop(0, 'rgba(255,200,87,0.55)');
  gr.addColorStop(1, 'rgba(255,200,87,0)');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(p.x, p.y, 26, 0, TAU); ctx.fill();

  ctx.fillStyle = Palette.warm;
  ctx.beginPath(); ctx.arc(p.x, p.y, PROBE_R, 0, TAU); ctx.fill();
  ctx.fillStyle = Palette.ink;
  ctx.beginPath(); ctx.arc(p.x - 1.2, p.y - 1.2, PROBE_R * 0.42, 0, TAU); ctx.fill();

  if (idle) {
    ctx.strokeStyle = Palette.warm;
    ctx.globalAlpha = 0.22 + pulse * 0.3;
    ctx.lineWidth = 1.4 * px;
    ctx.beginPath(); ctx.arc(p.x, p.y, PROBE_R + 6 + pulse * 5, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

function drawAim(s, ctx, g) {
  if (!s.drag.active || s.drag.pull <= 10) return;
  const px = 1 / s.cam.scale;
  const start = s.sim.start;
  const w = screenToWorld(s, g, s.drag.x, s.drag.y);
  const frac = clamp(s.drag.pull / pullMax(g), 0, 1);

  ctx.save();
  // rubber band back to the cursor
  ctx.strokeStyle = 'rgba(255,200,87,0.5)';
  ctx.lineWidth = 1.6 * px;
  ctx.setLineDash([6 * px, 6 * px]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(w.x, w.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,200,87,0.8)';
  ctx.beginPath(); ctx.arc(w.x, w.y, 4 * px + 1, 0, TAU); ctx.fill();

  // launch arrow
  const len = 40 + frac * 150;
  const ax = start.x + Math.cos(s.drag.angle) * len;
  const ay = start.y + Math.sin(s.drag.angle) * len;
  ctx.strokeStyle = Palette.accent;
  ctx.lineWidth = 2.6 * px;
  ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(ax, ay); ctx.stroke();
  const hw = 8;
  ctx.fillStyle = Palette.accent;
  ctx.beginPath();
  ctx.moveTo(ax + Math.cos(s.drag.angle) * 11, ay + Math.sin(s.drag.angle) * 11);
  ctx.lineTo(ax + Math.cos(s.drag.angle + 2.5) * hw, ay + Math.sin(s.drag.angle + 2.5) * hw);
  ctx.lineTo(ax + Math.cos(s.drag.angle - 2.5) * hw, ay + Math.sin(s.drag.angle - 2.5) * hw);
  ctx.closePath(); ctx.fill();

  // power ring around the tee
  ctx.strokeStyle = 'rgba(120,132,156,0.35)';
  ctx.lineWidth = 3 * px;
  ctx.beginPath(); ctx.arc(start.x, start.y, 22, -Math.PI / 2, -Math.PI / 2 + TAU); ctx.stroke();
  ctx.strokeStyle = frac > 0.92 ? Palette.hot : Palette.warm;
  ctx.beginPath(); ctx.arc(start.x, start.y, 22, -Math.PI / 2, -Math.PI / 2 + TAU * frac); ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- HUD

function drawHud(s, ctx, g) {
  const hole = HOLES[s.holeIndex];
  const num = String(s.holeIndex + 1).padStart(2, '0');

  text(ctx, `HOLE ${num}/${HOLE_COUNT}`, 14, 12, { size: 12, color: Palette.accent, weight: 700 });
  text(ctx, hole.name.toUpperCase(), 14, 28, { size: 11, color: Palette.ink, weight: 600 });
  text(ctx, `PAR ${hole.par}`, 118, 12, { size: 12, color: Palette.dim, weight: 600 });

  const best = s.bestHoles[s.holeIndex];
  if (best !== null && best !== undefined) {
    text(ctx, `BEST ${best}`, 118, 28, { size: 10, color: Palette.dim });
  }

  const parSoFar = HOLES.slice(0, s.holeIndex).reduce((n, h) => n + h.par, 0) + hole.par;
  const vs = s.totalStrokes - parSoFar;
  text(ctx, `STROKES ${s.strokes}`, g.w - 14, 12, { size: 12, color: Palette.warm, align: 'right', weight: 700 });
  text(ctx, `ROUND ${s.totalStrokes} · ${rel(vs)}`, g.w - 14, 28, {
    size: 11, align: 'right',
    color: vs < 0 ? Palette.accent : vs > 0 ? Palette.hot : Palette.dim,
  });
  if (s.bestRound !== null) {
    text(ctx, `BEST ROUND ${s.bestRound}`, g.w / 2, 12, { size: 10, color: Palette.dim, align: 'center' });
  }
  text(ctx, `TOTAL PAR ${TOTAL_PAR}`, g.w / 2, 27, { size: 10, color: Palette.dim, align: 'center', alpha: 0.7 });

  // hole progress pips
  const pipY = g.h - 17, pipW = Math.min(9, (g.w - 40) / HOLE_COUNT);
  for (let i = 0; i < HOLE_COUNT; i++) {
    const x = g.w / 2 - (HOLE_COUNT * pipW) / 2 + i * pipW;
    const done = s.scores[i] !== undefined;
    ctx.globalAlpha = i === s.holeIndex ? 1 : done ? 0.75 : 0.25;
    ctx.fillStyle = i === s.holeIndex ? Palette.warm
      : done ? (s.scores[i] <= HOLES[i].par ? Palette.accent : Palette.dim)
      : Palette.grid;
    ctx.fillRect(x, pipY, pipW - 2, 4);
  }
  ctx.globalAlpha = 1;

  if (s.messageT > 0 && s.message) {
    const a = clamp(s.messageT / 0.5, 0, 1);
    text(ctx, s.message, g.w / 2, g.h - 40, { size: 13, color: Palette.hot, align: 'center', weight: 700, alpha: a });
  } else if (s.hintT > 0 && s.phase === 'aim') {
    const a = clamp(s.hintT / 1.0, 0, 1);
    text(ctx, HOLES[s.holeIndex].hint, g.w / 2, g.h - 40, { size: 11, color: Palette.dim, align: 'center', alpha: a });
  } else if (s.phase === 'aim' && !s.drag.active) {
    const p = 0.5 + 0.5 * Math.sin(s.t * 2.6);
    text(ctx, 'DRAG BACK FROM THE PROBE TO LAUNCH', g.w / 2, g.h - 40, {
      size: 11, color: Palette.dim, align: 'center', alpha: 0.35 + p * 0.35,
    });
  } else if (s.phase === 'fly') {
    text(ctx, 'HOLD SPACE TO FAST-FORWARD', g.w / 2, g.h - 40, { size: 10, color: Palette.dim, align: 'center', alpha: 0.5 });
  }

  if (s.drag.active && s.drag.pull > 10) {
    const frac = clamp(s.drag.pull / pullMax(g), 0, 1);
    text(ctx, `${Math.round(frac * 100)}% POWER`, g.w / 2, g.h - 58, {
      size: 12, color: frac > 0.92 ? Palette.hot : Palette.warm, align: 'center', weight: 700,
    });
  }
}

function panel(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = 'rgba(9,11,18,0.9)';
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 12);
  ctx.stroke();
  ctx.restore();
}

function drawIntro(s, ctx, g) {
  ctx.fillStyle = 'rgba(7,8,13,0.88)';
  ctx.fillRect(0, 0, g.w, g.h);
  const cx = g.w / 2, cy = g.h / 2;
  const w = Math.min(560, g.w - 40), h = Math.min(320, g.h - 40);
  panel(ctx, cx - w / 2, cy - h / 2, w, h);

  const top = cy - h / 2;
  text(ctx, 'ORBITAL', cx, top + 34, { size: Math.min(44, w * 0.1), color: Palette.accent, align: 'center', weight: 700 });
  text(ctx, 'N-BODY GRAVITY GOLF', cx, top + 82, { size: 12, color: Palette.accent2, align: 'center', weight: 600 });
  text(ctx, 'Launch a probe. Real gravity does the rest.', cx, top + 112, { size: 13, color: Palette.ink, align: 'center' });
  text(ctx, 'Slingshot round planets, dodge black holes, dive through', cx, top + 138, { size: 11, color: Palette.dim, align: 'center' });
  text(ctx, 'wormholes. Sink it in the ring in as few strokes as you can.', cx, top + 156, { size: 11, color: Palette.dim, align: 'center' });

  text(ctx, 'DRAG back from the probe, release to fire', cx, top + 192, { size: 11, color: Palette.ink, align: 'center' });
  text(ctx, 'R reset hole  ·  SPACE fast-forward a flight', cx, top + 212, { size: 11, color: Palette.dim, align: 'center' });
  text(ctx, `${HOLE_COUNT} HOLES  ·  TOTAL PAR ${TOTAL_PAR}`, cx, top + 240, { size: 11, color: Palette.warm, align: 'center', weight: 600 });

  const p = 0.5 + 0.5 * Math.sin(s.t * 3);
  text(ctx, 'DRAG TO LAUNCH', cx, top + h - 34, {
    size: 15, color: Palette.warm, align: 'center', weight: 700, alpha: 0.35 + p * 0.65,
  });
}

function drawBanner(s, ctx, g) {
  if (!s.banner) return;
  const a = clamp(s.banner.t / 0.22, 0, 1) * clamp((s.resultT + 0.4) / 0.5, 0, 1);
  const cy = g.h * 0.32;
  const rise = (1 - clamp(s.banner.t / 0.35, 0, 1)) * 18;
  text(ctx, s.banner.title, g.w / 2, cy - rise, {
    size: Math.min(42, g.w * 0.07), color: s.banner.color, align: 'center', weight: 700, alpha: a,
  });
  text(ctx, s.banner.sub, g.w / 2, cy + 38 - rise, { size: 12, color: Palette.ink, align: 'center', alpha: a * 0.9 });
  text(ctx, 'ENTER for the next hole', g.w / 2, cy + 62 - rise, { size: 10, color: Palette.dim, align: 'center', alpha: a * 0.8 });
}

function drawRound(s, ctx, g) {
  ctx.fillStyle = 'rgba(7,8,13,0.9)';
  ctx.fillRect(0, 0, g.w, g.h);
  const cx = g.w / 2;
  const w = Math.min(620, g.w - 40), h = Math.min(400, g.h - 30);
  const top = g.h / 2 - h / 2;
  panel(ctx, cx - w / 2, top, w, h);

  const vs = s.totalStrokes - TOTAL_PAR;
  const m = medalFor(s.totalStrokes, TOTAL_PAR);
  text(ctx, 'ROUND COMPLETE', cx, top + 26, { size: 22, color: Palette.accent, align: 'center', weight: 700 });
  text(ctx, `${s.totalStrokes} STROKES  ·  PAR ${TOTAL_PAR}  ·  ${rel(vs)}`, cx, top + 60, {
    size: 15, color: vs <= 0 ? Palette.accent : Palette.warm, align: 'center', weight: 600,
  });
  text(ctx, s.roundBest ? 'NEW BEST ROUND' : `BEST ROUND ${s.bestRound}`, cx, top + 86, {
    size: 11, color: s.roundBest ? Palette.warm : Palette.dim, align: 'center', weight: 600,
  });

  // scorecard: two rows of nine
  const cardTop = top + 118;
  const colW = (w - 60) / 9;
  for (let row = 0; row < 2; row++) {
    const y = cardTop + row * 74;
    for (let i = 0; i < 9; i++) {
      const idx = row * 9 + i;
      const x = cx - w / 2 + 30 + i * colW + colW / 2;
      const sc = s.scores[idx];
      text(ctx, String(idx + 1), x, y, { size: 10, color: Palette.dim, align: 'center' });
      text(ctx, String(HOLES[idx].par), x, y + 16, { size: 10, color: Palette.grid === '' ? Palette.dim : '#5a657c', align: 'center' });
      const d = sc === undefined ? 0 : sc - HOLES[idx].par;
      text(ctx, sc === undefined ? '-' : String(sc), x, y + 34, {
        size: 15, align: 'center', weight: 700,
        color: sc === undefined ? Palette.dim : d < 0 ? Palette.accent : d === 0 ? Palette.ink : Palette.hot,
      });
    }
  }
  text(ctx, 'HOLE / PAR / SCORE', cx, cardTop + 152, { size: 9, color: Palette.dim, align: 'center', alpha: 0.6 });

  const p = 0.5 + 0.5 * Math.sin(s.t * 3);
  text(ctx, 'ENTER to play another round', cx, top + h - 26, {
    size: 12, color: Palette.warm, align: 'center', weight: 700, alpha: 0.4 + p * 0.6,
  });
}

// ---------------------------------------------------------------- render

function render(s, ctx, g) {
  const v = viewRect(g);

  // deep-space backdrop
  const bg = ctx.createLinearGradient(0, 0, 0, g.h);
  bg.addColorStop(0, '#080a12');
  bg.addColorStop(0.55, Palette.bg);
  bg.addColorStop(1, '#05060b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, g.w, g.h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(v.x, v.y, v.w, v.h);
  ctx.clip();

  ctx.save();
  ctx.translate(v.x + v.w / 2, v.y + v.h / 2);
  ctx.scale(s.cam.scale, s.cam.scale);
  ctx.translate(-s.cam.cx, -s.cam.cy);

  drawStars(s, ctx, g);
  drawBounds(s, ctx);
  drawField(s, ctx);

  // ghosts of earlier attempts on this hole — the whole "so close" loop lives here
  for (let i = 0; i < s.ghosts.length; i++) {
    drawTrail(s, ctx, s.ghosts[i], Palette.dim, 0.06 + 0.03 * i, 1.2);
  }
  if (s.lastTrail) drawTrail(s, ctx, s.lastTrail, Palette.hot, 0.3, 1.5);

  drawGoal(s, ctx);
  for (const b of s.sim.bodies) drawBody(s, ctx, b);

  if (s.phase === 'fly' || s.phase === 'sunk') {
    drawTrail(s, ctx, s.sim.trail, Palette.warm, 0.85, 2.2);
  }

  drawPreview(s, ctx);
  drawProbe(s, ctx);
  drawAim(s, ctx, g);

  FX.draw(ctx);
  ctx.restore();
  ctx.restore();

  if (s.warpFlash > 0) {
    ctx.globalAlpha = s.warpFlash * 0.16;
    ctx.fillStyle = Palette.violet;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalAlpha = 1;
  }

  drawHud(s, ctx, g);
  if (s.phase === 'sunk') drawBanner(s, ctx, g);
  if (s.phase === 'intro') drawIntro(s, ctx, g);
  if (s.phase === 'round') drawRound(s, ctx, g);
}

// ---------------------------------------------------------------- boot

const game = boot({ id: 'orbital', title: 'Orbital', seed: 1, init, update, render });

// ---------------------------------------------------------------- self-test

registerSelftest('orbital', (check, log) => {
  const dt = 1 / 60;

  // ---- 1. the world initializes: all 18 holes parse, with a tee and a goal
  let structureOk = true;
  const problems = [];
  for (let i = 0; i < HOLE_COUNT; i++) {
    const h = HOLES[i];
    const sim = makeSim(i);
    if (!h.start || !h.goal || !(h.goal.r > 0) || !h.bodies || !h.par) { structureOk = false; problems.push(`${i}:shape`); continue; }
    if (sim.bodies.length !== h.bodies.length) { structureOk = false; problems.push(`${i}:bodies`); }
    // the tee must be in open space — not already inside the goal or a body
    const dg = Math.hypot(h.start.x - h.goal.x, h.start.y - h.goal.y);
    if (dg <= h.goal.r + PROBE_R) { structureOk = false; problems.push(`${i}:tee-in-goal`); }
    for (const b of sim.bodies) {
      const d = Math.hypot(h.start.x - b.px, h.start.y - b.py);
      if (d <= b.r + PROBE_R + 4) { structureOk = false; problems.push(`${i}:tee-in-body`); }
      if (b.type === 'wormhole' && !(b.link >= 0 && b.link < sim.bodies.length && sim.bodies[b.link].type === 'wormhole')) {
        structureOk = false; problems.push(`${i}:bad-link`);
      }
    }
    if (h.start.x < h.bounds.x || h.start.x > h.bounds.x + h.bounds.w) { structureOk = false; problems.push(`${i}:tee-oob`); }
  }
  check(`all ${HOLE_COUNT} holes parse with a clear tee + goal`, structureOk && HOLE_COUNT === 18,
    problems.slice(0, 4).join(',') || `${HOLE_COUNT} holes, total par ${TOTAL_PAR}`);

  // ---- 2. the probe responds to injected input: a LIVE drag produces a real launch
  game.restart();
  game.state.phase = 'aim';
  snapCam(game.state, game);
  const st = game.state;
  const teeScreen = worldToScreen(st, game, st.sim.start.x, st.sim.start.y);
  const pullPx = powerToPull(400, game);
  game.input.pointDown(teeScreen.x + pullPx * 0.7071, teeScreen.y + pullPx * 0.7071); // pull down-right
  game.step(1);
  const draggingPreview = !!game.state.preview;
  game.input.pointTo(teeScreen.x + pullPx * 0.7071, teeScreen.y + pullPx * 0.7071);
  game.step(1);
  game.input.pointUp();
  game.step(1);
  const v0 = Math.hypot(game.state.sim.probe.vx, game.state.sim.probe.vy);
  check('injected pointer drag launches the probe with real velocity',
    game.state.phase === 'fly' && v0 > 200,
    `phase=${game.state.phase} |v|=${v0.toFixed(1)} aimed=${(game.state.sim.launchAngle * 180 / Math.PI).toFixed(1)}deg`);
  check('a live drag produces a forward-simulated trajectory preview', draggingPreview,
    draggingPreview ? 'preview computed while dragging' : 'no preview');

  // ---- 3. a progress event fires: strokes increment, and a hole actually completes
  check('launching counts a stroke', game.state.strokes === 1 && game.state.totalStrokes === 1,
    `strokes=${game.state.strokes} total=${game.state.totalStrokes}`);

  // drive the LIVE game all the way to a sink using hole 1's verified launch
  game.restart();
  game.state.phase = 'aim';
  snapCam(game.state, game);
  const sol = HOLES[0].solution;
  const tee = worldToScreen(game.state, game, game.state.sim.start.x, game.state.sim.start.y);
  const pl = powerToPull(sol.p, game);
  const px0 = tee.x - Math.cos(sol.a) * pl, py0 = tee.y - Math.sin(sol.a) * pl;
  game.input.pointDown(px0, py0);
  game.step(1);
  game.input.pointUp(px0, py0);
  game.step(1);
  let guard = 0;
  while (game.state.phase === 'fly' && guard++ < 1200) game.step(1);
  check('live game reaches the SUNK state from a pointer drag',
    game.state.phase === 'sunk' && game.state.scores[0] === 1,
    `phase=${game.state.phase} score=${game.state.scores[0]} frames=${guard}`);

  // ---- 4. WIN is reachable everywhere: replay every hole's solver-verified launch
  let sunkCount = 0;
  const missed = [];
  for (let i = 0; i < HOLE_COUNT; i++) {
    const r = replaySolution(i, HOLES[i].solution);
    if (r.status === 'sunk') sunkCount++;
    else missed.push(`${i + 1}:${r.status}`);
  }
  check('every hole has a verified launch that sinks', sunkCount === HOLE_COUNT,
    `${sunkCount}/${HOLE_COUNT}${missed.length ? ' failed ' + missed.join(',') : ''}`);

  // ---- 5. LOSE is reachable: fly straight into hole 1's planet, and it costs a stroke
  const crash = flightResult(0, 0, MAX_POWER);
  check('flying into a planet crashes the probe', crash.status === 'crashed',
    `status=${crash.status} after ${crash.frames} frames`);
  const bh = flightResult(6, 0, MAX_POWER * 0.55);
  check('a black hole is lethal / a bad shot never sinks', bh.status !== 'sunk', `status=${bh.status}`);

  game.restart();
  game.state.phase = 'aim';
  snapCam(game.state, game);
  const tee2 = worldToScreen(game.state, game, game.state.sim.start.x, game.state.sim.start.y);
  const pl2 = powerToPull(MAX_POWER, game);
  game.input.pointDown(tee2.x - pl2, tee2.y);   // dead ahead into the planet
  game.step(1);
  game.input.pointUp(tee2.x - pl2, tee2.y);
  game.step(1);
  let g2 = 0;
  while (game.state.phase === 'fly' && g2++ < 1200) game.step(1);
  const crashedLive = game.state.phase === 'result';
  while (game.state.phase === 'result' && g2++ < 1400) game.step(1);
  check('a crash costs a stroke and returns to the tee',
    crashedLive && game.state.strokes === 1 && game.state.phase === 'aim',
    `crashed=${crashedLive} strokes=${game.state.strokes} phase=${game.state.phase}`);

  // ---- 6. gravity sims are NaN factories: prove finiteness over a long chaotic run
  let frames = 0;
  const chaos = [];
  for (let i = 0; i < HOLE_COUNT; i++) {
    const sim = makeSim(i);
    const ang = (i * 0.37) % TAU;
    launchSim(sim, ang, MIN_POWER + ((i * 97) % 400));
    for (let k = 0; k < 60; k++) { stepSim(sim, dt); frames++; }
    chaos.push(sim);
  }
  // and one long single flight that grazes a black hole at full power
  const deep = makeSim(9);
  launchSim(deep, 0.02, MAX_POWER);
  for (let k = 0; k < 400; k++) { stepSim(deep, dt); frames++; }
  chaos.push(deep);
  const fin = allFinite(chaos.map((c) => ({ probe: c.probe, t: c.flightTime, bodies: c.bodies.map((b) => ({ x: b.px, y: b.py })) })));
  check(`no NaN/Infinity after ${frames} simulated frames`, fin.ok && frames >= 600,
    `frames=${frames} bad=${fin.bad.slice(0, 3).join(',')}`);

  // and the live game state stays clean too
  game.restart();
  game.state.phase = 'aim';
  for (let k = 0; k < 120; k++) game.step(1);
  const finLive = allFinite({ cam: game.state.cam, sim: game.state.sim, drag: game.state.drag });
  check('live game state stays finite', finLive.ok, finLive.bad.slice(0, 3).join(','));

  // ---- 7. the solver still finds a shot from scratch (proves solve() is live, not a fossil)
  const fresh = solve(2, { angles: 60, powers: 12, refine: false });
  check('solve() rediscovers a sinking launch for hole 3 from scratch', fresh.ok,
    `hits=${fresh.hits}/${fresh.tried}`);

  game.restart();
  log(`holes=${HOLE_COUNT} totalPar=${TOTAL_PAR} verifiedSinkable=${sunkCount}`);
});

// dev console handles
globalThis.__orbital = {
  solve, predict, makeSim, stepSim, launch: launchSim, flightResult, replaySolution,
  HOLES, previewSteps,
  solveAll(opts) {
    const out = [];
    for (let i = 0; i < HOLE_COUNT; i++) out.push(solve(i, opts));
    return out;
  },
};

export default game;
