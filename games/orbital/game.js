// Orbital — n-body gravity golf.
//
// Drag back from the probe, let go, and the only thing acting on it after that is
// gravity. Sink it in the ring under par.
//
// Everything physical lives in sim.js, which imports no DOM at all: the live game, the
// self-test and the node solver (tools-solve.mjs) all drive the same stepSim(), so a
// flight in your browser is bit-for-bit the flight the solver verified.

import {
  boot, registerSelftest, Palette, FX, Sound, Music, Store, RNG,
  clamp, approach, text, allFinite, TAU,
  Type, HUD_H, withGlow, stat, hudStrip, panel, meter, orb, vignette, titleCard,
  T, mountLangToggle, mountResetButton, currentLang, registerTranslations,
} from '../../shared/kit.js';

import {
  makeSim, launch as launchSim, stepSim, predict, previewSteps,
  solve, replaySolution, flightResult,
  MAX_POWER, MIN_POWER, PROBE_R, HOLE_COUNT,
} from './sim.js';

import { HOLES, TOTAL_PAR } from './holes.js';

// --- ambient background music: slow D-dorian pad with a sparse, distant arpeggio.
// Kept quiet and spacious to sit under the physics puzzle without distracting from it.
// The pattern moves through four harmonic sections over a long macro-cycle (each section
// is 4 bars of 16 steps = 64 steps, ~55s at 70bpm) so it reads as a slowly drifting piece
// rather than a short loop, plus a slow filtered "solar wind" noise texture underneath.
const ORBITAL_PAD = [73.42, 87.31, 98.00, 110.00];        // D2 F2 G2 A2 — dorian drone/pad tones
const ORBITAL_TWINKLE = [587.33, 698.46, 783.99, 880.00, 1046.50]; // D5 F5 G5 A5 C6 — distant twinkles
// Four sections: each re-voices the dorian pad as a different chord shape (root spread,
// open fifth, added-sixth, and a darker inverted voicing) so the drone itself evolves.
const ORBITAL_SECTIONS = [
  [0, 2, 1, 3], // i - iv - iii - v-ish spread
  [1, 3, 0, 2], // shifted rotation, brighter
  [2, 0, 3, 1], // open-fifth feel
  [3, 1, 2, 0], // darker inversion
];
function orbitalMusic(step, atTime, gain) {
  const t = atTime - Sound.ctx.currentTime;
  const bar = Math.floor(step / 16) % 4;
  const section = ORBITAL_SECTIONS[Math.floor(step / 64) % ORBITAL_SECTIONS.length];
  const chordIdx = section[bar];
  // slow pad, one long note every 4 beats (16 steps), cycling through the section's chord
  if (step % 16 === 0) {
    Sound.tone({ freq: ORBITAL_PAD[chordIdx], dur: 3.4, type: 'sine', gain: 0.045 * gain, at: t });
    Sound.tone({ freq: ORBITAL_PAD[chordIdx] * 1.5, dur: 3.0, type: 'sine', gain: 0.02 * gain, at: t });
  }
  // occasional distant twinkle, sparse and irregular-feeling
  if (step % 24 === 6) {
    const n = ORBITAL_TWINKLE[(step / 24 | 0) % ORBITAL_TWINKLE.length];
    Sound.tone({ freq: n, dur: 0.9, type: 'triangle', gain: 0.03 * gain, at: t });
  }
  if (step % 40 === 30) {
    const n = ORBITAL_TWINKLE[((step / 40 | 0) + 2) % ORBITAL_TWINKLE.length];
    Sound.tone({ freq: n * 2, dur: 0.6, type: 'sine', gain: 0.02 * gain, at: t });
  }
  // solar wind: slow swelling noise texture, once per 8-bar phrase, drifting in pitch feel
  // via duration/gain variance across the macro-cycle so it never sounds mechanically identical
  if (step % 128 === 96) {
    const phrase = Math.floor(step / 128) % 3;
    Sound.noise({ dur: 5.0 + phrase * 1.5, gain: 0.02 * gain, at: t });
  }
  // slow countermelody line, offset from the twinkles, only present every other section
  // so it feels like a voice that comes and goes rather than a fixed layer
  if (Math.floor(step / 64) % 2 === 1 && step % 32 === 20) {
    const n = ORBITAL_TWINKLE[(chordIdx + 1) % ORBITAL_TWINKLE.length] / 2;
    Sound.tone({ freq: n, dur: 2.2, type: 'triangle', gain: 0.025 * gain, at: t });
  }
}

registerTranslations({
  'HOLE RESET': { es: 'HOYO REINICIADO', fr: 'TROU RÉINITIALISÉ', ja: 'ホールをリセット', ko: '홀 리셋' },
  'PULL FURTHER BACK': { es: 'TIRA MÁS HACIA ATRÁS', fr: 'TIRE PLUS EN ARRIÈRE', ja: 'もっと引いて', ko: '더 뒤로 당기세요' },
  'SWALLOWED BY THE BLACK HOLE': { es: 'TRAGADO POR EL AGUJERO NEGRO', fr: 'AVALÉ PAR LE TROU NOIR', ja: 'ブラックホールに飲み込まれた', ko: '블랙홀에 삼켜짐' },
  'SMACKED THE REPULSOR CORE': { es: 'CHOCÓ CONTRA EL NÚCLEO REPULSOR', fr: 'PERCUTÉ LE NOYAU RÉPULSEUR', ja: '反発コアに激突', ko: '반발 코어에 충돌' },
  'CRASHED INTO A MOON': { es: 'ESTRELLADO CONTRA UNA LUNA', fr: 'ÉCRASÉ SUR UNE LUNE', ja: '衛星に衝突', ko: '위성과 충돌' },
  'CRASHED INTO A PLANET': { es: 'ESTRELLADO CONTRA UN PLANETA', fr: 'ÉCRASÉ SUR UNE PLANÈTE', ja: '惑星に衝突', ko: '행성과 충돌' },
  'LEFT THE SYSTEM': { es: 'SALIÓ DEL SISTEMA', fr: 'SORTI DU SYSTÈME', ja: '星系の外へ', ko: '행성계를 벗어남' },
  'LOST IN SPACE': { es: 'PERDIDO EN EL ESPACIO', fr: "PERDU DANS L'ESPACE", ja: '宇宙で迷子', ko: '우주에서 실종' },
  'HOLE': { es: 'HOYO', fr: 'TROU', ja: 'ホール', ko: '홀' },
  'PAR': { es: 'PAR', fr: 'PAR', ja: 'パー', ko: '파' },
  'BEST': { es: 'MEJOR', fr: 'MEILLEUR', ja: 'ベスト', ko: '최고' },
  'STROKES': { es: 'GOLPES', fr: 'COUPS', ja: '打数', ko: '타수' },
  'ROUND': { es: 'RONDA', fr: 'MANCHE', ja: 'ラウンド', ko: '라운드' },
  'R RESET  ·  SPACE FAST-FORWARD': { es: 'R REINICIAR  ·  SPACE AVANCE RÁPIDO', fr: 'R RÉINITIALISER  ·  SPACE AVANCE RAPIDE', ja: 'R リセット ・ SPACE 早送り', ko: 'R 리셋  ·  SPACE 빨리감기' },
  'DRAG BACK AND RELEASE TO LAUNCH': { es: 'ARRASTRA HACIA ATRÁS Y SUELTA PARA LANZAR', fr: 'TIRE EN ARRIÈRE ET RELÂCHE POUR LANCER', ja: '後ろにドラッグして離すと発射', ko: '뒤로 드래그한 뒤 놓으면 발사' },
  'HOLD SPACE TO FAST-FORWARD': { es: 'MANTÉN SPACE PARA AVANZAR RÁPIDO', fr: 'MAINTIENS SPACE POUR AVANCER RAPIDEMENT', ja: 'SPACEを押し続けると早送り', ko: 'SPACE를 누르고 있으면 빨리감기' },
  'Launch a probe. Real gravity does the rest.': { es: 'Lanza una sonda. La gravedad real hace el resto.', fr: 'Lance une sonde. La gravité réelle fait le reste.', ja: '探査機を発射しよう。あとは本物の重力に任せて。', ko: '탐사선을 발사하세요. 나머지는 실제 중력이 알아서 합니다.' },
  'Slingshot round planets, dodge black holes,': { es: 'Usa planetas como resortera, esquiva agujeros negros,', fr: 'Utilise les planètes comme fronde, évite les trous noirs,', ja: '惑星でスイングバイし、ブラックホールをかわし、', ko: '행성을 이용해 스윙바이하고, 블랙홀을 피하며,' },
  'dive through wormholes. Sink it under par.': { es: 'atraviesa agujeros de gusano. Termina bajo par.', fr: 'traverse des trous de ver. Termine sous le par.', ja: 'ワームホールを通り抜けよう。パー以下でホールイン。', ko: '웜홀을 통과하세요. 파 이하로 홀인하세요.' },
  'Slingshot, dodge, warp. Sink it under par.': { es: 'Resortera, esquiva, salta. Termina bajo par.', fr: 'Fronde, esquive, saut. Termine sous le par.', ja: 'スイングバイ、回避、ワープ。パー以下でホールイン。', ko: '스윙바이, 회피, 워프. 파 이하로 홀인하세요.' },
  'DRAG back from the probe, release to fire': { es: 'ARRASTRA hacia atrás desde la sonda, suelta para disparar', fr: 'TIRE en arrière depuis la sonde, relâche pour tirer', ja: '探査機からドラッグして、離すと発射', ko: '탐사선에서 뒤로 드래그한 뒤 놓으면 발사' },
  'R reset hole  ·  SPACE fast-forward': { es: 'R reiniciar hoyo  ·  SPACE avance rápido', fr: 'R réinitialiser le trou  ·  SPACE avance rapide', ja: 'R ホールをリセット ・ SPACE 早送り', ko: 'R 홀 리셋  ·  SPACE 빨리감기' },
  'ORBITAL': { es: 'ORBITAL', fr: 'ORBITAL', ja: 'オービタル', ko: '오비탈' },
  'N-BODY GRAVITY GOLF': { es: 'GOLF GRAVITACIONAL DE N CUERPOS', fr: 'GOLF GRAVITATIONNEL À N CORPS', ja: 'N体重力ゴルフ', ko: 'N체 중력 골프' },
  'DRAG TO LAUNCH': { es: 'ARRASTRA PARA LANZAR', fr: 'TIRE POUR LANCER', ja: 'ドラッグして発射', ko: '드래그해서 발사' },
  'ENTER for the next hole': { es: 'ENTER para el siguiente hoyo', fr: 'ENTER pour le trou suivant', ja: 'ENTERで次のホールへ', ko: 'ENTER를 눌러 다음 홀로' },
  'ROUND COMPLETE': { es: 'RONDA COMPLETA', fr: 'MANCHE TERMINÉE', ja: 'ラウンド終了', ko: '라운드 완료' },
  'NEW BEST ROUND': { es: 'NUEVA MEJOR RONDA', fr: 'NOUVELLE MEILLEURE MANCHE', ja: '自己ベスト更新', ko: '신기록 라운드' },
  'ENTER to play another round': { es: 'ENTER para jugar otra ronda', fr: 'ENTER pour rejouer une manche', ja: 'ENTERでもう一度プレイ', ko: 'ENTER를 눌러 다시 플레이' },
  'SCORECARD': { es: 'TARJETA DE PUNTUACIÓN', fr: 'CARTE DE SCORE', ja: 'スコアカード', ko: '스코어카드' },
  'HOLE / PAR / SCORE': { es: 'HOYO / PAR / PUNTUACIÓN', fr: 'TROU / PAR / SCORE', ja: 'ホール / パー / スコア', ko: '홀 / 파 / 점수' },
});

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

const MEDAL_ZH = {
  ALBATROSS: '信天翁',
  EAGLE: '老鹰',
  BIRDIE: '小鸟球',
  PAR: '标准杆',
  BOGEY: '柏忌',
  'DOUBLE BOGEY': '双柏忌',
};

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

/** Height of the bottom status bar. The top strip is the kit's shared HUD_H. */
const BOT_H = 38;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** The play area: everything between the two status bars, derived from the canvas. */
function viewRect(g) {
  const top = HUD_H + 8, bot = BOT_H + 6, side = 14;
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
function pullMax(g) { return Math.max(80, Math.min(g.w, g.h) * 0.28); }

/** Press near the probe to grab it; press anywhere else and that point becomes the anchor.
 *  Tees sit near the left edge, so a probe-only anchor would run the pull off-canvas. */
function grabRadius(g) { return Math.max(70, Math.min(g.w, g.h) * 0.18); }

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
    drag: { active: false, x: 0, y: 0, ax: 0, ay: 0, grabbed: false, pull: 0, angle: 0, power: 0 },
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
  const strokeWordEn = `${s.strokes} stroke${s.strokes === 1 ? '' : 's'}`;
  const strokeWordZh = `${s.strokes} 杆`;
  const bestWordEn = isBest ? ' · personal best' : '';
  const bestWordZh = isBest ? ' · 个人最佳' : '';
  s.banner = {
    title: T(m[1], MEDAL_ZH[m[1]] || m[1]),
    sub: T(`${strokeWordEn} · par ${par}${bestWordEn}`, `${strokeWordZh} · 标准杆 ${par}${bestWordZh}`),
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
      if (!Music.playing) Music.start(orbitalMusic, { bpm: 70, gain: 1 });
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
    s.message = T('HOLE RESET', '本洞重置');
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
      const near = Math.hypot(probe.x - I.pointer.x, probe.y - I.pointer.y) <= grabRadius(g);
      s.drag.ax = near ? probe.x : I.pointer.x;
      s.drag.ay = near ? probe.y : I.pointer.y;
      s.drag.grabbed = near;
    }
    if (s.drag.active) {
      const dx = s.drag.ax - I.pointer.x, dy = s.drag.ay - I.pointer.y;
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
        else { s.message = T('PULL FURTHER BACK', '再往后拉一点'); s.messageT = 1.4; }
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
      const what = s.sim.crashType === 'blackhole' ? T('SWALLOWED BY THE BLACK HOLE', '被黑洞吞噬')
        : s.sim.crashType === 'repulsor' ? T('SMACKED THE REPULSOR CORE', '撞上了斥力核心')
        : s.sim.crashType === 'moon' ? T('CRASHED INTO A MOON', '撞上了卫星')
        : T('CRASHED INTO A PLANET', '撞上了行星');
      failShot(s, what);
    } else if (s.sim.status === 'oob') {
      failShot(s, T('LEFT THE SYSTEM', '飞出了星系'));
    } else if (s.sim.status === 'lost') {
      failShot(s, T('LOST IN SPACE', '迷失在太空中'));
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

  // The rings are drawn inside the camera transform, so shadowBlur is in WORLD units
  // and the renderer scales it by cam.scale. Multiplying by px (= 1/scale) lands the
  // halo at a constant ~14 screen pixels however far the camera has pulled back.
  withGlow(ctx, Palette.accent, 14 * px, () => {
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
  });

  // crosshair ticks — deliberately crisp, so they stay readable against the halo
  ctx.strokeStyle = Palette.accent;
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

/**
 * A comet, not a wire: each segment gets its own alpha and width so the tail fades
 * into the dark and the head reads as the live end. Stepped by a stride like
 * drawPreview, because a full flight can be 1200 points long.
 */
function drawTrail(s, ctx, pts, color, maxAlpha, width) {
  if (!pts || pts.length < 2) return;
  const px = 1 / s.cam.scale;
  const n = pts.length;
  const stride = Math.max(1, Math.floor(n / 220));

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;

  // f runs 0 (oldest) -> 1 (newest).
  const seg = (a, b, f) => {
    // Break the polyline wherever the probe teleported, so warps do not draw a straight seam.
    if (Math.abs(b.x - a.x) > 260 || Math.abs(b.y - a.y) > 260) return;
    ctx.globalAlpha = maxAlpha * (0.16 + 0.84 * f * f);
    ctx.lineWidth = width * (0.35 + 0.65 * f) * px;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };

  let last = 0;
  for (let i = stride; i < n; i += stride) {
    seg(pts[last], pts[i], i / (n - 1));
    last = i;
  }
  if (last < n - 1) seg(pts[last], pts[n - 1], 1);  // keep the head attached to the probe

  ctx.globalAlpha = 1;
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
  // wide corona first — this is the object the eye tracks, so it gets real reach
  const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 30);
  gr.addColorStop(0, 'rgba(255,200,87,0.50)');
  gr.addColorStop(0.4, 'rgba(255,200,87,0.16)');
  gr.addColorStop(1, 'rgba(255,200,87,0)');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(p.x, p.y, 30, 0, TAU); ctx.fill();

  // Inside the camera transform shadowBlur is in world units, so scale it by px
  // (= 1/cam.scale) to hold a constant ~10 screen pixels of bloom at any zoom.
  withGlow(ctx, Palette.warm, 10 * px, () => {
    orb(ctx, p.x, p.y, PROBE_R, Palette.warm, { glow: 1.2 });
  });
  ctx.fillStyle = '#fff3d6';
  ctx.beginPath(); ctx.arc(p.x - PROBE_R * 0.24, p.y - PROBE_R * 0.24, PROBE_R * 0.42, 0, TAU); ctx.fill();

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
  const anchor = screenToWorld(s, g, s.drag.ax, s.drag.ay);
  const frac = clamp(s.drag.pull / pullMax(g), 0, 1);

  ctx.save();
  // rubber band from the anchor back to the cursor
  ctx.strokeStyle = 'rgba(255,200,87,0.5)';
  ctx.lineWidth = 1.6 * px;
  ctx.setLineDash([6 * px, 6 * px]);
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(w.x, w.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,200,87,0.8)';
  ctx.beginPath(); ctx.arc(w.x, w.y, 4 * px + 1, 0, TAU); ctx.fill();
  if (!s.drag.grabbed) {
    ctx.strokeStyle = 'rgba(255,200,87,0.35)';
    ctx.lineWidth = 1.2 * px;
    ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 7 * px + 2, 0, TAU); ctx.stroke();
  }

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

/** Width of a string in the HUD's mono face, without disturbing the draw state. */
function measure(ctx, str, size, weight = 700) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${MONO}`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

/** Truncate to fit maxW rather than letting flavour text collide with a readout. */
function fitText(ctx, str, maxW, size, weight = 600) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${MONO}`;
  let out = str;
  if (ctx.measureText(out).width > maxW) {
    while (out.length > 1 && ctx.measureText(out + '...').width > maxW) out = out.slice(0, -1);
    out += '...';
  }
  ctx.restore();
  return out;
}

/** The bottom bar: the same surface language as the kit's hudStrip, mirrored. */
function bottomBar(ctx, g) {
  const y = g.h - BOT_H;
  ctx.save();
  ctx.fillStyle = 'rgba(13,16,24,0.92)';
  ctx.fillRect(0, y, g.w, BOT_H);
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(g.w, y + 0.5);
  ctx.stroke();
  ctx.restore();
  return y;
}

function drawHud(s, ctx, g) {
  const hole = HOLES[s.holeIndex];
  const num = String(s.holeIndex + 1).padStart(2, '0');
  const cx = g.w / 2;
  const pad = clamp(g.w * 0.014, 12, 22);
  const wide = g.w >= 880;
  const mid = g.w >= 700;
  const narrow = g.w < 560;
  const tiny = g.w < 430;
  const vSize = narrow ? 20 : Type.value;
  const labelY = 20;                       // label baseline; stat() puts the value at +vSize+2
  const valueY = labelY + vSize + 2;

  // ---------------------------------------------------------------- top strip
  hudStrip(ctx, g, { h: HUD_H });

  // LEFT — where you are in the round, with the hole name as secondary flavour
  const holeVal = `${num}/${HOLE_COUNT}`;
  stat(ctx, pad, labelY, T('HOLE', '球洞'), holeVal, { color: Palette.accent, valueSize: vSize });
  if (wide) {
    const nameX = pad + measure(ctx, holeVal, vSize) + 18;
    const nameMax = cx - 70 - nameX;
    if (nameMax > 56) {
      const holeName = T(hole.name, hole.nameZh || hole.name);
      text(ctx, fitText(ctx, currentLang() === 'zh' ? holeName : holeName.toUpperCase(), nameMax, Type.label), nameX, valueY, {
        size: Type.label, color: Palette.dim, weight: 600, baseline: 'alphabetic',
      });
    }
  }

  // CENTRE — the target
  const best = s.bestHoles[s.holeIndex];
  const hasBest = best !== null && best !== undefined;
  if (!tiny) {
    if (hasBest && mid) {
      stat(ctx, cx - 38, labelY, T('PAR', '标准杆'), hole.par, { align: 'center', valueSize: vSize });
      stat(ctx, cx + 38, labelY, T('BEST', '最佳'), best, { align: 'center', valueSize: vSize, color: Palette.accent2 });
    } else {
      stat(ctx, cx, labelY, T('PAR', '标准杆'), hole.par, { align: 'center', valueSize: vSize });
    }
  }

  // RIGHT — this hole, then the whole round against par
  const parSoFar = HOLES.slice(0, s.holeIndex).reduce((n, h) => n + h.par, 0) + hole.par;
  const vs = s.totalStrokes - parSoFar;
  const rx = g.w - pad;
  if (narrow) {
    stat(ctx, rx, labelY, T('STROKES', '杆数'), s.strokes, { align: 'right', color: Palette.warm, valueSize: vSize });
  } else {
    const roundVal = `${s.totalStrokes} ${rel(vs)}`;
    stat(ctx, rx, labelY, T('ROUND', '本轮'), roundVal, {
      align: 'right', valueSize: vSize,
      color: vs < 0 ? Palette.accent : vs > 0 ? Palette.hot : Palette.ink,
    });
    stat(ctx, rx - measure(ctx, roundVal, vSize) - 30, labelY, T('STROKES', '杆数'), s.strokes, {
      align: 'right', color: Palette.warm, valueSize: vSize,
    });
  }

  // ---------------------------------------------------------------- bottom bar
  const barY = bottomBar(ctx, g);
  const barMid = barY + BOT_H / 2;

  if (!narrow) {
    text(ctx, T(`ROUND PAR ${TOTAL_PAR}`, `本轮标准杆 ${TOTAL_PAR}`) + (s.bestRound !== null ? T(`  ·  BEST ${s.bestRound}`, `  ·  最佳 ${s.bestRound}`) : ''),
      pad, barMid, { size: Type.micro, color: Palette.dim, baseline: 'middle', alpha: 0.75 });
  }
  if (mid) {
    text(ctx, T('R RESET  ·  SPACE FAST-FORWARD', 'R 重置  ·  SPACE 快进'), rx, barMid, {
      size: Type.micro, color: Palette.dim, align: 'right', baseline: 'middle', alpha: 0.55,
    });
  }

  // hole progress pips, seated on the bar's centre line
  const pipW = clamp((g.w - 260) / HOLE_COUNT, 4, 10);
  for (let i = 0; i < HOLE_COUNT; i++) {
    const x = cx - (HOLE_COUNT * pipW) / 2 + i * pipW;
    const done = s.scores[i] !== undefined;
    ctx.globalAlpha = i === s.holeIndex ? 1 : done ? 0.75 : 0.25;
    ctx.fillStyle = i === s.holeIndex ? Palette.warm
      : done ? (s.scores[i] <= HOLES[i].par ? Palette.accent : Palette.dim)
      : Palette.grid;
    ctx.fillRect(x, barMid - 2, Math.max(2, pipW - 2), 4);
  }
  ctx.globalAlpha = 1;

  // ---------------------------------------------------------------- transient line
  const lineY = barY - 30;
  // The longest hint is 75 characters; mono advance is ~0.6em, so step the size down
  // as the canvas narrows rather than letting a sentence run off both edges.
  const hintSize = g.w >= 780 ? Type.small : g.w >= 560 ? Type.label : g.w >= 470 ? Type.micro : 9;
  if (s.messageT > 0 && s.message) {
    const a = clamp(s.messageT / 0.5, 0, 1);
    withGlow(ctx, Palette.hot, 14, () => {
      text(ctx, s.message, cx, lineY, { size: Type.small, color: Palette.hot, align: 'center', weight: 700, alpha: a });
    });
  } else if (s.hintT > 0 && s.phase === 'aim') {
    const a = clamp(s.hintT / 1.0, 0, 1);
    text(ctx, T(hole.hint, hole.hintZh || hole.hint), cx, lineY, { size: hintSize, color: Palette.dim, align: 'center', alpha: a });
  } else if (s.phase === 'aim' && !s.drag.active) {
    const p = 0.5 + 0.5 * Math.sin(s.t * 2.6);
    text(ctx, T('DRAG BACK AND RELEASE TO LAUNCH', '向后拖拽然后松手发射'), cx, lineY, {
      size: Type.label, color: Palette.dim, align: 'center', weight: 600, alpha: 0.32 + p * 0.34,
    });
  } else if (s.phase === 'fly') {
    text(ctx, T('HOLD SPACE TO FAST-FORWARD', '按住 SPACE 快进'), cx, lineY, {
      size: Type.micro, color: Palette.dim, align: 'center', alpha: 0.5,
    });
  }

  if (s.drag.active && s.drag.pull > 10) {
    const frac = clamp(s.drag.pull / pullMax(g), 0, 1);
    const col = frac > 0.92 ? Palette.hot : Palette.warm;
    const mw = Math.min(300, g.w * 0.34);
    meter(ctx, cx - mw / 2, lineY - 14, mw, 6, frac, { color: col });
    text(ctx, T(`${Math.round(frac * 100)}% POWER`, `${Math.round(frac * 100)}% 力度`), cx, lineY - 36, {
      size: Type.small, color: col, align: 'center', weight: 700,
    });
  }
}

function drawIntro(s, ctx, g) {
  const roomy = g.h >= 470, mid = g.h >= 360;
  const lines = [T('Launch a probe. Real gravity does the rest.', '发射探测器,剩下的交给真实的引力。')];
  if (roomy) {
    lines.push(T('Slingshot round planets, dodge black holes,', '绕行星借力弹弓,躲开黑洞,'));
    lines.push(T('dive through wormholes. Sink it under par.', '穿越虫洞,力争杆数低于标准杆。'));
  } else if (mid) {
    lines.push(T('Slingshot, dodge, warp. Sink it under par.', '借力、躲避、跃迁,低于标准杆入洞。'));
  }
  lines.push('');
  lines.push(T('DRAG back from the probe, release to fire', '从探测器处向后拖拽,松手发射'));
  if (mid) lines.push(T('R reset hole  ·  SPACE fast-forward', 'R 重置本洞  ·  SPACE 快进'));
  lines.push(T(`${HOLE_COUNT} HOLES  ·  TOTAL PAR ${TOTAL_PAR}`, `${HOLE_COUNT} 洞  ·  总标准杆 ${TOTAL_PAR}`));

  titleCard(ctx, g, {
    title: T('ORBITAL', '轨道'),
    tagline: T('N-BODY GRAVITY GOLF', '多体引力高尔夫'),
    lines,
    prompt: T('DRAG TO LAUNCH', '拖拽以发射'),
    t: s.t,
    accent: Palette.accent,
  });
}

function drawBanner(s, ctx, g) {
  if (!s.banner) return;
  const a = clamp(s.banner.t / 0.22, 0, 1) * clamp((s.resultT + 0.4) / 0.5, 0, 1);
  const cy = Math.max(HUD_H + 46, g.h * 0.30);
  const rise = (1 - clamp(s.banner.t / 0.35, 0, 1)) * 18;
  const size = Math.min(Type.huge - 8, g.w * 0.075);
  withGlow(ctx, s.banner.color, 26, () => {
    text(ctx, s.banner.title, g.w / 2, cy - rise, {
      size, color: s.banner.color, align: 'center', weight: 700, alpha: a,
      font: 'ui-serif, "New York", Palatino, Georgia, serif',
    });
  });
  text(ctx, s.banner.sub, g.w / 2, cy + size + 8 - rise, {
    size: Type.small, color: Palette.ink, align: 'center', alpha: a * 0.9,
  });
  text(ctx, T('ENTER for the next hole', '按 ENTER 进入下一洞'), g.w / 2, cy + size + 30 - rise, {
    size: Type.label, color: Palette.dim, align: 'center', alpha: a * 0.8,
  });
}

function drawRound(s, ctx, g) {
  const cx = g.w / 2;
  const vs = s.totalStrokes - TOTAL_PAR;

  titleCard(ctx, g, {
    title: T('ROUND COMPLETE', '本轮结束'),
    tagline: T(`${s.totalStrokes} STROKES  ·  PAR ${TOTAL_PAR}  ·  ${rel(vs)}`, `${s.totalStrokes} 杆  ·  标准杆 ${TOTAL_PAR}  ·  ${rel(vs)}`),
    lines: [
      s.roundBest ? T('NEW BEST ROUND', '新的最佳纪录') : T(`BEST ROUND ${s.bestRound}`, `最佳纪录 ${s.bestRound}`),
      T(`${s.roundsPlayed} round${s.roundsPlayed === 1 ? '' : 's'} played`, `已完成 ${s.roundsPlayed} 轮`),
    ],
    prompt: T('ENTER to play another round', '按 ENTER 再玩一轮'),
    t: s.t,
    accent: vs <= 0 ? Palette.accent : Palette.warm,
  });

  // titleCard centres its block on g.h/2: the title baseline lands at g.h/2 - 70, then
  // +34 for the tagline, +26, one line every 20, and the prompt +22 after the last one.
  // With one tagline and exactly two lines that puts the prompt at g.h/2 + 52, so the
  // scorecard hangs off THAT rather than off a magic constant.
  const promptY = g.h / 2 + 52;
  const cardTop = promptY + 26;
  const cardW = Math.min(660, g.w - 28);
  const padTop = 30, rowH = 50, capH = 20;
  const cardH = padTop + 2 * rowH + capH;
  // Only show the scorecard when it provably clears the prompt AND the canvas floor.
  if (g.w < 470 || cardTop + cardH > g.h - 12) return;

  panel(ctx, cx - cardW / 2, cardTop, cardW, cardH, {
    radius: 6, title: T('SCORECARD', '计分卡'), glowColor: 'rgba(0,0,0,0.55)', glowBlur: 30,
  });

  const colW = (cardW - 44) / 9;
  for (let row = 0; row < 2; row++) {
    const y = cardTop + padTop + row * rowH;
    for (let i = 0; i < 9; i++) {
      const idx = row * 9 + i;
      const x = cx - cardW / 2 + 22 + i * colW + colW / 2;
      const sc = s.scores[idx];
      const d = sc === undefined ? 0 : sc - HOLES[idx].par;
      text(ctx, String(idx + 1), x, y, { size: Type.micro, color: Palette.dim, align: 'center' });
      text(ctx, String(HOLES[idx].par), x, y + 13, {
        size: Type.micro, color: Palette.dim, align: 'center', alpha: 0.55,
      });
      text(ctx, sc === undefined ? '-' : String(sc), x, y + 27, {
        size: Type.body, align: 'center', weight: 700,
        color: sc === undefined ? Palette.dim : d < 0 ? Palette.accent : d === 0 ? Palette.ink : Palette.hot,
      });
    }
  }
  text(ctx, T('HOLE / PAR / SCORE', '球洞 / 标准杆 / 杆数'), cx, cardTop + padTop + 2 * rowH + 2, {
    size: Type.micro, color: Palette.dim, align: 'center', alpha: 0.6,
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

  // Finishing pass on the WORLD only — the HUD is drawn after it, so the strips and
  // their readouts stay at full brightness while the play area falls away at the edges.
  vignette(ctx, g, 0.45);

  drawHud(s, ctx, g);
  if (s.phase === 'sunk') drawBanner(s, ctx, g);
  if (s.phase === 'intro') drawIntro(s, ctx, g);
  if (s.phase === 'round') drawRound(s, ctx, g);
}

// ---------------------------------------------------------------- boot

const game = boot({ id: 'orbital', title: 'Orbital', seed: 1, init, update, render });
mountLangToggle();
mountResetButton('orbital');

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
  check(`all ${HOLE_COUNT} holes parse with a clear tee + goal`, structureOk && HOLE_COUNT >= 18,
    problems.slice(0, 4).join(',') || `${HOLE_COUNT} holes, total par ${TOTAL_PAR}`);

  // ---- 2. the probe responds to injected input: a LIVE drag produces a real launch
  game.restart();
  game.state.phase = 'aim';
  snapCam(game.state, game);
  const st = game.state;
  const teeScreen = worldToScreen(st, game, st.sim.start.x, st.sim.start.y);
  const pullPx = powerToPull(400, game);
  game.input.pointDown(teeScreen.x, teeScreen.y);                                   // grab the probe
  game.step(1);
  game.input.pointTo(teeScreen.x + pullPx * 0.7071, teeScreen.y + pullPx * 0.7071); // pull down-right
  game.step(1);
  const draggingPreview = !!game.state.preview;
  game.input.pointUp(teeScreen.x + pullPx * 0.7071, teeScreen.y + pullPx * 0.7071);
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
  game.input.pointDown(tee.x, tee.y);
  game.step(1);
  game.input.pointTo(px0, py0);
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
  game.input.pointDown(tee2.x, tee2.y);
  game.step(1);
  game.input.pointTo(tee2.x - pl2, tee2.y);    // pull left => fire dead ahead into the planet
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
