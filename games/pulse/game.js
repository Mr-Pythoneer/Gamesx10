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
  Type, HUD_H, hudStrip, stat, panel, meter, orb, vignette, titleCard, withGlow,
  T, mountLangToggle, registerTranslations,
} from '../../shared/kit.js';
import { compose, verifyChart, PHYS } from './compose.js';
import { makeSim, stepSim, autoRun, idleRun, playerHeight } from './sim.js';
import { Sequencer } from './synth.js';

registerTranslations({
  'SCORE': { es: 'PUNTOS', fr: 'SCORE', ja: 'スコア', ko: '점수' },
  'LIVES': { es: 'VIDAS', fr: 'VIES', ja: 'ライフ', ko: '목숨' },
  'COMBO': { es: 'COMBO', fr: 'COMBO', ja: 'コンボ', ko: '콤보' },
  'MULT': { es: 'MULT', fr: 'MULT', ja: '倍率', ko: '배율' },
  'STAGE': { es: 'ETAPA', fr: 'NIVEAU', ja: 'ステージ', ko: '스테이지' },
  'SEED': { es: 'SEMILLA', fr: 'GRAINE', ja: 'シード', ko: '시드' },
  'BPM': { es: 'BPM', fr: 'BPM', ja: 'BPM', ko: 'BPM' },
  'KEY': { es: 'TONO', fr: 'TON', ja: '調', ko: '조성' },
  'PERFECT': { es: 'PERFECTO', fr: 'PARFAIT', ja: 'パーフェクト', ko: '퍼펙트' },
  'GOOD': { es: 'BIEN', fr: 'BIEN', ja: 'グッド', ko: '굿' },
  'MUTED': { es: 'SILENCIADO', fr: 'MUET', ja: 'ミュート中', ko: '음소거됨' },
  'CAMPAIGN': { es: 'CAMPAÑA', fr: 'CAMPAGNE', ja: 'キャンペーン', ko: '캠페인' },
  'ARROWS move  ·  SPACE play  ·  ESC back': {
    es: 'FLECHAS mover  ·  ESPACIO jugar  ·  ESC volver',
    fr: 'FLÈCHES déplacer  ·  ESPACE jouer  ·  ÉCHAP retour',
    ja: '矢印キーで移動  ·  SPACEでプレイ  ·  ESCで戻る',
    ko: '방향키 이동  ·  SPACE 플레이  ·  ESC 뒤로',
  },
  'PULSE': { es: 'PULSE', fr: 'PULSE', ja: 'パルス', ko: '펄스' },
  'The seed writes the song.': {
    es: 'La semilla escribe la canción.',
    fr: 'La graine écrit la chanson.',
    ja: 'シードが曲を書く。',
    ko: '시드가 노래를 만든다.',
  },
  'The seed writes the song. The song writes the level.': {
    es: 'La semilla escribe la canción. La canción escribe el nivel.',
    fr: 'La graine écrit la chanson. La chanson écrit le niveau.',
    ja: 'シードが曲を書き、曲がレベルを書く。',
    ko: '시드가 노래를 만들고, 노래가 레벨을 만든다.',
  },
  'SPACE / CLICK — jump  (hold for height)': {
    es: 'ESPACIO / CLIC — saltar  (mantén para más altura)',
    fr: 'ESPACE / CLIC — sauter  (maintenir pour plus de hauteur)',
    ja: 'SPACE / クリック — ジャンプ(長押しで高く)',
    ko: 'SPACE / 클릭 — 점프  (누르고 있으면 더 높이)',
  },
  'SPACE again midair — slam down and slide under': {
    es: 'ESPACIO de nuevo en el aire — caída y deslizamiento por debajo',
    fr: 'ESPACE à nouveau en l’air — plaquage au sol et glissade',
    ja: '空中で再度SPACE — 急降下して滑り込む',
    ko: '공중에서 다시 SPACE — 내리찍고 미끄러지기',
  },
  'PRESS SPACE  ·  L for Campaign': {
    es: 'PULSA ESPACIO  ·  L para Campaña',
    fr: 'APPUYEZ SUR ESPACE  ·  L pour Campagne',
    ja: 'SPACEを押す  ·  Lでキャンペーン',
    ko: 'SPACE 누르기  ·  L 캠페인',
  },
  'TRACK CLEARED': { es: 'PISTA SUPERADA', fr: 'MORCEAU TERMINÉ', ja: 'トラッククリア', ko: '트랙 클리어' },
  'RUN ENDED': { es: 'PARTIDA TERMINADA', fr: 'PARTIE TERMINÉE', ja: 'ラン終了', ko: '런 종료' },
  'SPACE next  ·  L stage select  ·  ESC free play': {
    es: 'ESPACIO siguiente  ·  L selección de etapa  ·  ESC juego libre',
    fr: 'ESPACE suivant  ·  L sélection du niveau  ·  ÉCHAP jeu libre',
    ja: 'SPACEで次へ  ·  Lでステージ選択  ·  ESCでフリープレイ',
    ko: 'SPACE 다음  ·  L 스테이지 선택  ·  ESC 자유 플레이',
  },
  'SPACE retry  ·  N new seed  ·  S type a seed  ·  C copy  ·  L Campaign': {
    es: 'ESPACIO reintentar  ·  N nueva semilla  ·  S escribir semilla  ·  C copiar  ·  L Campaña',
    fr: 'ESPACE réessayer  ·  N nouvelle graine  ·  S saisir une graine  ·  C copier  ·  L Campagne',
    ja: 'SPACEでリトライ  ·  Nで新しいシード  ·  Sでシード入力  ·  Cでコピー  ·  Lでキャンペーン',
    ko: 'SPACE 재시도  ·  N 새 시드  ·  S 시드 입력  ·  C 복사  ·  L 캠페인',
  },
  'FINAL SCORE': { es: 'PUNTUACIÓN FINAL', fr: 'SCORE FINAL', ja: '最終スコア', ko: '최종 점수' },
  'seed': { es: 'semilla', fr: 'graine', ja: 'シード', ko: '시드' },
});

const { SPIKE_H, CEIL_BOTTOM, PLAYER_W_T, LIVES } = PHYS;

const SEED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const START_SEED = 'PULSE1';

// ---------------------------------------------------------------- campaign
//
// 50 curated, fixed stages: a seed plus a difficulty (0..1, fed straight into
// compose()) with an escalating curve. Every one of them was found by generating
// candidate seeds and keeping only those where verifyChart() passes AND a scripted
// one-button run (autoRun) actually clears it with zero hits/misses AND doing
// nothing (idleRun) actually dies — see the throwaway verification script whose
// output is reproduced in the PR notes. This list is the result, frozen.
const STAGES = [
  { seed: 'S9DGH9', difficulty: 0 },
  { seed: 'SG929H', difficulty: 0.0204 },
  { seed: 'SP4M2S', difficulty: 0.0408 },
  { seed: 'SWX8S3', difficulty: 0.0612 },
  { seed: 'S5STKC', difficulty: 0.0816 },
  { seed: 'SCNECM', difficulty: 0.102 },
  { seed: 'SKHZ4V', difficulty: 0.1224 },
  { seed: 'SSCLV6', difficulty: 0.1429 },
  { seed: 'SZ76MF', difficulty: 0.1633 },
  { seed: 'S82REQ', difficulty: 0.1837 },
  { seed: 'SFWC7Y', difficulty: 0.2041 },
  { seed: 'SNRXX9', difficulty: 0.2245 },
  { seed: 'SVLJQJ', difficulty: 0.2449 },
  { seed: 'S4F5GT', difficulty: 0.2653 },
  { seed: 'SBBQ93', difficulty: 0.2857 },
  { seed: 'SJ6A2C', difficulty: 0.3061 },
  { seed: 'SRZVSM', difficulty: 0.3265 },
  { seed: 'SYUGKW', difficulty: 0.3469 },
  { seed: 'S7P3B7', difficulty: 0.3673 },
  { seed: 'SEKN4F', difficulty: 0.3878 },
  { seed: 'SME9UQ', difficulty: 0.4082 },
  { seed: 'SU9TMZ', difficulty: 0.4286 },
  { seed: 'S34EEA', difficulty: 0.449 },
  { seed: 'SAYZ6J', difficulty: 0.4694 },
  { seed: 'SHTLXT', difficulty: 0.4898 },
  { seed: 'SQN7P4', difficulty: 0.5102 },
  { seed: 'SXHSGD', difficulty: 0.5306 },
  { seed: 'S6CD9M', difficulty: 0.551 },
  { seed: 'SD8XZW', difficulty: 0.5714 },
  { seed: 'SL3JS7', difficulty: 0.5918 },
  { seed: 'STW5JG', difficulty: 0.6122 },
  { seed: 'S2RQBR', difficulty: 0.6327 },
  { seed: 'S9LB4Z', difficulty: 0.6531 },
  { seed: 'SGGWUA', difficulty: 0.6735 },
  { seed: 'SPBHMK', difficulty: 0.6939 },
  { seed: 'SW63DU', difficulty: 0.7143 },
  { seed: 'S5ZN64', difficulty: 0.7347 },
  { seed: 'SCV9WD', difficulty: 0.7551 },
  { seed: 'SKQUPN', difficulty: 0.7755 },
  { seed: 'SSKFGX', difficulty: 0.7959 },
  { seed: 'SZE287', difficulty: 0.8163 },
  { seed: 'S89LZG', difficulty: 0.8367 },
  { seed: 'SF57RR', difficulty: 0.8571 },
  { seed: 'SNYSJ2', difficulty: 0.8776 },
  { seed: 'SVTDBB', difficulty: 0.898 },
  { seed: 'S4NY3K', difficulty: 0.9184 },
  { seed: 'SBJKUU', difficulty: 0.9388 },
  { seed: 'SJD6L5', difficulty: 0.9592 },
  { seed: 'SR8QDE', difficulty: 0.9796 },
  { seed: 'SY3B6N', difficulty: 1 },
];

// ---------------------------------------------------------------- layout

function layout(g) {
  // The HUD strip owns the top 56px; the playfield starts underneath it and is
  // clipped to that region, so nothing ever renders behind the status bar.
  const hudH = HUD_H;
  const groundY = Math.round(g.h * 0.74);
  const pxPerSec = clamp(g.w / 3.1, 150, 560);
  const vScale = clamp((groundY - 44) / 230, 0.55, 3.4);
  const playerX = Math.round(g.w * 0.27);
  const bandLo = hudH + 26;
  const bandTop = clamp(Math.min(g.h * 0.12, groundY - SPIKE_H * vScale - 90),
    bandLo, Math.max(bandLo, groundY - 60));
  const bandBot = clamp(groundY - 150 * vScale * 0.55, bandTop + 24, Math.max(bandTop + 24, groundY - 20));
  const horizonY = Math.round(hudH + (groundY - hudH) * 0.62);
  return {
    hudH, groundY, pxPerSec, vScale, playerX, bandTop, bandBot, horizonY,
    compact: g.w < 760,
    u: clamp(Math.min(g.w / 960, g.h / 600), 0.55, 1.35),
  };
}

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}

// Render-only integer hash: gives the starfield and the skyline stable positions
// without touching the simulation or calling Math.random().
function h01(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 2246822519) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 3266489917) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
const imod = (n, m) => ((n % m) + m) % m;

// Monospace advance is ~0.6em; measuring this way keeps HUD layout identical
// headless and in the browser.
const mw = (str, size) => String(str).length * size * 0.6;
const labelW = (str) => String(str).length * (Type.label * 0.6 + Type.label * 0.14);

// ---------------------------------------------------------------- state

const seq = new Sequencer(Sound);

// Set right before g.restart() so init() knows whether this run is a Campaign
// stage (and at what difficulty) or an ordinary free-play seed. Cleared on read.
let pendingStage = null;

function clampUnlocked(n) { return clamp(Math.round(n) || 1, 1, STAGES.length); }

function init(g) {
  const stage = pendingStage; pendingStage = null;
  const seed = String((stage ? stage.entry.seed : g.seed) || START_SEED).toUpperCase();
  const difficulty = stage ? stage.entry.difficulty : 0;
  const sim = makeSim(seed, difficulty);
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
    phase: 'intro',          // intro | select | play | over | win
    leadLo: lo, leadHi: hi,
    seedEdit: false,
    seedBuf: '',
    introT: 0,
    copied: 0,
    hint: 0,
    overT: 0,
    noAudio: false,
    best: Store.get('best', 0),
    seedBest: Store.get('seed:' + seed, 0),
    muted: Sound.muted,
    // --- Campaign
    campaign: stage ? stage.index : -1,          // -1 = free play, else index into STAGES
    unlocked: clampUnlocked(Store.get('campaignUnlocked', 1)),
    stageBest: stage ? Store.get('stageBest:' + stage.index, 0) : 0,
    selectIdx: clamp(clampUnlocked(Store.get('campaignUnlocked', 1)) - 1, 0, STAGES.length - 1),
    justUnlocked: false,
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
  pendingStage = null; // free-play restart always clears any pending campaign launch
  g.restart(seed === undefined ? g.seed : String(seed).toUpperCase());
  const s = g.state;
  s.phase = 'play';
  s.hint = 4;
  startAudio(s);
}

/** Launch Campaign stage `index` (0-based). Must be <= state.unlocked - 1. */
function startStage(g, index) {
  const entry = STAGES[index];
  if (!entry) return;
  seq.stop();
  pendingStage = { index, entry };
  g.restart(entry.seed);
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

/** Campaign stage-select screen: left/right/up/down move the cursor, ESC backs out. */
function selectUpdate(s, dt, g) {
  const I = g.input;
  const cols = 10;
  if (I.justPressed('left')) s.selectIdx = Math.max(0, s.selectIdx - 1);
  if (I.justPressed('right')) s.selectIdx = Math.min(s.unlocked - 1, s.selectIdx + 1);
  if (I.justPressed('up')) s.selectIdx = Math.max(0, s.selectIdx - cols);
  if (I.justPressed('down')) s.selectIdx = Math.min(s.unlocked - 1, s.selectIdx + cols);
  if (I.justPressed('esc')) { s.phase = 'intro'; return; }
  if (I.justPressed('space') || I.justPressed('enter') || I.pointerPressed) {
    startStage(g, clamp(s.selectIdx, 0, s.unlocked - 1));
  }
}

function update(s, dt, g) {
  const I = g.input;
  if (s.copied > 0) s.copied -= dt;
  if (s.hint > 0) s.hint -= dt;

  if (s.seedEdit) { seedTyping(s, g); return; }

  if (s.phase === 'select') { selectUpdate(s, dt, g); return; }

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
  if (I.justPressed('l') && (s.phase === 'intro' || s.phase === 'over' || s.phase === 'win')) {
    s.phase = 'select';
    s.selectIdx = clamp(s.campaign >= 0 ? s.campaign : s.unlocked - 1, 0, STAGES.length - 1);
    return;
  }

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
    if (I.justPressed('esc') && s.campaign >= 0) { s.phase = 'intro'; return; }
    if (I.justPressed('space') || I.justPressed('enter') || I.pointerPressed) {
      if (s.campaign >= 0 && s.phase === 'win' && s.campaign + 1 < STAGES.length) startStage(g, s.campaign + 1);
      else if (s.campaign >= 0) startStage(g, s.campaign);
      else restartRun(g, s.seed);
    }
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
    if (s.campaign >= 0) Store.best('stageBest:' + s.campaign, sim.score);
  } else if (sim.won && s.phase === 'play') {
    s.phase = 'win'; s.overT = 0;
    Sound.ok();
    Store.best('best', sim.score);
    Store.best('seed:' + s.seed, sim.score);
    s.best = Store.get('best', 0);
    s.seedBest = Store.get('seed:' + s.seed, 0);
    Store.set('cleared', Store.get('cleared', 0) + 1);
    if (s.campaign >= 0) {
      Store.best('stageBest:' + s.campaign, sim.score);
      s.stageBest = Store.get('stageBest:' + s.campaign, 0);
      const next = clampUnlocked(s.campaign + 2); // stage index+1 is now reachable (1-based unlock count)
      s.justUnlocked = Store.best('campaignUnlocked', next);
      s.unlocked = clampUnlocked(Store.get('campaignUnlocked', 1));
    }
  }
}

// ---------------------------------------------------------------- render

function drawSky(s, ctx, g) {
  const grd = ctx.createLinearGradient(0, 0, 0, g.h);
  grd.addColorStop(0, Palette.bg);
  grd.addColorStop(0.62, Palette.bg2);
  grd.addColorStop(1, '#05060a');
  ctx.save();
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.restore();
}

// --- atmosphere: everything between the HUD and the track. Deterministic — it is
// the composed note table and sim.t, never new randomness — and deliberately low
// contrast so the runner, the notes and the spikes always win the eye.

/** Slow drifting dust so the sky is a place, not a void. */
function drawStars(s, ctx, g, L) {
  const n = L.compact ? 26 : 46;
  const top = L.hudH + 10;
  const span = Math.max(20, L.horizonY - 26 - top);
  const drift = s.sim.t * L.pxPerSec * 0.018;
  ctx.save();
  for (let i = 0; i < n; i++) {
    const x = imod(h01(i * 7 + 11) * g.w - drift, g.w);
    const y = top + h01(i * 13 + 5) * span;
    const tw = 0.5 + 0.5 * Math.sin(g.t * (0.7 + h01(i) * 1.6) + i * 1.7);
    ctx.globalAlpha = 0.07 + tw * 0.15;
    ctx.fillStyle = i % 5 === 0 ? Palette.accent2 : Palette.ink;
    const sz = i % 3 === 0 ? 2 : 1;
    ctx.fillRect(Math.round(x), Math.round(y), sz, sz);
  }
  ctx.restore();
}

/** Reused scratch — the analyser must not allocate 60 times a second. */
const SPEC = new Float64Array(32);

/**
 * The analyser. Every bar is a real slice of the song: notes that sounded in the
 * last 0.6s are binned by frequency, so the kick pumps the left of the sky, the
 * hats sparkle on the right and the lead walks the middle. Bounded work per frame —
 * a binary search plus the handful of notes inside the window.
 */
function drawSpectrum(s, ctx, g, L) {
  const sim = s.sim;
  const notes = sim.song.notes;
  const N = L.compact ? 16 : 28;
  const WIN = 0.6;
  for (let b = 0; b < N; b++) SPEC[b] = 0;
  const t = sim.t;
  for (let i = lowerBound(notes, t - WIN); i < notes.length; i++) {
    const n = notes[i];
    if (n.time > t) break;
    const w = 1 - (t - n.time) / WIN;
    if (w <= 0) continue;
    const f = clamp(Math.log2(Math.max(24, n.freq) / 40) / 8.2, 0, 0.9999);
    SPEC[Math.min(N - 1, Math.floor(f * N))] += w * w * (n.velocity || 0.5);
  }

  const base = L.horizonY;
  const maxH = Math.max(24, base - L.hudH - 18);
  const cw = g.w / N;
  const bw = Math.max(3, cw * 0.62);
  ctx.save();
  for (let b = 0; b < N; b++) {
    const idle = 0.05 + 0.035 * Math.sin(g.t * 1.1 + b * 0.7);
    const lvl = clamp(SPEC[b] / 1.7, 0, 1);
    const hh = (idle + lvl * 0.9) * maxH;
    const x = b * cw + (cw - bw) / 2;
    ctx.fillStyle = b < N * 0.3 ? Palette.violet : (b < N * 0.68 ? Palette.accent2 : Palette.accent);
    ctx.globalAlpha = 0.06 + lvl * 0.12;
    ctx.fillRect(x, base - hh, bw, hh);
    ctx.globalAlpha = 0.12 + lvl * 0.32;
    ctx.fillRect(x, base - hh - 2, bw, 2);
    ctx.globalAlpha = 0.04 + lvl * 0.06;       // reflection on the far plane
    ctx.fillRect(x, base + 1, bw, hh * 0.28);
  }
  ctx.restore();
}

/**
 * Parallax silhouettes. Heights come from the seed's own chord progression and
 * scale, so every song stands in a different skyline; the two layers scroll at
 * different rates to give the scene depth.
 */
function drawSkyline(s, ctx, g, L, spacing, par, maxFrac, fill, alpha, cap) {
  const song = s.sim.song;
  const prog = song.progression;
  const steps = song.scaleSteps;
  const sp = Math.max(34, spacing * L.u);
  const scroll = s.sim.t * L.pxPerSec * par;
  const first = Math.floor(scroll / sp) - 1;
  const count = Math.min(56, Math.ceil(g.w / sp) + 3);
  const maxH = Math.max(16, (L.horizonY - L.hudH) * maxFrac);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  for (let k = 0; k < count; k++) {
    const idx = first + k;
    const d = prog[imod(idx, prog.length)];
    const st = steps[imod(idx * 5 + d, steps.length)];
    const hh = Math.round((0.24 + (st / 11) * 0.76) * maxH);
    const w = Math.round(sp * (0.34 + imod(idx * 3 + st, 3) * 0.13));
    ctx.fillRect(Math.round(idx * sp - scroll), L.horizonY - hh, w, hh + 1);
  }
  if (cap) {
    ctx.globalAlpha = alpha * (0.5 + s.sim.kickP * 0.9);
    ctx.fillStyle = cap;
    for (let k = 0; k < count; k++) {
      const idx = first + k;
      const d = prog[imod(idx, prog.length)];
      const st = steps[imod(idx * 5 + d, steps.length)];
      const hh = Math.round((0.24 + (st / 11) * 0.76) * maxH);
      const w = Math.round(sp * (0.34 + imod(idx * 3 + st, 3) * 0.13));
      ctx.fillRect(Math.round(idx * sp - scroll), L.horizonY - hh, w, 1);
    }
  }
  ctx.restore();
}

/** The horizon itself: a bass-fed wash, a hard line, and a light at the strike point. */
function drawHorizon(s, ctx, g, L) {
  const sim = s.sim;
  const y = L.horizonY;
  const gh = Math.max(30, (y - L.hudH) * 0.55);
  ctx.save();
  const gr = ctx.createLinearGradient(0, y - gh, 0, y);
  gr.addColorStop(0, 'rgba(160,107,255,0)');
  gr.addColorStop(1, sim.bassP > 0.4 ? 'rgba(160,107,255,0.17)' : 'rgba(59,167,255,0.13)');
  ctx.globalAlpha = 0.5 + sim.kickP * 0.4;
  ctx.fillStyle = gr;
  ctx.fillRect(0, y - gh, g.w, gh);
  ctx.globalAlpha = 0.35 + sim.kickP * 0.35;
  ctx.fillStyle = Palette.accent2;
  ctx.fillRect(0, y, g.w, 1);
  ctx.restore();
  orb(ctx, L.playerX, y, 4 + sim.kickP * 9, 'rgba(59,167,255,0.20)', { glow: 0.9, rim: false });
}

/** Ground plane between the horizon and the track — lines flow toward the camera. */
function drawGroundPlane(s, ctx, g, L) {
  const depth = Math.max(1, L.groundY - L.horizonY);
  const flow = (s.sim.t * 0.5) % 1;
  ctx.save();
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  for (let k = 0; k < 8; k++) {
    const f = (k + flow) / 8;
    const y = L.horizonY + depth * f * f;
    ctx.globalAlpha = 0.05 + f * 0.17;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(g.w, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAtmosphere(s, ctx, g, L) {
  drawStars(s, ctx, g, L);
  drawSpectrum(s, ctx, g, L);
  drawSkyline(s, ctx, g, L, 58, 0.05, 0.5, Palette.grid, 0.55, 'rgba(59,167,255,0.35)');
  drawSkyline(s, ctx, g, L, 104, 0.14, 0.8, '#080a11', 0.92, 'rgba(160,107,255,0.30)');
  drawHorizon(s, ctx, g, L);
  drawGroundPlane(s, ctx, g, L);
}

function drawBackdrop(s, ctx, g, L, beat) {
  const sim = s.sim;

  // ground glow — breathes on every kick
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
      const cTop = Math.max(2, L.bandTop - 14);
      ctx.globalAlpha = done ? 0.28 : 0.7 + near * 0.3;
      ctx.fillStyle = Palette.violet;
      roundRect(ctx, cx - vw / 2, cTop, vw, Math.max(8, yb - cTop), 4);
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
  const compact = L.compact;

  hudStrip(ctx, g);

  // where you are in the track, along the bottom edge of the strip
  meter(ctx, 0, HUD_H - 3, g.w, 3, clamp(sim.t / Math.max(1, song.duration), 0, 1),
    { color: Palette.accent, track: 'rgba(255,255,255,0.05)', radius: 0, glow: false });

  // --- left cluster: the run
  const scoreStr = String(sim.score).padStart(6, '0');
  const scoreLabel = T('SCORE', '分数');
  stat(ctx, 18, 20, scoreLabel, scoreStr, { color: Palette.ink });
  let lx = 18 + Math.max(mw(scoreStr, Type.value), labelW(scoreLabel)) + 28;

  // lives: the label comes from stat() so the typography matches, the value is pips
  const livesLabel = T('LIVES', '生命');
  stat(ctx, lx, 20, livesLabel, '', { color: Palette.hot });
  const pipW = 11, pipGap = 5;
  for (let i = 0; i < LIVES; i++) {
    const alive = i < sim.lives;
    const px = lx + i * (pipW + pipGap);
    if (alive) {
      withGlow(ctx, Palette.hot, 9, () => {
        ctx.fillStyle = Palette.hot;
        roundRect(ctx, px, 34, pipW, 11, 3);
        ctx.fill();
      });
    } else {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = Palette.dim;
      roundRect(ctx, px, 34, pipW, 11, 3);
      ctx.fill();
      ctx.restore();
    }
  }
  lx += Math.max(LIVES * (pipW + pipGap) - pipGap, labelW(livesLabel)) + 28;

  if (!compact) {
    const comboV = String(sim.combo);
    const comboLabel = T('COMBO', '连击');
    stat(ctx, lx, 20, comboLabel, comboV, {
      valueSize: Type.body, color: sim.combo > 0 ? Palette.ink : Palette.dim,
    });
    lx += Math.max(mw(comboV, Type.body), labelW(comboLabel)) + 24;
    const multV = 'x' + sim.mult;
    const multLabel = T('MULT', '倍率');
    stat(ctx, lx, 20, multLabel, multV, {
      valueSize: Type.body, color: sim.mult > 1 ? Palette.warm : Palette.dim,
    });
    lx += Math.max(mw(multV, Type.body), labelW(multLabel));
  }

  // --- right cluster: the song. Laid out right to left, dropping the least
  // important stat first when the two clusters would collide.
  let rx = g.w - 18;
  const seedSize = compact ? Type.body : Type.value;
  if (s.campaign >= 0) {
    const stageLabel = T('STAGE', '关卡');
    const stageV = `${s.campaign + 1}/${STAGES.length}`;
    stat(ctx, rx, 20, stageLabel, stageV, { align: 'right', color: Palette.accent, valueSize: seedSize });
    rx -= Math.max(mw(stageV, seedSize), labelW(stageLabel)) + 26;
  } else {
    const seedLabel = T('SEED', '种子');
    stat(ctx, rx, 20, seedLabel, s.seed, { align: 'right', color: Palette.accent, valueSize: seedSize });
    rx -= Math.max(mw(s.seed, seedSize), labelW(seedLabel)) + 26;
  }

  const bpmV = String(song.bpm);
  const bpmLabel = T('BPM', 'BPM');
  const bpmW = Math.max(mw(bpmV, Type.body), labelW(bpmLabel));
  if (rx - bpmW > lx + 16) {
    stat(ctx, rx, 20, bpmLabel, bpmV, { align: 'right', valueSize: Type.body });
    rx -= bpmW + 26;
  }

  // the full mode name if it fits, otherwise just the tonic, otherwise nothing
  const keyLabel = T('KEY', '调性');
  const keyFull = `${song.key} ${song.scale.toUpperCase()}`;
  for (const keyV of (mw(keyFull, Type.body) < g.w * 0.3 ? [keyFull, song.key] : [song.key])) {
    const keyW = Math.max(mw(keyV, Type.body), labelW(keyLabel));
    if (rx - keyW > lx + 16) {
      stat(ctx, rx, 20, keyLabel, keyV, { align: 'right', valueSize: Type.body });
      break;
    }
  }

  // judgement pop
  if (sim.judgeAge < 0.5 && sim.lastJudge) {
    const a = clamp(1 - sim.judgeAge / 0.5, 0, 1);
    const rise = (1 - a) * 26;
    const perfect = sim.lastJudge === 'perfect';
    text(ctx, perfect ? T('PERFECT', '完美') : T('GOOD', '良好'),
      L.playerX, L.groundY - (86 + 44 * u) - rise, {
        size: perfect ? Type.value : Type.body,
        color: perfect ? Palette.accent : Palette.accent2,
        align: 'center', weight: 700, alpha: a,
      });
  }

  if (s.hint > 0 && s.phase === 'play') {
    text(ctx, 'SPACE on the marker  ·  SPACE again in midair to slam-slide',
      g.w / 2, g.h - 20, { size: Type.label, color: Palette.dim, align: 'center', alpha: clamp(s.hint, 0, 1) * 0.9 });
  }
  if (s.copied > 0) {
    const a = clamp(s.copied, 0, 1);
    const label = `SEED ${s.seed} COPIED`;
    const w = mw(label, Type.small) + 44;
    ctx.save();
    ctx.globalAlpha = a;
    panel(ctx, (g.w - w) / 2, HUD_H + 16, w, 34, { glowColor: Palette.accent, glowBlur: 18 });
    ctx.restore();
    text(ctx, label, g.w / 2, HUD_H + 38, {
      size: Type.small, color: Palette.accent, align: 'center', baseline: 'alphabetic', weight: 700, alpha: a,
    });
  }
  if (s.muted) text(ctx, T('MUTED', '已静音'), 18, g.h - 20, { size: Type.micro, color: Palette.dim });
}

/** Campaign stage-select grid: unlocked stages are tappable tiles, locked ones dim. */
function drawSelect(s, ctx, g, L) {
  const cx = g.w / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(7,8,13,0.9)';
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.restore();

  text(ctx, T('CAMPAIGN', '战役'), cx, L.hudH + 46, {
    size: Type.big, color: Palette.accent, align: 'center', weight: 700,
  });
  text(ctx, T(`${s.unlocked}/${STAGES.length} unlocked`, `已解锁 ${s.unlocked}/${STAGES.length}`), cx, L.hudH + 72, {
    size: Type.small, color: Palette.dim, align: 'center',
  });

  const cols = Math.min(10, Math.max(5, Math.floor((g.w - 40) / 64)));
  const cell = Math.min(58, Math.floor((g.w - 40) / cols));
  const rows = Math.ceil(STAGES.length / cols);
  const gridW = cols * cell;
  const gridH = rows * cell;
  const x0 = cx - gridW / 2;
  const y0 = Math.min(L.hudH + 100, g.h - gridH - 60);

  for (let i = 0; i < STAGES.length; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    const x = x0 + col * cell + cell / 2;
    const y = y0 + row * cell + cell / 2;
    const unlocked = i < s.unlocked;
    const sel = i === s.selectIdx;
    const r = cell * 0.38;
    ctx.save();
    ctx.globalAlpha = unlocked ? 1 : 0.32;
    ctx.fillStyle = sel ? Palette.accent : (unlocked ? Palette.panel : Palette.dim);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    if (sel) {
      ctx.strokeStyle = Palette.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = sel ? Palette.bg : Palette.ink;
    ctx.restore();
    text(ctx, String(i + 1), x, y + 5, {
      size: Type.small, color: sel ? Palette.bg : (unlocked ? Palette.ink : Palette.dim),
      align: 'center', weight: 700,
    });
  }

  const cur = STAGES[s.selectIdx];
  const curBest = Store.get('stageBest:' + s.selectIdx, 0);
  text(ctx, T(`STAGE ${s.selectIdx + 1}  ·  difficulty ${Math.round(cur.difficulty * 100)}%  ·  best ${curBest}`,
    `第 ${s.selectIdx + 1} 关  ·  难度 ${Math.round(cur.difficulty * 100)}%  ·  最佳 ${curBest}`),
    cx, y0 + gridH + 30, { size: Type.body, color: Palette.ink, align: 'center' });
  text(ctx, T('ARROWS move  ·  SPACE play  ·  ESC back', '方向键移动  ·  SPACE 开始  ·  ESC 返回'),
    cx, y0 + gridH + 54, { size: Type.small, color: Palette.dim, align: 'center' });
}

function drawOverlays(s, ctx, g, L) {
  const u = L.u;
  const cx = g.w / 2;
  const sim = s.sim;
  const song = sim.song;
  const narrow = g.w < 620;

  if (s.phase === 'intro') {
    titleCard(ctx, g, {
      title: T('PULSE', '脉冲'),
      tagline: narrow
        ? T('The seed writes the song.', '种子谱写乐曲。')
        : T('The seed writes the song. The song writes the level.', '种子谱写乐曲,乐曲生成关卡。'),
      lines: [
        T('SPACE / CLICK — jump  (hold for height)', 'SPACE / 点击 — 跳跃(按住跳更高)'),
        T('SPACE again midair — slam down and slide under', '空中再按 SPACE — 下砸并滑行躲避'),
        '',
        T(`SEED ${s.seed}  ·  ${song.bpm} BPM  ·  ${song.key} ${song.scale}`,
          `种子 ${s.seed}  ·  ${song.bpm} BPM  ·  ${song.key} ${song.scale}`),
        T(`${song.notes.length} notes  ·  ${sim.chart.length} obstacles  ·  ${Math.round(song.duration)}s`,
          `${song.notes.length} 个音符  ·  ${sim.chart.length} 个障碍  ·  ${Math.round(song.duration)} 秒`),
        T(`L Campaign (${s.unlocked}/${STAGES.length} unlocked)  ·  S seed  ·  N re-roll  ·  C copy  ·  R restart  ·  M mute`,
          `L 战役 (已解锁 ${s.unlocked}/${STAGES.length})  ·  S 输入种子  ·  N 换一个  ·  C 复制  ·  R 重开  ·  M 静音`),
      ],
      prompt: T('PRESS SPACE  ·  L for Campaign', '按空格键开始  ·  按 L 进入战役'),
      t: s.introT,
      accent: Palette.accent,
    });
  }

  if (s.phase === 'over' || s.phase === 'win') {
    const won = s.phase === 'win';
    const total = sim.perfect + sim.good + sim.missed;
    const acc = total ? Math.round((sim.perfect / total) * 100) : 0;
    const inCampaign = s.campaign >= 0;
    const stageLabel = inCampaign
      ? T(`STAGE ${s.campaign + 1}/${STAGES.length}`, `第 ${s.campaign + 1}/${STAGES.length} 关`)
      : null;
    // The three leading blank lines reserve the slot the score figure lands in.
    titleCard(ctx, g, {
      title: won ? T('TRACK CLEARED', '曲目通关') : T('RUN ENDED', '本局结束'),
      tagline: stageLabel,
      lines: [
        '', '', '',
        T(`${sim.perfect} PERFECT  ·  ${sim.good} GOOD  ·  ${sim.missed} MISSED  ·  ${acc}%`,
          `${sim.perfect} 完美  ·  ${sim.good} 良好  ·  ${sim.missed} 失误  ·  ${acc}%`),
        T(`BEST COMBO ${sim.maxCombo}  ·  ${sim.cleared}/${sim.chart.length} OBSTACLES CLEARED`,
          `最高连击 ${sim.maxCombo}  ·  已通过 ${sim.cleared}/${sim.chart.length} 个障碍`),
        inCampaign
          ? T(`SEED ${s.seed}  ·  STAGE BEST ${Math.max(s.stageBest, sim.score)}${won && s.justUnlocked && s.campaign + 1 < STAGES.length ? '  ·  NEXT STAGE UNLOCKED' : ''}`,
            `种子 ${s.seed}  ·  本关最佳 ${Math.max(s.stageBest, sim.score)}${won && s.justUnlocked && s.campaign + 1 < STAGES.length ? '  ·  已解锁下一关' : ''}`)
          : T(`SEED ${s.seed}  ·  BEST ${Math.max(s.seedBest, sim.score)}  ·  ALL-TIME ${Math.max(s.best, sim.score)}`,
            `种子 ${s.seed}  ·  本种子最佳 ${Math.max(s.seedBest, sim.score)}  ·  历史最佳 ${Math.max(s.best, sim.score)}`),
      ],
      prompt: inCampaign
        ? T('SPACE next  ·  L stage select  ·  ESC free play', 'SPACE 下一关  ·  L 选关  ·  ESC 自由模式')
        : T('SPACE retry  ·  N new seed  ·  S type a seed  ·  C copy  ·  L Campaign', 'SPACE 重试  ·  N 换种子  ·  S 输入种子  ·  C 复制  ·  L 战役'),
      t: s.introT,
      accent: won ? Palette.accent : Palette.hot,
    });
    stat(ctx, cx, g.h / 2 - 44, T('FINAL SCORE', '最终得分'), String(sim.score), {
      align: 'center', valueSize: Type.big, color: won ? Palette.accent : Palette.ink,
    });
  }

  if (s.phase === 'select') drawSelect(s, ctx, g, L);

  if (s.seedEdit) {
    ctx.save();
    ctx.fillStyle = 'rgba(7,8,13,0.88)';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
    const w = Math.min(g.w - 40, 460);
    const h = Math.min(g.h - 40, 172);
    const x = (g.w - w) / 2, y = (g.h - h) / 2;
    panel(ctx, x, y, w, h, { title: T('seed', '种子'), glowColor: Palette.accent, glowBlur: 24, radius: 6 });
    const shown = s.seedBuf + (Math.floor(s.introT * 2.6) % 2 ? '_' : ' ');
    text(ctx, shown || '_', cx, y + h * 0.6, {
      size: Type.big, color: Palette.accent, align: 'center', baseline: 'alphabetic', weight: 700,
    });
    text(ctx, 'type or paste  ·  ENTER to play  ·  ESC to cancel', cx, y + h - 22, {
      size: Type.small, color: Palette.dim, align: 'center', baseline: 'alphabetic',
    });
  }
}

function render(s, ctx, g) {
  s.introT = g.t;
  const L = layout(g);
  const sim = s.sim;
  const beat = sim.kickP;

  drawSky(s, ctx, g);

  // Everything that is "the world" is clipped below the status strip, so the HUD
  // always sits on clean chrome no matter how tall the scene wants to be.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, L.hudH, g.w, Math.max(1, g.h - L.hudH));
  ctx.clip();
  drawAtmosphere(s, ctx, g, L);
  drawBackdrop(s, ctx, g, L, beat);
  drawTrack(s, ctx, g, L);
  drawRunner(s, ctx, g, L);
  FX.draw(ctx);
  ctx.restore();

  drawHud(s, ctx, g, L);

  if (sim.flash > 0.01) {
    ctx.save();
    ctx.globalAlpha = sim.flash * 0.3;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
  }

  drawOverlays(s, ctx, g, L);
  vignette(ctx, g, 0.4);
}

// ---------------------------------------------------------------- boot

const game = boot({ id: 'pulse', title: 'Pulse', seed: START_SEED, init, update, render });
mountLangToggle();

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
  seq.stop();                   // if a human was mid-song, run the test in silence
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

  // 11 — Campaign: exactly 50 fixed stages, escalating difficulty, all provably fair
  check('Campaign has exactly 50 stages', STAGES.length === 50, `${STAGES.length} stages`);
  let stageMono = true;
  for (let i = 1; i < STAGES.length; i++) if (STAGES[i].difficulty < STAGES[i - 1].difficulty) stageMono = false;
  check('Campaign difficulty escalates monotonically stage to stage', stageMono);

  let stageFair = 0, stageBeaten = 0, stageDied = 0, stageDet = 0, stageFinite = 0;
  const stageFailures = [];
  for (let i = 0; i < STAGES.length; i++) {
    const st = STAGES[i];
    const songX = compose(st.seed, st.difficulty);
    const songY = compose(st.seed, st.difficulty);
    if (JSON.stringify(songX.notes) === JSON.stringify(songY.notes)
      && JSON.stringify(songX.chart) === JSON.stringify(songY.chart)) stageDet++;
    else stageFailures.push(`#${i} not deterministic`);

    const v = verifyChart(songX.chart);
    if (v.ok) stageFair++; else stageFailures.push(`#${i} unfair: ${v.problems[0]}`);

    const won = autoRun(st.seed, { difficulty: st.difficulty });
    if (won.won && won.hits === 0 && won.missed === 0) stageBeaten++;
    else stageFailures.push(`#${i} not bot-cleared`);

    const lost = idleRun(st.seed, { difficulty: st.difficulty });
    if (lost.dead) stageDied++; else stageFailures.push(`#${i} idle survived`);

    const fin = allFinite({ notes: songX.notes, chart: songX.chart });
    if (fin.ok) stageFinite++; else stageFailures.push(`#${i} non-finite`);
  }
  check('all 50 Campaign stages pass the fairness verifier', stageFair === 50,
    `${stageFair}/50${stageFailures.length ? ' · ' + stageFailures.slice(0, 2).join(' | ') : ''}`);
  check('all 50 Campaign stages are bot-clearable with zero hits/misses', stageBeaten === 50, `${stageBeaten}/50`);
  check('all 50 Campaign stages kill an idle (no-input) run', stageDied === 50, `${stageDied}/50`);
  check('all 50 Campaign stages are deterministic', stageDet === 50, `${stageDet}/50`);
  check('all 50 Campaign stages are allFinite', stageFinite === 50, `${stageFinite}/50`);

  // 12 — Campaign progression + unlock persistence, driven through the real boot()ed game
  Store.set('campaignUnlocked', 1);
  Store.set('stageBest:0', 0);
  pendingStage = { index: 0, entry: STAGES[0] };
  game.restart(STAGES[0].seed);
  game.state.noAudio = true;
  game.state.phase = 'play';
  const gs = game.state;
  check('starting stage 1 sets state.campaign correctly', gs.campaign === 0 && gs.sim.song.difficulty === STAGES[0].difficulty,
    `campaign=${gs.campaign} songDiff=${gs.sim.song.difficulty}`);
  // Drive the LIVE sim object to completion with the same scripted optimal player
  // autoRun() already proved fair on every stage — autoRun accepts a sim in place
  // of a seed and mutates it directly — then let one real game.step() notice
  // sim.won and run the game's own phase-transition + unlock-persistence logic.
  autoRun(gs.sim);
  game.step(1);
  check('a bot-cleared live Campaign stage 1 unlocks stage 2',
    gs.phase === 'win' && gs.unlocked >= 2 && Store.get('campaignUnlocked', 1) >= 2,
    `phase=${gs.phase} unlocked=${gs.unlocked} stored=${Store.get('campaignUnlocked', 1)}`);
  check('unlock persistence never exceeds the stage count', Store.get('campaignUnlocked', 1) <= STAGES.length);

  game.restart(START_SEED);
  log(`seeds tested: ${N} · campaign stages: 50 · ${a.bpm}bpm ${a.key} ${a.scale} · notes=${a.notes.length} chart=${a.chart.length}`);
});

// dev console handles
globalThis.__pulse = { compose, verifyChart, makeSim, stepSim, autoRun, idleRun, seq, PHYS, TEST_SEEDS };

export default game;
