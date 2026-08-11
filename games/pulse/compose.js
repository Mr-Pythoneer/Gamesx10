// Pulse — the composer.
//
// PURE and DOM-free on purpose: `compose(seed)` is the single source of truth for
// BOTH the music and the level. The synth schedules the note table; the chart is
// derived from that same table. Sync is therefore structural, not tuned.
//
// Nothing in this file may call Math.random(), Date.now(), or touch the DOM.
// Same seed in => byte-identical song and chart out, forever.

// ---------------------------------------------------------------- seeded RNG (mulberry32, same as shared/kit.js)

export class Rng {
  constructor(seed = 1) { this.seed(seed); }
  seed(s) {
    this.s = (typeof s === 'string' ? Rng.hash(s) : s >>> 0) || 1;
    return this;
  }
  static hash(str) {
    let h = 2166136261 >>> 0;
    const t = String(str);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n) % Math.max(1, n); }
  intRange(a, b) { return a + this.int(b - a + 1); }
  pick(arr) { return arr[this.int(arr.length)]; }
  bool(p = 0.5) { return this.next() < p; }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- physics contract
//
// The chart builder and the runner simulation MUST agree, so the numbers live here
// and game.js/sim.js import them. Vertical units are abstract "units" (ground = 0);
// horizontal distance is expressed in SECONDS of song time, so the chart is
// resolution independent and the canvas can be any size.

const G = 2100;          // gravity, units/s^2
const JUMP_V = 560;      // launch velocity, units/s
const DIVE_V = 1400;     // downward slam velocity, units/s
const SLIDE_T = 0.55;    // seconds spent crouched after a slam landing
const T_JUMP = (2 * JUMP_V) / G;              // 0.5333 s of airtime for a full jump
const APEX = (JUMP_V * JUMP_V) / (2 * G);     // 74.67 units
const DIVE_DELAY = T_JUMP / 2;                // slam at the apex

/** Time from launch until the jump arc first reaches height h. */
function tRise(h) {
  const disc = JUMP_V * JUMP_V - 2 * G * h;
  if (disc <= 0) return T_JUMP / 2;
  return (JUMP_V - Math.sqrt(disc)) / G;
}

/** Fall time from height h with an initial downward speed v0. */
function tFall(h, v0) {
  return (-v0 + Math.sqrt(v0 * v0 + 2 * G * h)) / G;
}

const SPIKE_H = 40;      // spike tip height — feet must be above this
const CEIL_BOTTOM = 22;  // underside of a low ceiling
const STAND_H = 34;      // player box height, running
const SLIDE_H = 15;      // player box height, crouched
const PLAYER_W_T = 0.07; // player box width, in seconds of travel

// Obstacle widths in seconds — these ALREADY include the player's own width,
// so a hit is simply |simTime - obstacle.t| < w/2.
// Narrower than the visual obstacle footprint on purpose — the actual hitbox is
// what determines the physics coverage window (`a.tol` below), and jump timing
// was reported too punishing, so these were shrunk to give a much wider margin
// for an early/late press to still clear safely.
const W_SPIKE = 0.10;
const W_PIT = 0.22;
const W_CEIL = 0.18;

const SPIKE_RISE = tRise(SPIKE_H);                 // 0.0850
const PIT_RISE = tRise(2);                         // ~0.0036 (feet just off the floor)
const SLAM_FALL = tFall(APEX, DIVE_V);             // 0.0514
const SLIDE_START = DIVE_DELAY + SLAM_FALL;        // when the crouch begins, after the cue

// Per-type action model: press at `cue`, protected for [cue+coverA, cue+coverB],
// busy (unable to act again) for `busy` seconds, obstacle centred at cue+offset.
const ACTIONS = {
  spike: { coverA: SPIKE_RISE, coverB: T_JUMP - SPIKE_RISE, busy: T_JUMP, w: W_SPIKE, cues: 1 },
  pit: { coverA: PIT_RISE, coverB: T_JUMP - PIT_RISE, busy: T_JUMP, w: W_PIT, cues: 1 },
  ceiling: { coverA: SLIDE_START, coverB: SLIDE_START + SLIDE_T, busy: SLIDE_START + SLIDE_T, w: W_CEIL, cues: 2 },
};
for (const k of Object.keys(ACTIONS)) {
  const a = ACTIONS[k];
  a.offset = (a.coverA + a.coverB) / 2;         // press on the beat => obstacle dead centre
  a.tol = (a.coverB - a.coverA - a.w) / 2;      // how far off the beat you may still be
}

/** Recovery gap the chart builder leaves after an action before the next cue. */
const MARGIN = 0.1;
/** Judgement windows, in seconds off the cue. */
const PERFECT_W = 0.10;
const GOOD_W = 0.20;

export const PHYS = {
  G, JUMP_V, DIVE_V, SLIDE_T, T_JUMP, APEX, DIVE_DELAY,
  SPIKE_H, CEIL_BOTTOM, STAND_H, SLIDE_H, PLAYER_W_T,
  W_SPIKE, W_PIT, W_CEIL, SLIDE_START,
  MARGIN, PERFECT_W, GOOD_W, ACTIONS,
  CUT: 0.42,          // velocity kept when the button is released early
  INVULN: 1.0,
  LIVES: 3,
};

// ---------------------------------------------------------------- music theory

export const SCALES = [
  { name: 'minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'aeolian', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'phrygian dominant', steps: [0, 1, 4, 5, 7, 8, 10] },
  { name: 'blues', steps: [0, 3, 5, 6, 7, 10] },
  { name: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const PROGRESSIONS = [
  [0, 5, 3, 4],
  [0, 3, 4, 4],
  [0, 6, 5, 4],
  [0, 4, 5, 3],
  [0, 2, 3, 4],
  [0, 5, 1, 4],
  [0, 0, 3, 4],
];

// One bar = 16 sixteenth-note slots.
const KICKS = [
  '1000001000100000',
  '1000100010001000',
  '1001000010010000',
  '1000000010000010',
  '1000001010000100',
];
const SNARES = [
  '0000100000001000',
  '0000100000001001',
  '0000100001001000',
  '0000100000101000',
];
const HATS = [
  '1010101010101010',
  '1111111111111111',
  '1010101110101011',
  '0010001000100010',
  '1011101010111010',
];
const RHYTHMS = [
  [0, 4, 6, 10, 12],
  [0, 3, 6, 8, 12, 14],
  [0, 4, 8, 12],
  [0, 2, 6, 8, 11, 14],
  [0, 4, 7, 10, 12],
  [2, 4, 8, 10, 14],
  [0, 6, 8, 12],
  [0, 1, 4, 8, 10, 12],
];
const FILLS = [
  [0, 2, 4, 6, 8, 10, 12, 13, 14, 15],
  [0, 3, 4, 7, 8, 11, 12, 14],
  [4, 6, 8, 10, 12, 13, 14, 15],
  [0, 2, 4, 8, 10, 12, 14, 15],
];
const BASSES = [
  [0, 6, 8, 14],
  [0, 4, 8, 12],
  [0, 3, 6, 8, 11, 14],
  [0, 8, 10, 12],
  [0, 2, 8, 10],
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Diatonic degree -> midi. Degrees wrap through octaves, so -3 and +11 both work. */
function degToMidi(scale, root, degree) {
  const n = scale.steps.length;
  const oct = Math.floor(degree / n);
  const idx = degree - oct * n;
  return root + oct * 12 + scale.steps[idx];
}

// ---------------------------------------------------------------- the composer

const SECTIONS = [
  { name: 'intro', bars: 4, lead: false, drums: 0.45, lift: 0 },
  { name: 'verse', bars: 8, lead: true, drums: 1, lift: 0 },
  { name: 'lift', bars: 8, lead: true, drums: 1, lift: 12 },
  { name: 'verse2', bars: 8, lead: true, drums: 1, lift: 0 },
  { name: 'outro', bars: 4, lead: true, drums: 0.7, lift: 12 },
];

/**
 * compose(seedString, difficulty = 0) -> { bpm, key, scale, notes, chart, cues, ... }
 *
 * `notes` is the note table: a flat, time-sorted array of
 *   { time, dur, freq, kind, velocity, ... }
 * with kind in kick|snare|hat|bass|lead|pad. Everything else is derived from it.
 *
 * `difficulty` is a pure, deterministic tuning knob in [0, 1] — 0 is the original
 * free-play feel, 1 is the hardest the fairness verifier still allows. It nudges
 * tempo, note density and how tightly the chart packs obstacles. It never touches
 * Math.random()/Date.now(), so (seed, difficulty) -> byte-identical output, forever.
 */
export function compose(seedString, difficulty = 0) {
  const seed = String(seedString == null ? '' : seedString).toUpperCase() || 'PULSE';
  const diff = clamp(Number(difficulty) || 0, 0, 1);
  const rng = new Rng(seed);

  const bpm = Math.round(90 + rng.int(71) + diff * 34); // 90..~195 as difficulty climbs
  const spb = 60 / bpm;                          // seconds per beat
  const s16 = spb / 4;                           // seconds per sixteenth
  const barDur = spb * 4;

  const scale = SCALES[rng.int(SCALES.length)];
  const rootPc = rng.int(12);
  const root = 36 + rootPc;                      // bass register, C2..B2
  const prog = PROGRESSIONS[rng.int(PROGRESSIONS.length)];
  const kickPat = KICKS[rng.int(KICKS.length)];
  const snarePat = SNARES[rng.int(SNARES.length)];
  const hatPat = HATS[rng.int(HATS.length)];
  const bassPat = BASSES[rng.int(BASSES.length)];
  const cellA = RHYTHMS[rng.int(RHYTHMS.length)];
  const cellB = RHYTHMS[rng.int(RHYTHMS.length)];
  const fill = FILLS[rng.int(FILLS.length)];
  const swing = rng.bool(0.35) ? 0.16 : 0;       // shuffle the offbeat sixteenths

  // The motif: one contour of diatonic offsets, reused and varied all song long.
  const motif = [];
  let walk = 0;
  for (let i = 0; i < Math.max(cellA.length, cellB.length) + 2; i++) {
    walk = clamp(walk + rng.intRange(-2, 3), -2, 8);
    motif.push(walk);
  }

  const notes = [];
  const push = (n) => { notes.push(n); return n; };
  const swingOf = (step) => (swing && step % 2 === 1 ? swing * s16 : 0);

  let bar = 0;
  for (let si = 0; si < SECTIONS.length; si++) {
    const sec = SECTIONS[si];
    for (let b = 0; b < sec.bars; b++, bar++) {
      const t0 = bar * barDur;
      const chordDeg = prog[b % prog.length];
      const phraseEnd = b % 4 === 3;
      const cell = (si === 2 ? cellB : cellA);

      // --- drums
      for (let st = 0; st < 16; st++) {
        const tt = t0 + st * s16 + swingOf(st);
        if (kickPat[st] === '1' && rng.next() < sec.drums + 0.15) {
          push({ time: tt, dur: 0.24, freq: 52, kind: 'kick', velocity: st === 0 ? 1 : 0.85, step: st, bar });
        }
        if (snarePat[st] === '1' && sec.drums > 0.5) {
          // Difficulty widens which backbeat hits become pit obstacles: more bars
          // qualify and the step window relaxes from "second half only" downward.
          const snareBarMod = diff > 0.6 ? 1 : 2;
          const snareStMin = 8 - Math.round(diff * 4);
          push({
            time: tt, dur: 0.18, freq: 196, kind: 'snare', velocity: 0.9, step: st, bar,
            strong: si >= 1 && bar % snareBarMod === (snareBarMod === 1 ? 0 : 1) && st >= snareStMin,
          });
        }
        if (hatPat[st] === '1' && rng.next() < sec.drums) {
          push({ time: tt, dur: 0.05, freq: 8200, kind: 'hat', velocity: st % 4 === 0 ? 0.5 : 0.3, step: st, bar });
        }
      }

      // --- pad: the chord, one sustained triad per bar
      for (let k = 0; k < 3; k++) {
        const midi = degToMidi(scale, root + 24, chordDeg + k * 2);
        push({ time: t0, dur: barDur * 0.94, freq: mtof(midi), kind: 'pad', velocity: 0.3, midi, bar, step: 0 });
      }

      // --- bass: chord root, plus one long note at the end of every phrase
      const bassRoot = degToMidi(scale, root, chordDeg);
      if (phraseEnd) {
        for (const st of bassPat) {
          if (st >= 8) break;
          const midi = bassRoot + (st === 0 ? 0 : (rng.bool(0.25) ? 12 : 0));
          push({ time: t0 + st * s16, dur: s16 * 1.6, freq: mtof(midi), kind: 'bass', velocity: 0.85, midi, bar, step: st });
        }
        const midi = bassRoot;
        push({
          time: t0 + 8 * s16, dur: spb * 2, freq: mtof(midi), kind: 'bass',
          velocity: 0.95, midi, bar, step: 8, sustain: si >= 1,
        });
      } else {
        const fifthDeg = scale.steps.length >= 7 ? 4 : 3;   // diatonic, so always in key
        for (const st of bassPat) {
          const r = st === 0 ? 1 : rng.next();
          const midi = r < 0.22 ? degToMidi(scale, root, chordDeg + fifthDeg)
            : r < 0.42 ? bassRoot + 12
              : bassRoot;
          push({
            time: t0 + st * s16 + swingOf(st), dur: s16 * 1.7, freq: mtof(midi),
            kind: 'bass', velocity: st === 0 ? 0.95 : 0.75, midi, bar, step: st,
          });
        }
      }

      // --- lead: motif, varied per bar, fill at the end of each phrase
      if (sec.lead) {
        const useFill = phraseEnd && rng.bool(0.6);
        const onsets = useFill ? fill : cell;
        const variation = b % 4;
        for (let i = 0; i < onsets.length; i++) {
          const st = onsets[i];
          let off = motif[i % motif.length];
          if (variation === 1) off += 1;
          else if (variation === 2) off = motif[(motif.length - 1 - (i % motif.length))];
          else if (variation === 3 && !useFill) off += (i % 2 ? 2 : 0);
          const midi = degToMidi(scale, root + 36 + sec.lift, chordDeg + off);
          const next = i + 1 < onsets.length ? onsets[i + 1] : 16;
          // Difficulty coarsens the strong-beat grid from every quarter note down to
          // every eighth, doubling spike candidates on the hardest stages.
          const strong = diff > 0.6 ? st % 2 === 0 : st % 4 === 0;
          push({
            time: t0 + st * s16 + swingOf(st),
            dur: Math.min(4, next - st) * s16 * 0.92,
            freq: mtof(midi), kind: 'lead',
            velocity: strong ? 1 : 0.72,
            midi, bar, step: st, strong: strong && si >= 1,
          });
        }
      }
    }
  }

  notes.sort((a, b) => (a.time - b.time) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  const bars = SECTIONS.reduce((a, s) => a + s.bars, 0);
  const duration = bars * barDur;

  const song = {
    seed,
    difficulty: diff,
    bpm, spb, s16, barDur, bars, duration, swing,
    key: NOTE_NAMES[rootPc],
    keyMidi: root,
    scale: scale.name,
    scaleSteps: scale.steps.slice(),
    progression: prog.slice(),
    notes,
  };

  // Difficulty also tightens the packer itself: less breathing room between
  // obstacles means more of the same candidates survive fits() below. The packer
  // (fits) and the verifier (verifyChart) share ACTIONS/MARGIN as the single source
  // of truth for what's reachable, so any packing this produces is still provably fair.
  song.chart = buildChart(song, { marginScale: 1 - 0.4 * diff, rampScale: 1 - 0.7 * diff });
  song.cues = buildCues(song.chart);
  return song;
}

// ---------------------------------------------------------------- chart derivation

/** Extra breathing room early in the song — the difficulty ramp. */
function rampGap(t, duration, scale = 1) {
  const p = clamp(t / Math.max(1, duration), 0, 1);
  return scale * 0.55 * (1 - p) * (1 - p);
}

function makeEntry(type, cue) {
  const a = ACTIONS[type];
  return {
    type,
    cue,
    cue2: a.cues > 1 ? cue + DIVE_DELAY : -1,
    t: cue + a.offset,
    w: a.w,
    tol: a.tol,
    busy: a.busy,
    top: type === 'spike' ? SPIKE_H : (type === 'ceiling' ? 400 : 0),
    bottom: type === 'ceiling' ? CEIL_BOTTOM : 0,
  };
}

/** Would placing `e` keep every neighbour reachable by an optimal player? */
function fits(list, e, duration, marginScale, rampScale) {
  let i = 0;
  while (i < list.length && list[i].cue < e.cue) i++;
  const prev = list[i - 1];
  const next = list[i];
  const margin = MARGIN * marginScale;
  const gapBefore = margin + rampGap(e.cue, duration, rampScale);
  if (prev && e.cue < prev.cue + prev.busy + margin + rampGap(prev.cue, duration, rampScale)) return -1;
  if (next && next.cue < e.cue + e.busy + gapBefore) return -1;
  return i;
}

/**
 * The chart IS the note table, filtered:
 *   lead notes on strong beats -> spikes you jump
 *   backbeat snares            -> pits you clear
 *   sustained bass             -> low ceilings you slam-slide under
 * Candidates that an optimal player could not physically reach are dropped, so the
 * result is completable by construction — and verifyChart() proves it independently.
 */
export function buildChart(song, opts = {}) {
  const { notes, duration, barDur } = song;
  const marginScale = opts.marginScale === undefined ? 1 : opts.marginScale;
  const rampScale = opts.rampScale === undefined ? 1 : opts.rampScale;
  const leadIn = Math.max(barDur * 2, 3.2);

  const ceilings = [];
  const others = [];
  for (const n of notes) {
    if (n.time < leadIn) continue;
    if (n.kind === 'bass' && n.sustain) ceilings.push({ type: 'ceiling', cue: n.time });
    else if (n.kind === 'snare' && n.strong) others.push({ type: 'pit', cue: n.time });
    else if (n.kind === 'lead' && n.strong) others.push({ type: 'spike', cue: n.time });
  }

  const out = [];
  // Ceilings first: they are rare, expensive and the most interesting move.
  for (const c of ceilings) {
    if (c.cue + ACTIONS.ceiling.busy > duration - 0.6) continue;
    const e = makeEntry(c.type, c.cue);
    const i = fits(out, e, duration, marginScale, rampScale);
    if (i >= 0) out.splice(i, 0, e);
  }
  for (const c of others) {
    if (c.cue + ACTIONS[c.type].busy > duration - 0.6) continue;
    const e = makeEntry(c.type, c.cue);
    const i = fits(out, e, duration, marginScale, rampScale);
    if (i >= 0) out.splice(i, 0, e);
  }

  for (let i = 0; i < out.length; i++) out[i].i = i;
  return out;
}

function buildCues(chart) {
  const cues = [];
  for (const o of chart) {
    cues.push({ time: o.cue, ob: o.i, kind: 'jump' });
    if (o.cue2 >= 0) cues.push({ time: o.cue2, ob: o.i, kind: 'slam' });
  }
  cues.sort((a, b) => a.time - b.time);
  for (let i = 0; i < cues.length; i++) cues[i].i = i;
  return cues;
}

// ---------------------------------------------------------------- fairness verifier
//
// Walks the chart with an optimal-player model: for each obstacle the player presses
// as early as the cover window allows, is "busy" (airborne or crouched) for the
// action's duration, and cannot act again until then. If the schedule is impossible,
// or an obstacle is wider than the protection it grants, the chart is unfair.

export function verifyChart(chart, opts = {}) {
  const eps = opts.eps === undefined ? 1e-9 : opts.eps;
  const problems = [];
  let busyEnd = -Infinity;
  let prevCue = -Infinity;

  for (let i = 0; i < chart.length; i++) {
    const o = chart[i];
    const a = ACTIONS[o.type];
    if (!a) { problems.push(`#${i} unknown type ${o.type}`); continue; }
    if (!(o.cue > prevCue)) problems.push(`#${i} cues out of order (${o.cue} <= ${prevCue})`);
    if (!Number.isFinite(o.cue) || !Number.isFinite(o.t)) problems.push(`#${i} non-finite times`);
    // 1. is the obstacle even clearable in isolation?
    const cover = a.coverB - a.coverA;
    if (cover < o.w + eps) problems.push(`#${i} ${o.type} wider (${o.w.toFixed(3)}s) than its cover (${cover.toFixed(3)}s)`);
    if (!(o.tol > 0.02)) problems.push(`#${i} ${o.type} timing window ${o.tol.toFixed(4)}s too tight`);
    // 2. is the obstacle centred where a press on the cue actually protects you?
    const lo = o.t - o.w / 2, hi = o.t + o.w / 2;
    if (o.cue + a.coverA > lo + eps || o.cue + a.coverB < hi - eps) {
      problems.push(`#${i} ${o.type} not covered by a press on its cue`);
    }
    // 3. can the player have recovered from the previous action in time?
    if (o.cue < busyEnd - eps) {
      problems.push(`#${i} ${o.type} cue at ${o.cue.toFixed(3)}s but player is busy until ${busyEnd.toFixed(3)}s`);
    }
    // 4. the second cue of a slam must land while still airborne
    if (o.cue2 >= 0 && !(o.cue2 > o.cue && o.cue2 < o.cue + T_JUMP)) {
      problems.push(`#${i} slam cue outside the jump arc`);
    }
    prevCue = o.cue;
    busyEnd = o.cue + o.busy;
  }

  return { ok: problems.length === 0, problems, count: chart.length };
}

/** Convenience: compose + verify in one call. */
export function verifySeed(seedString, difficulty = 0) {
  const song = compose(seedString, difficulty);
  const v = verifyChart(song.chart);
  return { song, ...v };
}

export { ACTIONS, degToMidi, mtof, NOTE_NAMES };
