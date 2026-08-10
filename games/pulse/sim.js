// Pulse — the runner simulation.
//
// Pure and DOM-free, exactly like compose.js: no Math.random(), no Date.now(), no
// canvas. The live game and the self-test both drive THIS function, so what you can
// prove headlessly is what actually happens on screen.
//
//   makeSim(seedString)            -> sim
//   stepSim(sim, intent, dt)       -> sim      intent = { jump, held, slide? }
//
// `dt` is the effective time delta: the fixed 1/60 accumulator when there is no
// audio, or the delta read off AudioContext.currentTime when the song is playing.

import { compose, PHYS } from './compose.js';

const {
  G, JUMP_V, DIVE_V, SLIDE_T, STAND_H, SLIDE_H, CUT,
  PERFECT_W, GOOD_W, INVULN, LIVES, DIVE_DELAY,
} = PHYS;

const MAX_H = 0.02;            // never integrate more than 20ms at once (no tunnelling)
const NEUTRAL = { jump: false, held: false, slide: false };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function makeSim(seedString) {
  const song = compose(seedString);
  return {
    seed: song.seed,
    song,
    chart: song.chart,
    cues: song.cues,

    t: 0,
    y: 0, vy: 0,
    grounded: true, diving: false, slide: 0, jumpHeld: false,
    squash: 0, run: 0,

    lives: LIVES, invuln: 0,
    score: 0, combo: 0, maxCombo: 0, mult: 1,
    perfect: 0, good: 0, missed: 0, cleared: 0, hits: 0, strays: 0,

    obPtr: 0, cuePtr: 0, notePtr: 0,
    obDone: new Uint8Array(song.chart.length),
    cueDone: new Uint8Array(song.cues.length),

    kickP: 0, snareP: 0, hatP: 0, leadP: 0, bassP: 0, leadFreq: 440,
    lastJudge: '', judgeAge: 9, judgeDelta: 0,
    flash: 0,

    dead: false, won: false, frames: 0,
    events: [],
  };
}

export function playerHeight(sim) {
  return sim.slide > 0 && sim.grounded ? SLIDE_H : STAND_H;
}

function judgePress(sim) {
  const cues = sim.cues;
  let best = -1, bestD = GOOD_W + 1e-9;
  for (let i = sim.cuePtr; i < cues.length; i++) {
    if (cues[i].time > sim.t + GOOD_W) break;
    if (sim.cueDone[i]) continue;
    const d = Math.abs(cues[i].time - sim.t);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) { sim.strays++; return; }
  sim.cueDone[best] = 1;
  const rank = bestD <= PERFECT_W ? 'perfect' : 'good';
  if (rank === 'perfect') { sim.perfect++; sim.score += 300 * sim.mult; }
  else { sim.good++; sim.score += 120 * sim.mult; }
  sim.combo++;
  if (sim.combo > sim.maxCombo) sim.maxCombo = sim.combo;
  sim.mult = 1 + Math.min(7, Math.floor(sim.combo / 6));
  sim.lastJudge = rank;
  sim.judgeAge = 0;
  sim.judgeDelta = sim.t - cues[best].time;
  sim.events.push({ type: 'judge', rank, delta: sim.judgeDelta });
}

function substep(sim, intent, dt) {
  const cues = sim.cues;
  const chart = sim.chart;
  const notes = sim.song.notes;

  // --- 1. cues that sailed past unpressed are misses
  while (sim.cuePtr < cues.length && cues[sim.cuePtr].time < sim.t - GOOD_W) {
    if (!sim.cueDone[sim.cuePtr]) {
      sim.cueDone[sim.cuePtr] = 1;
      sim.missed++;
      sim.combo = 0; sim.mult = 1;
      sim.events.push({ type: 'miss' });
    }
    sim.cuePtr++;
  }

  // --- 2. input
  if (intent.jump) {
    if (sim.grounded) {
      sim.vy = JUMP_V;
      sim.grounded = false;
      sim.jumpHeld = true;
      sim.slide = 0;
      sim.events.push({ type: 'jump' });
    } else if (!sim.diving) {
      sim.diving = true;
      sim.vy = -DIVE_V;
      sim.jumpHeld = false;
      sim.events.push({ type: 'dive' });
    }
    judgePress(sim);
  } else if (intent.slide && sim.grounded && sim.slide <= 0) {
    // optional ground-slide alias (ArrowDown / Shift). The chart never requires it —
    // every obstacle is clearable with the single jump button alone.
    sim.slide = SLIDE_T;
    sim.events.push({ type: 'slam' });
    judgePress(sim);
  }
  if (sim.jumpHeld && !intent.held) {
    if (sim.vy > 0) sim.vy *= CUT;
    sim.jumpHeld = false;
  }

  // --- 3. vertical physics
  if (!sim.grounded) {
    sim.vy -= G * dt;
    sim.y += sim.vy * dt;
    if (sim.y <= 0) {
      sim.y = 0; sim.vy = 0; sim.grounded = true; sim.jumpHeld = false;
      sim.squash = 1;
      if (sim.diving) { sim.diving = false; sim.slide = SLIDE_T; sim.events.push({ type: 'slam' }); }
      else sim.events.push({ type: 'land' });
    }
  }
  if (sim.slide > 0) { sim.slide -= dt; if (sim.slide < 0) sim.slide = 0; }

  // --- 4. clock
  sim.t += dt;
  sim.run += dt;

  // --- 5. the note table drives the visuals (and the sound, via synth.js)
  while (sim.notePtr < notes.length && notes[sim.notePtr].time <= sim.t) {
    const n = notes[sim.notePtr++];
    switch (n.kind) {
      case 'kick': sim.kickP = 1; sim.events.push({ type: 'kick', v: n.velocity }); break;
      case 'snare': sim.snareP = 1; sim.events.push({ type: 'snare' }); break;
      case 'hat': if (sim.hatP < 0.6) sim.hatP = 0.6; break;
      case 'lead': sim.leadP = 1; sim.leadFreq = n.freq; sim.events.push({ type: 'lead', freq: n.freq }); break;
      case 'bass': sim.bassP = 1; break;
      default: break;
    }
  }

  // --- 6. obstacles
  const ph = playerHeight(sim);
  while (sim.obPtr < chart.length && chart[sim.obPtr].t + chart[sim.obPtr].w / 2 < sim.t) {
    const i = sim.obPtr;
    if (!sim.obDone[i]) {
      sim.obDone[i] = 1;
      sim.cleared++;
      sim.score += 40 * sim.mult;
      sim.events.push({ type: 'clear', ob: i, kind: chart[i].type });
    }
    sim.obPtr++;
  }
  for (let i = sim.obPtr; i < chart.length; i++) {
    const o = chart[i];
    if (o.t - o.w / 2 > sim.t) break;
    if (sim.obDone[i]) continue;
    if (sim.invuln > 0) { sim.obDone[i] = 1; continue; }
    const hit = o.type === 'pit'
      ? sim.y <= 0.5
      : (sim.y < o.top && sim.y + ph > o.bottom);
    if (!hit) continue;
    sim.obDone[i] = 1;
    sim.hits++;
    sim.lives--;
    sim.combo = 0; sim.mult = 1;
    sim.invuln = INVULN;
    sim.flash = 1;
    sim.events.push({ type: 'hit', ob: i, kind: o.type });
    if (sim.lives <= 0) {
      sim.lives = 0;
      sim.dead = true;
      sim.events.push({ type: 'dead' });
    }
  }

  // --- 7. decay
  const k = (rate) => Math.pow(rate, dt);
  sim.kickP *= k(0.004);
  sim.snareP *= k(0.0015);
  sim.hatP *= k(0.00002);
  sim.leadP *= k(0.006);
  sim.bassP *= k(0.02);
  sim.flash *= k(0.002);
  sim.squash *= k(0.00001);
  if (sim.invuln > 0) { sim.invuln -= dt; if (sim.invuln < 0) sim.invuln = 0; }
  sim.judgeAge += dt;

  if (!sim.dead && !sim.won && sim.t >= sim.song.duration + 1.2) {
    sim.won = true;
    sim.score += sim.lives * 500;
    sim.events.push({ type: 'win' });
  }
}

/** One tick. `dt` may be any positive delta; it is internally substepped. */
export function stepSim(sim, intent, dt) {
  sim.events.length = 0;
  if (sim.dead || sim.won) return sim;
  const inten = intent || NEUTRAL;
  let remain = clamp(dt, 0, 0.5);
  let first = true;
  for (;;) {
    const h = Math.min(remain, MAX_H);
    substep(sim, first ? inten : NEUTRAL, h);
    remain -= h;
    first = false;
    if (remain <= 1e-6 || sim.dead || sim.won) break;
  }
  sim.frames++;
  return sim;
}

// ---------------------------------------------------------------- scripted optimal player
//
// Presses exactly on every cue and holds past the apex. Used by the self-test to
// prove a chart is beatable with ONE button — the same evidence verifyChart()
// derives analytically, but obtained by actually playing the level.

export function makeAuto(sim) {
  return { presses: sim.cues.map((c) => c.time), i: 0, holdUntil: -1 };
}

export function autoIntent(auto, sim) {
  let jump = false;
  if (auto.i < auto.presses.length && sim.t >= auto.presses[auto.i]) {
    jump = true;
    auto.holdUntil = sim.t + DIVE_DELAY + 0.05;
    auto.i++;
  }
  return { jump, held: jump || sim.t < auto.holdUntil, slide: false };
}

/** Play a seed to the end with the scripted player. Returns the finished sim. */
export function autoRun(seedString, { dt = 1 / 60, maxFrames = 20000 } = {}) {
  const sim = typeof seedString === 'string' ? makeSim(seedString) : seedString;
  const auto = makeAuto(sim);
  let f = 0;
  while (!sim.won && !sim.dead && f++ < maxFrames) stepSim(sim, autoIntent(auto, sim), dt);
  return sim;
}

/** Play a seed with no input at all. Returns the finished sim. */
export function idleRun(seedString, { dt = 1 / 60, maxFrames = 20000 } = {}) {
  const sim = typeof seedString === 'string' ? makeSim(seedString) : seedString;
  let f = 0;
  while (!sim.won && !sim.dead && f++ < maxFrames) stepSim(sim, NEUTRAL, dt);
  return sim;
}

export { PHYS };
