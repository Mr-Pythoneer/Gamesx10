// Lexicon — physics word game.
//
// Letters rain into a jar and pile up for real. Drag a path through TOUCHING
// tiles to spell a word; it vaporizes, the pile collapses into the hole, and if
// you can spell again before the dust settles the chain multiplier stacks.
//
// All simulation lives in ./sim.js as pure functions over a plain state object.
// This file only turns the kit's input into an intent, draws the result, and
// makes noise. window.__selftest() drives the exact same stepSim().

import {
  boot, registerSelftest, Palette, FX, Sound, Music, Store,
  clamp, approach, text, roundRect, allFinite, TAU, randomSeedString,
  Type, HUD_H, hudStrip, stat, panel, meter, vignette, titleCard,
  T, mountLangToggle, mountResetButton, registerTranslations,
} from '../../shared/kit.js';
import {
  makeSim, stepSim, addTile, findWord, settle, tileById, totalKE, maxOverlap, outOfBounds,
  scoreFor, chainMult, LETTER_VALUE,
  WORLD_W, WORLD_H, TILE_R, DANGER_Y, MIN_WORD, CHAIN_WINDOW, MAX_TILES,
} from './sim.js';
import { isWord, WORD_COUNT } from './words.js';

// ---------------------------------------------------------------- Background music
// A jaunty 16-step square-wave melody with a light bass note on the downbeats —
// cheerful and puzzle-friendly, kept well under SFX volume.
const LEXICON_MELODY = [
  523.25, 659.25, 783.99, 659.25,   // C5 E5 G5 E5
  587.33, 698.46, 880.00, 698.46,   // D5 F5 A5 F5
  523.25, 659.25, 987.77, 783.99,   // C5 E5 B5 G5
  587.33, 698.46, 659.25, 523.25,   // D5 F5 E5 C5
];
const LEXICON_BASS = [130.81, 146.83, 130.81, 146.83]; // C3 D3 C3 D3, one per 4-step bar

function lexiconMusic(step, atTime, gain) {
  const at = atTime - Sound.ctx.currentTime;
  const note = LEXICON_MELODY[step % LEXICON_MELODY.length];
  if (step % 2 === 0) {
    Sound.tone({ freq: note, dur: 0.16, type: 'square', gain: 0.045 * gain, at });
  }
  if (step % 4 === 0) {
    const bass = LEXICON_BASS[(step / 4) % LEXICON_BASS.length];
    Sound.tone({ freq: bass, dur: 0.3, type: 'square', gain: 0.035 * gain, at });
  }
}

// es/fr/ja/ko for every English string passed as T()'s first argument.
// STAGE_COUNT_FOR_I18N mirrors STAGE_COUNT below (50) — kept local so this
// block can sit above the campaign generator without reordering module init.
const STAGE_COUNT_FOR_I18N = 50;
const stageI18n = {};
for (let i = 0; i < STAGE_COUNT_FOR_I18N; i++) {
  stageI18n['Stage ' + (i + 1)] = {
    es: 'Etapa ' + (i + 1), fr: 'Étape ' + (i + 1), ja: 'ステージ ' + (i + 1), ko: '스테이지 ' + (i + 1),
  };
  stageI18n['STAGE ' + (i + 1) + '/' + STAGE_COUNT_FOR_I18N] = {
    es: 'ETAPA ' + (i + 1) + '/' + STAGE_COUNT_FOR_I18N,
    fr: 'ÉTAPE ' + (i + 1) + '/' + STAGE_COUNT_FOR_I18N,
    ja: 'ステージ ' + (i + 1) + '/' + STAGE_COUNT_FOR_I18N,
    ko: '스테이지 ' + (i + 1) + '/' + STAGE_COUNT_FOR_I18N,
  };
  if (i >= 1) {
    stageI18n['Stage ' + (i + 1) + ' is now unlocked.'] = {
      es: 'La etapa ' + (i + 1) + ' ya está desbloqueada.',
      fr: 'L’étape ' + (i + 1) + ' est maintenant débloquée.',
      ja: 'ステージ ' + (i + 1) + ' が解放されました。',
      ko: '스테이지 ' + (i + 1) + '이(가) 잠금 해제되었습니다.',
    };
  }
}

registerTranslations({
  ...stageI18n,
  'CHAIN ×': { es: 'CADENA ×', fr: 'CHAÎNE ×', ja: 'チェイン ×', ko: '체인 ×' },
  'OVERFLOWING': { es: 'DESBORDADO', fr: 'DÉBORDEMENT', ja: 'あふれています', ko: '넘침' },
  'TOP LINE': { es: 'LÍNEA LÍMITE', fr: 'LIGNE LIMITE', ja: '警戒ライン', ko: '경고선' },
  'score': { es: 'puntos', fr: 'score', ja: 'スコア', ko: '점수' },
  'words': { es: 'palabras', fr: 'mots', ja: '単語数', ko: '단어' },
  'target': { es: 'objetivo', fr: 'objectif', ja: '目標', ko: '목표' },
  'best': { es: 'mejor', fr: 'record', ja: 'ベスト', ko: '최고' },
  'chain': { es: 'cadena', fr: 'chaîne', ja: 'チェイン', ko: '체인' },
  'status': { es: 'estado', fr: 'statut', ja: '状態', ko: '상태' },
  'longest word': { es: 'palabra más larga', fr: 'mot le plus long', ja: '最長単語', ko: '최장 단어' },
  'PILE HEIGHT': { es: 'ALTURA DE LA PILA', fr: 'HAUTEUR DE LA PILE', ja: '山の高さ', ko: '더미 높이' },
  'TILES': { es: 'FICHAS', fr: 'TUILES', ja: 'タイル', ko: '타일' },
  'VOWELS': { es: 'VOCALES', fr: 'VOYELLES', ja: '母音', ko: '모음' },
  'CONSONANTS': { es: 'CONSONANTES', fr: 'CONSONNES', ja: '子音', ko: '자음' },
  'DRAG THROUGH TOUCHING TILES': {
    es: 'ARRASTRA POR FICHAS QUE SE TOQUEN', fr: 'GLISSE SUR DES TUILES QUI SE TOUCHENT',
    ja: '隣り合うタイルをなぞる', ko: '맞닿은 타일을 따라 드래그',
  },
  'RELEASE TO SUBMIT': { es: 'SUELTA PARA ENVIAR', fr: 'RELÂCHE POUR VALIDER', ja: '離して確定', ko: '손을 떼면 제출' },
  'R   RESTART': { es: 'R   REINICIAR', fr: 'R   RECOMMENCER', ja: 'R   リスタート', ko: 'R   재시작' },
  'words found': { es: 'palabras encontradas', fr: 'mots trouvés', ja: '見つけた単語', ko: '찾은 단어' },
  'CHAIN': { es: 'CADENA', fr: 'CHAÎNE', ja: 'チェイン', ko: '체인' },
  'SPELL AGAIN': { es: 'DELETREA OTRA VEZ', fr: 'ÉPELLE ENCORE', ja: 'もう一度つづる', ko: '다시 철자 맞추기' },
  'CLEAR A WORD TO OPEN A CHAIN': {
    es: 'ELIMINA UNA PALABRA PARA ABRIR UNA CADENA', fr: 'ÉLIMINE UN MOT POUR OUVRIR UNE CHAÎNE',
    ja: '単語を消してチェインを開始', ko: '단어를 없애 체인을 시작하세요',
  },
  'RELEASE': { es: 'SUELTA', fr: 'RELÂCHE', ja: 'リリース', ko: '릴리스' },
  'NOT A WORD': { es: 'NO ES UNA PALABRA', fr: 'CE N’EST PAS UN MOT', ja: '単語ではありません', ko: '단어가 아닙니다' },
  'THERE IS A WORD IN THERE': {
    es: 'HAY UNA PALABRA AHÍ DENTRO', fr: 'IL Y A UN MOT LÀ-DEDANS', ja: 'この中に単語が隠れている', ko: '저 안에 단어가 있어요',
  },
  'DRAG THROUGH TOUCHING LETTERS': {
    es: 'ARRASTRA POR LETRAS QUE SE TOQUEN', fr: 'GLISSE SUR DES LETTRES QUI SE TOUCHENT',
    ja: '隣り合う文字をなぞる', ko: '맞닿은 글자를 따라 드래그',
  },
  'CAMPAIGN': { es: 'CAMPAÑA', fr: 'CAMPAGNE', ja: 'キャンペーン', ko: '캠페인' },
  'CLICK A STAGE TO PLAY IT': {
    es: 'HAZ CLIC EN UNA ETAPA PARA JUGARLA', fr: 'CLIQUE SUR UNE ÉTAPE POUR Y JOUER',
    ja: 'ステージをクリックしてプレイ', ko: '스테이지를 클릭해서 플레이하세요',
  },
  'LEXICON': { es: 'LEXICON', fr: 'LEXICON', ja: 'レキシコン', ko: '렉시콘' },
  'Letters rain. Words vaporize. The pile collapses.': {
    es: 'Llueven letras. Las palabras se desvanecen. La pila se derrumba.',
    fr: 'Les lettres pleuvent. Les mots se volatilisent. La pile s’effondre.',
    ja: '文字が降り注ぐ。単語は消え去る。山は崩れ落ちる。',
    ko: '글자가 비처럼 쏟아진다. 단어는 사라진다. 더미는 무너진다.',
  },
  'Drag through TOUCHING letters to spell a word.': {
    es: 'Arrastra por letras que se TOQUEN para deletrear una palabra.',
    fr: 'Glisse à travers des lettres qui SE TOUCHENT pour épeler un mot.',
    ja: '隣り合う文字をなぞって単語をつづろう。',
    ko: '맞닿은 글자를 지나며 드래그해서 단어를 만드세요.',
  },
  '3 letters minimum · release to submit · backtrack to undo': {
    es: 'Mínimo 3 letras · suelta para enviar · retrocede para deshacer',
    fr: '3 lettres minimum · relâche pour valider · reviens en arrière pour annuler',
    ja: '最低3文字・離して確定・逆戻りで取り消し',
    ko: '최소 3글자 · 손을 떼면 제출 · 되돌아가면 취소',
  },
  'Spell again before the rubble settles for a CHAIN multiplier.': {
    es: 'Deletrea otra vez antes de que los escombros se asienten para un multiplicador de CADENA.',
    fr: 'Épelle un autre mot avant que les débris ne se stabilisent pour un multiplicateur de CHAÎNE.',
    ja: '瓦礫が落ち着く前にもう一度つづれば、チェイン倍率が付く。',
    ko: '잔해가 가라앉기 전에 다시 철자를 맞추면 체인 배율을 얻습니다.',
  },
  'Let the pile rest above the top line and it is over.': {
    es: 'Si la pila queda por encima de la línea límite, se acabó.',
    fr: 'Si la pile reste au-dessus de la ligne limite, c’est terminé.',
    ja: '山が警戒ラインより上で止まったら終了です。',
    ko: '더미가 경고선 위에서 멈추면 게임 종료입니다.',
  },
  'Press C for the 50-stage Campaign.': {
    es: 'Pulsa C para la Campaña de 50 etapas.',
    fr: 'Appuie sur C pour la Campagne de 50 étapes.',
    ja: 'Cキーで50ステージのキャンペーンへ。',
    ko: 'C를 눌러 50스테이지 캠페인으로 이동하세요.',
  },
  'CLICK TO START': { es: 'CLIC PARA EMPEZAR', fr: 'CLIQUE POUR COMMENCER', ja: 'クリックしてスタート', ko: '클릭해서 시작' },
  'OVERFLOW': { es: 'DESBORDE', fr: 'DÉBORDEMENT', ja: 'あふれた', ko: '넘침' },
  'The pile overflowed before you reached the target.': {
    es: 'La pila se desbordó antes de que alcanzaras el objetivo.',
    fr: 'La pile a débordé avant que tu n’atteignes l’objectif.',
    ja: '目標に届く前に山があふれてしまった。',
    ko: '목표에 도달하기 전에 더미가 넘쳐버렸습니다.',
  },
  'CLICK OR PRESS R TO RETRY  ·  ESC FOR STAGE SELECT': {
    es: 'CLIC O PULSA R PARA REINTENTAR  ·  ESC PARA ELEGIR ETAPA',
    fr: 'CLIQUE OU APPUIE SUR R POUR RÉESSAYER  ·  ÉCHAP POUR CHOISIR UNE ÉTAPE',
    ja: 'クリックまたはRキーでリトライ　・　ESCでステージ選択',
    ko: '클릭하거나 R을 눌러 재시도  ·  ESC로 스테이지 선택',
  },
  'RETRY': { es: 'REINTENTAR', fr: 'RÉESSAYER', ja: 'リトライ', ko: '다시 시도' },
  'STAGE CLEAR': { es: 'ETAPA SUPERADA', fr: 'ÉTAPE RÉUSSIE', ja: 'ステージクリア', ko: '스테이지 클리어' },
  'That was the last stage — campaign complete!': {
    es: 'Esa era la última etapa: ¡campaña completa!',
    fr: 'C’était la dernière étape — campagne terminée !',
    ja: 'それが最後のステージでした——キャンペーン完了!',
    ko: '그것이 마지막 스테이지였습니다 — 캠페인 완료!',
  },
  'CLICK / SPACE FOR NEXT STAGE  ·  ESC FOR STAGE SELECT': {
    es: 'CLIC / ESPACIO PARA LA SIGUIENTE ETAPA  ·  ESC PARA ELEGIR ETAPA',
    fr: 'CLIQUE / ESPACE POUR L’ÉTAPE SUIVANTE  ·  ÉCHAP POUR CHOISIR UNE ÉTAPE',
    ja: 'クリック／スペースで次のステージへ　・　ESCでステージ選択',
    ko: '클릭 / 스페이스로 다음 스테이지  ·  ESC로 스테이지 선택',
  },
  'NEXT STAGE': { es: 'SIGUIENTE ETAPA', fr: 'ÉTAPE SUIVANTE', ja: '次のステージ', ko: '다음 스테이지' },
  'STAGE SELECT': { es: 'ELEGIR ETAPA', fr: 'CHOIX DE L’ÉTAPE', ja: 'ステージ選択', ko: '스테이지 선택' },
});

const VOWELS = 'aeiou';
const RARE = 'jqxz';

// ---------------------------------------------------------------- campaign

const STAGE_COUNT = 50;
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 50-stage Campaign. Each stage is "reach `target` score before the pile
 * overflows." Difficulty ramps via four independent, clamped levers:
 *   - target      score needed to clear (steady climb, mild acceleration)
 *   - spawnScale  lower = tiles fall faster/more often (sim.js's spawnInterval)
 *   - vowelFloor  the pile-composition floor pickLetter() enforces — lowering it
 *                 allows leaner-vowel piles, never below 0.20 (sim.js clamps this
 *                 too; the floor is what keeps every stage solvable)
 *   - rareCap     how many J/Q/X/Z can sit in the pile before pickLetter() backs
 *                 off — raised only in the back third of the campaign
 *   - dangerY     raises the lose-line in the last 10 stages, shrinking the
 *                 usable jar height instead of only pushing speed/skew
 * The exact formula is mirrored (and load-bearing-verified against the real sim
 * + real dictionary) by the throwaway script described in this game's PR notes.
 */
export const STAGES = (() => {
  const out = [];
  for (let i = 0; i < STAGE_COUNT; i++) {
    const t = i / (STAGE_COUNT - 1);
    out.push({
      index: i,
      name: 'Stage ' + (i + 1),
      nameZh: '关卡 ' + (i + 1),
      target: Math.round(150 + 70 * i + Math.floor(i / 5) * 40),
      spawnScale: lerp(1.35, 0.45, t),
      vowelFloor: lerp(0.30, 0.20, t),
      vowelCeil: 0.55,
      rareCap: i < 30 ? 2 : 3,
      dangerY: i < 40 ? DANGER_Y : Math.round(lerp(DANGER_Y, DANGER_Y + 40, (i - 40) / 9)),
    });
  }
  return out;
})();

function makeStageSim(seed, stage) {
  return makeSim(seed, {
    spawnScale: stage.spawnScale,
    vowelFloor: stage.vowelFloor,
    vowelCeil: stage.vowelCeil,
    rareCap: stage.rareCap,
    dangerY: stage.dangerY,
    target: stage.target,
  });
}

// ---------------------------------------------------------------- view

/**
 * Three-column layout: STATUS panel | jar | WORDS FOUND panel, with a HUD strip
 * above and a dedicated word/hint bar below.
 *
 * The jar is the physics world, so its 420x580 aspect is not negotiable — it is
 * always as tall as the canvas allows. Everything that used to be dead black to
 * either side is now real chrome, which is the whole point: a fixed-aspect column
 * floating in a void reads as unfinished no matter how good the pile looks.
 *
 * ox/oy/scale keep their exact old meaning (screen origin + scale of world 0,0),
 * so toWorldX/toWorldY and every caller of them stay coherent.
 */
function viewOf(g) {
  const compact = g.h < 560 || g.w < 640;
  const hudH = compact ? 46 : HUD_H;
  const barH = g.h < 340 ? 0 : (compact ? 34 : 46);
  const gapTop = compact ? 8 : 14;
  const gapBot = compact ? 8 : 12;
  const availH = Math.max(60, g.h - hudH - gapTop - barH - gapBot);

  let scale = availH / WORLD_H;
  const maxJarW = Math.max(60, g.w - 20);
  if (WORLD_W * scale > maxJarW) scale = maxJarW / WORLD_W;
  const jarW = WORLD_W * scale;
  const jarH = WORLD_H * scale;

  const gutter = compact ? 12 : 18;
  const margin = compact ? 12 : 22;
  let panelW = Math.floor((g.w - margin * 2 - gutter * 2 - jarW) / 2);
  panelW = panelW < 136 ? 0 : Math.min(panelW, 420);

  const clusterW = jarW + (panelW ? (panelW + gutter) * 2 : 0);
  const left = Math.round((g.w - clusterW) / 2);
  const oy = Math.round(hudH + gapTop + (availH - jarH) / 2);

  return {
    scale,
    ox: Math.round(left + (panelW ? panelW + gutter : 0)),
    oy,
    jarW, jarH, hudH, barH, panelW, gutter, left, clusterW, compact,
    barY: barH ? Math.min(g.h - barH - 4, Math.round(oy + jarH + gapBot)) : 0,
  };
}

const toWorldX = (v, sx) => (sx - v.ox) / v.scale;
const toWorldY = (v, sy) => (sy - v.oy) / v.scale;
const toScreenX = (v, wx) => v.ox + wx * v.scale;
const toScreenY = (v, wy) => v.oy + wy * v.scale;

// ---------------------------------------------------------------- game state

const UNLOCK_KEY = 'campaignUnlocked';

function init(g) {
  return {
    phase: 'intro',                 // intro | select | play | cleared | over
    mode: 'endless',                // endless | campaign
    stageIndex: 0,
    unlocked: clamp(Store.get(UNLOCK_KEY, 0), 0, STAGES.length - 1),
    sim: makeSim(g.seed),
    view: viewOf(g),
    pops: [],
    found: [],                      // render-only log of cleared words
    prox: 0,                        // smoothed "how close is the pile to the line"
    best: Store.get('best', 0),
    bestWord: Store.get('longest', ''),
    swallow: false,
    t: 0,
    overT: 0,
    flash: 0,
    goodFlash: 0,
    thudT: 0,
  };
}

function nextSeed(s) {
  return (s.sim.rng.int(1e9) ^ 0x9e3779b9) >>> 0;
}

/** Shared reset of the run-scoped visual/audio state; caller sets s.sim + s.phase. */
function resetRunFx(s, g) {
  s.pops.length = 0;
  s.found.length = 0;
  s.prox = 0;
  s.overT = 0;
  s.flash = 0;
  s.goodFlash = 0;
  s.swallow = g.input.pointer.down;
  FX.reset();
}

function restartRun(s, g) {
  if (s.mode === 'campaign') { startStage(s, g, s.stageIndex); return; }
  s.sim = makeSim(nextSeed(s));
  s.phase = 'play';
  resetRunFx(s, g);
}

function startStage(s, g, idx) {
  idx = clamp(idx, 0, STAGES.length - 1);
  s.mode = 'campaign';
  s.stageIndex = idx;
  s.sim = makeStageSim('stage' + idx + ':' + randomSeedString(), STAGES[idx]);
  s.phase = 'play';
  resetRunFx(s, g);
}

function pop(s, x, y, str, color, size = 20) {
  s.pops.push({ x, y, str, color, size, life: 1.1, max: 1.1 });
  if (s.pops.length > 24) s.pops.shift();
}

function handleEvents(s, g) {
  const v = s.view;
  for (const e of s.sim.events) {
    if (e.type === 'pick') {
      Sound.blip(360 + e.n * 62);
    } else if (e.type === 'unpick') {
      Sound.tone({ freq: 240, dur: 0.05, type: 'square', gain: 0.05 });
    } else if (e.type === 'clear') {
      const mult = chainMult(e.chain);
      s.found.unshift({ word: e.word, gain: e.gain, chain: e.chain });
      if (s.found.length > 16) s.found.pop();
      Sound.ok();
      for (let i = 0; i < e.word.length; i++) {
        Sound.tone({
          freq: 330 * Math.pow(2, (i * 2 + e.chain * 5) / 12),
          dur: 0.1, type: 'triangle', gain: 0.08, at: i * 0.045,
        });
      }
      let cx = 0, cy = 0;
      for (const p of e.pts) {
        cx += p.x; cy += p.y;
        FX.burst(toScreenX(v, p.x), toScreenY(v, p.y), {
          count: 14, color: e.chain > 0 ? Palette.warm : Palette.accent,
          speed: 150 * v.scale, life: 0.55, size: 3 * v.scale, drag: 0.86, gravity: 220 * v.scale,
        });
      }
      cx /= e.pts.length; cy /= e.pts.length;
      pop(s, cx, cy - 14, '+' + e.gain, e.chain > 0 ? Palette.warm : Palette.accent, 24 + e.word.length * 2);
      if (e.chain > 0) pop(s, cx, cy - 44, T('CHAIN ×', '连击 ×') + mult.toFixed(1), Palette.hot, 20);
      FX.shake(3 + e.word.length * 1.2 + e.chain * 4);
      s.goodFlash = 1;
    } else if (e.type === 'reject') {
      Sound.bad();
      FX.shake(2);
      s.flash = 0.7;
    } else if (e.type === 'cleared') {
      Sound.tone({ freq: 520, dur: 0.5, type: 'triangle', gain: 0.18 });
      Sound.tone({ freq: 780, dur: 0.6, type: 'triangle', gain: 0.14, at: 0.09 });
      FX.shake(6);
      s.phase = 'cleared';
      s.overT = 0;
      if (s.mode === 'campaign' && s.stageIndex >= s.unlocked && s.stageIndex + 1 < STAGES.length) {
        s.unlocked = s.stageIndex + 1;
        Store.set(UNLOCK_KEY, s.unlocked);
      }
    } else if (e.type === 'over') {
      Sound.tone({ freq: 180, dur: 0.9, type: 'sawtooth', gain: 0.16, slide: -120 });
      Sound.noise({ dur: 0.7, gain: 0.16, freq: 400 });
      FX.shake(16);
      s.phase = 'over';
      s.overT = 0;
      if (s.mode === 'endless') {
        Store.best('best', s.sim.score);
        s.best = Math.max(s.best, s.sim.score);
        if (s.sim.longest.length > s.bestWord.length) {
          s.bestWord = s.sim.longest;
          Store.set('longest', s.bestWord);
        }
      }
    }
  }
  // landing thuds, throttled so a collapse doesn't machine-gun
  if (s.sim.impact > 0.18 && s.thudT <= 0) {
    Sound.noise({ dur: 0.09, gain: 0.05 + s.sim.impact * 0.09, freq: 320 + s.sim.impact * 500 });
    s.thudT = 0.07;
  }
}

/** 0 = pile is low and safe, 1 = the resting pile has reached the top line. */
function pileProximity(sim) {
  let top = WORLD_H;
  for (const t of sim.tiles) {
    if ((t.asleep || t.still > 8) && t.y - t.r < top) top = t.y - t.r;
  }
  return clamp(1 - (top - sim.dangerY) / 240, 0, 1);
}

function update(s, dt, g) {
  s.view = viewOf(g);
  s.t += dt;
  s.prox = approach(s.prox, pileProximity(s.sim), 0.06, dt);
  if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 2.2);
  if (s.goodFlash > 0) s.goodFlash = Math.max(0, s.goodFlash - dt * 3.4);
  if (s.thudT > 0) s.thudT -= dt;
  for (let i = s.pops.length - 1; i >= 0; i--) {
    const p = s.pops[i];
    p.life -= dt;
    p.y -= 26 * dt;
    if (p.life <= 0) s.pops.splice(i, 1);
  }

  const I = g.input;

  if (s.phase === 'intro') {
    // The opening rain plays behind the title card, so the pile is already alive.
    stepSim(s.sim, { pointer: { x: -9999, y: -9999, down: false }, submit: false }, dt);
    handleEvents(s, g);
    if (I.justPressed('c')) {
      s.phase = 'select';
      Sound.init(); Sound.resume();
      if (!Music.playing) Music.start(lexiconMusic, { bpm: 118, gain: 1 });
      return;
    }
    if (I.pointerPressed || I.justPressed('space') || I.justPressed('enter')) {
      s.mode = 'endless';
      s.phase = 'play';
      s.swallow = I.pointer.down;
      s.sim.t = 0;          // difficulty ramp starts when the player does
      s.sim.idleT = 0;
      Sound.init(); Sound.resume();
      if (!Music.playing) Music.start(lexiconMusic, { bpm: 118, gain: 1 });
    }
    return;
  }

  if (s.phase === 'select') {
    if (I.justPressed('esc')) { s.phase = 'intro'; return; }
    if (I.pointerPressed) {
      const idx = stageAt(g, I.pointer.x, I.pointer.y);
      if (idx !== -1 && idx <= s.unlocked) {
        startStage(s, g, idx);
        Sound.blip(500);
      }
    }
    return;
  }

  if (s.phase === 'cleared') {
    s.overT += dt;
    if (I.justPressed('esc')) { s.phase = 'select'; return; }
    if (s.overT > 0.35 && (I.pointerPressed || I.justPressed('space') || I.justPressed('enter'))) {
      if (s.stageIndex + 1 < STAGES.length) startStage(s, g, s.stageIndex + 1);
      else s.phase = 'select';
    }
    return;
  }

  if (s.phase === 'over') {
    s.overT += dt;
    stepSim(s.sim, { pointer: { x: -9999, y: -9999, down: false }, submit: false }, dt);
    if (s.mode === 'campaign' && I.justPressed('esc')) { s.phase = 'select'; return; }
    if (I.justPressed('r') || (s.overT > 0.45 && (I.pointerPressed || I.justPressed('space') || I.justPressed('enter')))) {
      restartRun(s, g);
    }
    return;
  }

  if (I.justPressed('r')) { restartRun(s, g); return; }
  if (s.swallow && !I.pointer.down) s.swallow = false;

  const intent = {
    pointer: {
      x: toWorldX(s.view, I.pointer.x),
      y: toWorldY(s.view, I.pointer.y),
      down: I.pointer.down && !s.swallow,
    },
    submit: false,
  };
  stepSim(s.sim, intent, dt);
  handleEvents(s, g);
}

// ---------------------------------------------------------------- render

function tileInk(letter) {
  if (VOWELS.includes(letter)) return Palette.accent2;
  if (RARE.includes(letter)) return Palette.violet;
  return Palette.dim;
}

// Tile gradients are defined in the tile's own local space, and every tile shares
// one radius — so a single cached pair covers the whole pile instead of allocating
// 132 gradients a frame.
const _grads = { r: -1, base: null, sel: null };
function tileGrads(ctx, R) {
  if (_grads.r !== R) {
    const base = ctx.createRadialGradient(-R * 0.34, -R * 0.44, R * 0.08, 0, 0, R * 1.3);
    base.addColorStop(0, '#3a4767');
    base.addColorStop(0.5, '#1d2537');
    base.addColorStop(1, '#0c111e');
    const sel = ctx.createRadialGradient(-R * 0.34, -R * 0.44, R * 0.08, 0, 0, R * 1.3);
    sel.addColorStop(0, 'rgba(126,255,214,0.62)');
    sel.addColorStop(0.5, 'rgba(94,242,192,0.26)');
    sel.addColorStop(1, 'rgba(12,44,38,0.95)');
    _grads.r = R; _grads.base = base; _grads.sel = sel;
  }
  return _grads;
}

/**
 * Contact shadows for the whole pile in one fill. Drawn as a separate pass so a
 * tile's shadow can never land on top of the tile in front of it.
 */
function drawTileShadows(ctx, tiles) {
  if (!tiles.length) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  for (const t of tiles) {
    const R = t.r * 0.98;
    ctx.moveTo(t.x + R * 0.05 + R, t.y + R * 0.18);
    ctx.arc(t.x + R * 0.05, t.y + R * 0.18, R, 0, TAU);
  }
  ctx.fill();
  ctx.restore();
}

function drawTile(ctx, t, state, tt) {
  // Drawn a touch smaller than the collision radius: a jammed pile overlaps by a
  // couple of units and this turns that into a clean seam instead of a smear.
  const R = t.r * 0.93;
  const sq = t.squash;
  const sel = state.selSet.has(t.id);
  const hint = state.hintId === t.id;
  const ink = tileInk(t.letter);
  const gr = tileGrads(ctx, R);

  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.scale(1 + sq * 0.24, 1 - sq * 0.24);

  // body — lit from the upper left so the pile has a light direction
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fillStyle = sel ? gr.sel : gr.base;
  ctx.fill();

  // specular cap
  ctx.beginPath();
  ctx.arc(-R * 0.24, -R * 0.32, R * 0.5, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fill();

  // lit rim above, shaded rim below
  const lw = Math.max(1, R * 0.11);
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(0, 0, R - lw * 0.5, Math.PI * 1.06, Math.PI * 1.94);
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, R - lw * 0.5, Math.PI * 0.08, Math.PI * 0.92);
  ctx.strokeStyle = 'rgba(0,0,0,0.40)';
  ctx.stroke();

  // edge
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.lineWidth = sel ? 3 : 1.4;
  ctx.strokeStyle = sel ? Palette.accent : ink;
  ctx.globalAlpha = sel ? 1 : 0.5;
  if (sel) { ctx.shadowColor = Palette.accent; ctx.shadowBlur = 18; }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  if (hint) {
    const p = 0.5 + 0.5 * Math.sin(tt * 4.2);
    ctx.beginPath();
    ctx.arc(0, 0, R + 2 + p * 3.5, 0, TAU);
    ctx.strokeStyle = Palette.warm;
    ctx.globalAlpha = 0.16 + p * 0.42;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  text(ctx, t.letter.toUpperCase(), 0, 1, {
    size: R * 1.16, weight: 700, align: 'center', baseline: 'middle',
    color: sel ? '#eafff8' : Palette.ink,
  });
  text(ctx, String(LETTER_VALUE[t.letter] || 1), R * 0.56, R * 0.5, {
    size: R * 0.4, weight: 600, align: 'center', baseline: 'middle',
    color: sel ? Palette.accent : ink, alpha: 0.85,
  });

  ctx.restore();
}

/** The jar interior: glass, grid, and the danger wash under the top line. */
function drawJar(ctx, sim, tt, heat) {
  const glass = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  glass.addColorStop(0, '#0c1120');
  glass.addColorStop(0.55, '#0a0e19');
  glass.addColorStop(1, '#070a12');
  ctx.fillStyle = glass;
  roundRect(ctx, 0, 0, WORLD_W, WORLD_H, 10);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, 0, 0, WORLD_W, WORLD_H, 10);
  ctx.clip();

  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.42;
  ctx.beginPath();
  for (let x = 60; x < WORLD_W; x += 60) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); }
  for (let y = 60; y < WORLD_H; y += 60) { ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // the danger wash — the band above the top line reddens as the pile climbs
  if (heat > 0.02) {
    const wash = ctx.createLinearGradient(0, 0, 0, DANGER_Y + 40);
    wash.addColorStop(0, 'rgba(255,77,109,' + (0.20 * heat).toFixed(3) + ')');
    wash.addColorStop(1, 'rgba(255,77,109,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, WORLD_W, DANGER_Y + 40);
  }

  // a soft floor bounce light so the bottom of the jar is not a flat void
  const floor = ctx.createLinearGradient(0, WORLD_H - 120, 0, WORLD_H);
  floor.addColorStop(0, 'rgba(59,167,255,0)');
  floor.addColorStop(1, 'rgba(59,167,255,0.07)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, WORLD_H - 120, WORLD_W, 120);
  ctx.restore();

  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0.75, 0.75, WORLD_W - 1.5, WORLD_H - 1.5, 10);
  ctx.stroke();
}

/**
 * The lose threshold, drawn in screen space over the pile so it always reads as a
 * threshold rather than as scenery the tiles bury. It brightens, thickens, speeds
 * up and finally strobes as the pile approaches.
 */
function drawDangerLine(ctx, s, v, tt, dg, heat) {
  const y = Math.round(v.oy + DANGER_Y * v.scale) + 0.5;
  const pulse = 0.5 + 0.5 * Math.sin(tt * (dg > 0 ? 11 : 2.4));
  const col = dg > 0 ? Palette.hot : (heat > 0.5 ? Palette.warm : Palette.accent2);

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, v.ox, v.oy, v.jarW, v.jarH, 10 * v.scale);
  ctx.clip();

  ctx.setLineDash([11, 9]);
  ctx.lineDashOffset = -tt * (18 + dg * 90);
  ctx.lineCap = 'butt';
  ctx.lineWidth = 1.5 + heat * 1.6;
  ctx.strokeStyle = col;
  ctx.shadowColor = col;
  ctx.shadowBlur = 3 + heat * 14 + dg * pulse * 16;
  ctx.globalAlpha = 0.3 + heat * 0.45 + dg * pulse * 0.25;
  ctx.beginPath();
  ctx.moveTo(v.ox, y);
  ctx.lineTo(v.ox + v.jarW, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  // end caps — small solid ticks so the line is anchored to the glass
  ctx.fillStyle = col;
  ctx.globalAlpha = 0.5 + heat * 0.5;
  ctx.fillRect(v.ox, y - 1.5, 10, 3);
  ctx.fillRect(v.ox + v.jarW - 10, y - 1.5, 10, 3);
  ctx.globalAlpha = 1;

  // label chip, inside the glass, legible over whatever is behind it
  if (!v.compact || v.jarW > 240) {
    const fs = v.compact ? 9 : Type.micro;
    const label = dg > 0 ? T('OVERFLOWING', '已溢出') : T('TOP LINE', '警戒线');
    ctx.font = `700 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const tw = ctx.measureText(label).width;
    const cw = tw + 14;
    const cx = v.ox + v.jarW - cw - 7;
    const cy = y + 6;
    ctx.fillStyle = 'rgba(7,8,13,0.82)';
    roundRect(ctx, cx, cy, cw, fs + 9, 3);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.45 + heat * 0.5;
    ctx.lineWidth = 1;
    roundRect(ctx, cx + 0.5, cy + 0.5, cw - 1, fs + 8, 3);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = col;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx + 7, cy + (fs + 9) / 2 + 0.5);
  }
  ctx.restore();
}

function drawChain(ctx, sim, tt) {
  if (sim.sel.length === 0) return;
  const pts = [];
  for (const id of sim.sel) {
    const t = tileById(sim, id);
    if (t) pts.push(t);
  }
  if (!pts.length) return;
  const col = sim.valid ? Palette.accent : (sim.word.length >= MIN_WORD ? Palette.hot : Palette.accent2);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // outer bloom
  ctx.strokeStyle = col;
  ctx.shadowColor = col;
  ctx.shadowBlur = 22;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 13;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();

  // solid body
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 7;
  ctx.stroke();

  // hot core
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();

  // nodes
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, i === pts.length - 1 ? 5 : 3.2, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- chrome

function hline(ctx, x, y, w) {
  ctx.save();
  ctx.strokeStyle = Palette.grid;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + w, y + 0.5);
  ctx.stroke();
  ctx.restore();
}

function drawHud(s, ctx, g, v, dg) {
  const sim = s.sim;
  hudStrip(ctx, g, { h: v.hudH });

  const pad = v.compact ? 14 : 22;
  const vs = v.compact ? 19 : Type.value;
  const ls = v.compact ? 10 : Type.label;
  const y = Math.round((v.hudH - (ls + vs + 2)) / 2 + ls);
  const gap = v.compact ? 112 : 152;

  stat(ctx, pad, y, T('score', '分数'), sim.score, { valueSize: vs, labelSize: ls });
  if (g.w >= 520) {
    stat(ctx, pad + gap, y, T('words', '单词'), sim.wordsMade, {
      color: Palette.accent, valueSize: vs, labelSize: ls,
    });
  }
  if (s.mode === 'campaign') {
    stat(ctx, g.w - pad, y, T('target', '目标'), sim.target, {
      color: sim.score >= sim.target ? Palette.accent : Palette.dim, align: 'right', valueSize: vs, labelSize: ls,
    });
  } else {
    stat(ctx, g.w - pad, y, T('best', '最佳'), Math.max(s.best, sim.score), {
      color: Palette.dim, align: 'right', valueSize: vs, labelSize: ls,
    });
  }
  if (g.w >= 720) {
    const live = sim.chainT > 0;
    stat(ctx, g.w - pad - gap, y, T('chain', '连击'), '×' + chainMult(sim.chain).toFixed(1), {
      color: live ? Palette.hot : Palette.dim, align: 'right', valueSize: vs, labelSize: ls,
    });
  }

  // the overflow countdown lives on the HUD's own edge — impossible to miss,
  // impossible to confuse with anything in the jar
  if (dg > 0.001) {
    ctx.save();
    meter(ctx, 0, v.hudH - 3, g.w, 3, dg, {
      color: Palette.hot, track: 'rgba(0,0,0,0)', radius: 0,
    });
    ctx.restore();
  }
}

function drawStatusPanel(s, ctx, g, v, dg) {
  if (!v.panelW) return;
  const sim = s.sim;
  const x = v.left, y = v.oy, w = v.panelW, h = v.jarH;
  panel(ctx, x, y, w, h, { title: T('status', '状态'), fill: 'rgba(12,16,26,0.9)', radius: 6 });

  const px = x + 14;
  const iw = w - 28;
  const lab = v.compact ? 10 : Type.label;
  const sml = v.compact ? 11 : Type.small;
  const bigV = v.compact ? 20 : 26;
  const wordV = v.compact ? 15 : 20;
  let yy = y + (v.compact ? 42 : 50);

  if (s.mode === 'campaign') {
    stat(ctx, px, yy, T('STAGE ' + (s.stageIndex + 1) + '/' + STAGES.length, '第 ' + (s.stageIndex + 1) + '/' + STAGES.length + ' 关'),
      sim.score + ' / ' + sim.target, { valueSize: bigV, labelSize: lab });
    yy += bigV + (v.compact ? 8 : 10);
    meter(ctx, px, yy, iw, 6, sim.target > 0 ? clamp(sim.score / sim.target, 0, 1) : 0, {
      color: sim.score >= sim.target ? Palette.accent : Palette.warm,
    });
    yy += (v.compact ? 22 : 28);
  } else {
    stat(ctx, px, yy, T('best', '最佳'), Math.max(s.best, sim.score), { valueSize: bigV, labelSize: lab });
    yy += bigV + (v.compact ? 22 : 28);
  }

  const lw = (s.bestWord && s.bestWord.length >= sim.longest.length) ? s.bestWord : sim.longest;
  stat(ctx, px, yy, T('longest word', '最长单词'), lw ? lw.toUpperCase() : '—', {
    color: Palette.accent2, valueSize: wordV, labelSize: lab,
  });
  yy += wordV + (v.compact ? 18 : 24);

  hline(ctx, px, yy, iw);
  yy += v.compact ? 14 : 18;

  // pile height — the thing you actually have to manage
  const heat = clamp(Math.max(s.prox, dg), 0, 1);
  text(ctx, T('PILE HEIGHT', '堆叠高度'), px, yy, { size: lab, weight: 600, color: Palette.dim });
  text(ctx, Math.round(heat * 100) + '%', px + iw, yy, {
    size: lab, weight: 600, color: heat > 0.7 ? Palette.hot : Palette.dim, align: 'right',
  });
  meter(ctx, px, yy + lab + 4, iw, 6, heat, {
    color: heat > 0.72 ? Palette.hot : heat > 0.45 ? Palette.warm : Palette.accent,
  });
  yy += lab + 18;

  text(ctx, T('TILES', '字块'), px, yy, { size: lab, weight: 600, color: Palette.dim });
  text(ctx, sim.tiles.length + ' / ' + MAX_TILES, px + iw, yy, {
    size: lab, weight: 600, color: Palette.dim, align: 'right',
  });
  meter(ctx, px, yy + lab + 4, iw, 6, sim.tiles.length / MAX_TILES, { color: Palette.accent2 });
  yy += lab + (v.compact ? 20 : 24);

  // legend — the tile inks mean something, so say so
  const rowH = v.compact ? 17 : 20;
  const legendH = 14 + rowH * 3;
  const footH = v.compact ? 52 : 62;
  if (y + h - footH - legendH - 8 > yy) {
    hline(ctx, px, yy, iw);
    yy += v.compact ? 12 : 16;
    const rows = [
      [Palette.accent2, T('VOWELS', '元音')],
      [Palette.violet, 'J  Q  X  Z'],
      [Palette.dim, T('CONSONANTS', '辅音')],
    ];
    for (const [c, name] of rows) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(px + 5, yy + 5, 5, 0, TAU);
      ctx.fillStyle = '#151b2a';
      ctx.fill();
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
      text(ctx, name, px + 18, yy, { size: sml, color: Palette.dim, alpha: 0.9 });
      yy += rowH;
    }
  }

  // controls, anchored to the bottom so the panel always has a base
  if (h > 220) {
    const fy = y + h - footH;
    hline(ctx, px, fy - (v.compact ? 8 : 12), iw);
    text(ctx, T('DRAG THROUGH TOUCHING TILES', '拖动经过相邻的字块'), px, fy, { size: lab, weight: 600, color: Palette.dim, alpha: 0.75 });
    text(ctx, T('RELEASE TO SUBMIT', '松开手指提交'), px, fy + rowH, { size: lab, weight: 600, color: Palette.dim, alpha: 0.75 });
    text(ctx, T('R   RESTART', 'R   重新开始'), px, fy + rowH * 2, { size: lab, weight: 600, color: Palette.dim, alpha: 0.75 });
  }
}

function drawWordsPanel(s, ctx, g, v, tt) {
  if (!v.panelW) return;
  const sim = s.sim;
  const x = v.ox + v.jarW + v.gutter;
  const y = v.oy, w = v.panelW, h = v.jarH;
  const live = sim.chainT > 0;
  panel(ctx, x, y, w, h, {
    title: T('words found', '已找单词'), fill: 'rgba(12,16,26,0.9)', radius: 6,
    border: live ? Palette.hot : Palette.grid,
  });

  const px = x + 14;
  const iw = w - 28;
  const lab = v.compact ? 10 : Type.label;
  const sml = v.compact ? 12 : Type.small;

  // chain block, anchored to the bottom of the panel
  const chainH = v.compact ? 56 : 70;
  const cy = y + h - chainH;
  hline(ctx, px, cy, iw);
  const m = chainMult(sim.chain);
  text(ctx, T('CHAIN', '连击'), px, cy + (v.compact ? 10 : 14), { size: lab, weight: 600, color: Palette.dim });
  text(ctx, '×' + m.toFixed(1), px + iw, cy + (v.compact ? 6 : 8), {
    size: v.compact ? 20 : 26, weight: 700, align: 'right',
    color: live ? Palette.hot : Palette.dim, alpha: live ? 1 : 0.55,
  });
  meter(ctx, px, cy + chainH - (v.compact ? 18 : 22), iw, 5,
    live ? clamp(sim.chainT / CHAIN_WINDOW, 0, 1) : 0, { color: Palette.hot });
  text(ctx, live ? T('SPELL AGAIN', '再拼一个') : T('CLEAR A WORD TO OPEN A CHAIN', '拼出一个单词以开启连击'),
    px, cy + chainH - (v.compact ? 11 : 13), {
      size: v.compact ? 9 : Type.micro, weight: 600, alpha: 0.7,
      color: live ? Palette.warm : Palette.dim,
    });

  // the log itself, newest first, fading with age
  const top = y + (v.compact ? 36 : 42);
  const bottom = cy - 10;
  const rowH = v.compact ? 21 : 25;
  const maxRows = Math.max(0, Math.floor((bottom - top) / rowH));
  if (!s.found.length) {
    text(ctx, '—', px, top + 2, { size: sml, color: Palette.dim, alpha: 0.4 });
  }
  for (let i = 0; i < Math.min(maxRows, s.found.length); i++) {
    const f = s.found[i];
    const a = 1 - (i / Math.max(1, maxRows)) * 0.7;
    const ry = top + i * rowH;
    text(ctx, f.word.toUpperCase(), px, ry, {
      size: sml, weight: i === 0 ? 700 : 500, alpha: a,
      color: i === 0 ? Palette.ink : Palette.dim,
    });
    text(ctx, '+' + f.gain, px + iw, ry, {
      size: sml, weight: 700, align: 'right', alpha: a,
      color: f.chain > 0 ? Palette.warm : Palette.accent,
    });
  }
}

/**
 * The reserved word bar. Everything that used to be printed over the pile —
 * the word you are forming, the chain timer, the idle hint — lands here instead,
 * so nothing is ever drawn through a falling tile.
 */
function drawWordBar(s, ctx, g, v, tt) {
  if (!v.barH) return;
  const sim = s.sim;
  const x = v.left, y = v.barY, w = v.clusterW, h = v.barH;
  const forming = sim.word.length > 0;
  const live = sim.chainT > 0;
  const accentCol = forming
    ? (sim.valid ? Palette.accent : (sim.word.length >= MIN_WORD ? Palette.hot : Palette.grid))
    : (live ? Palette.hot : Palette.grid);

  panel(ctx, x, y, w, h, {
    fill: 'rgba(12,16,26,0.92)', radius: 6, border: accentCol,
    glowColor: (forming && sim.valid) || live ? accentCol : null, glowBlur: 18,
  });

  const cx = x + w / 2;
  const mid = y + h / 2;
  const bigS = v.compact ? 19 : 26;
  const sml = v.compact ? 11 : Type.small;

  if (forming) {
    text(ctx, sim.word.toUpperCase().split('').join(' '), cx, mid, {
      size: bigS, weight: 700, align: 'center', baseline: 'middle',
      color: sim.valid ? Palette.accent : Palette.ink, alpha: sim.valid ? 1 : 0.72,
    });
    if (sim.valid) {
      text(ctx, '+' + sim.preview, x + w - 14, mid, {
        size: v.compact ? 15 : 20, weight: 700, align: 'right', baseline: 'middle',
        color: Palette.warm,
      });
      text(ctx, T('RELEASE', '松开'), x + 14, mid, {
        size: sml, weight: 600, baseline: 'middle', color: Palette.dim, alpha: 0.8,
      });
    } else if (sim.word.length >= MIN_WORD) {
      text(ctx, T('NOT A WORD', '不是单词'), x + w - 14, mid, {
        size: sml, weight: 700, align: 'right', baseline: 'middle', color: Palette.hot, alpha: 0.85,
      });
    } else {
      text(ctx, T(MIN_WORD + ' LETTERS MINIMUM', '至少 ' + MIN_WORD + ' 个字母'), x + w - 14, mid, {
        size: sml, weight: 600, align: 'right', baseline: 'middle', color: Palette.dim, alpha: 0.8,
      });
    }
  } else if (live) {
    const a = clamp(sim.chainT / CHAIN_WINDOW, 0, 1);
    text(ctx, T('CHAIN ×' + chainMult(sim.chain).toFixed(1) + '  —  SPELL AGAIN',
      '连击 ×' + chainMult(sim.chain).toFixed(1) + '  —  再拼一个'), cx, mid, {
      size: v.compact ? 14 : 18, weight: 700, align: 'center', baseline: 'middle', color: Palette.hot,
    });
    ctx.save();
    ctx.globalAlpha = 0.8;
    meter(ctx, x + 8, y + h - 6, (w - 16) * a, 3, 1, { color: Palette.hot, track: 'rgba(0,0,0,0)', radius: 0 });
    ctx.restore();
  } else if (sim.hintIds.length && !sim.over) {
    text(ctx, T('THERE IS A WORD IN THERE', '这里面藏着一个单词'), cx, mid, {
      size: v.compact ? 12 : 15, weight: 700, align: 'center', baseline: 'middle',
      color: Palette.warm, alpha: 0.5 + 0.4 * Math.sin(tt * 4.2),
    });
  } else {
    text(ctx, T('DRAG THROUGH TOUCHING LETTERS', '拖动经过相邻的字母'), cx, mid, {
      size: v.compact ? 12 : 15, weight: 600, align: 'center', baseline: 'middle',
      color: Palette.dim, alpha: 0.65,
    });
  }
}

// ---------------------------------------------------------------- stage select

function selectGrid(g) {
  const cols = g.w < 560 ? 5 : 10;
  const rows = Math.ceil(STAGES.length / cols);
  const top = 108;
  const margin = 28;
  const gap = 8;
  const avail = Math.min(g.w - margin * 2, 760);
  const cell = Math.min((avail - gap * (cols - 1)) / cols, (g.h - top - 70 - gap * (rows - 1)) / rows, 64);
  const gridW = cell * cols + gap * (cols - 1);
  const x0 = Math.round((g.w - gridW) / 2);
  return { cols, rows, cell, gap, x0, y0: top };
}

/** Returns the stage index under (x, y) in screen space, or -1. */
function stageAt(g, x, y) {
  const grid = selectGrid(g);
  const cx = Math.floor((x - grid.x0) / (grid.cell + grid.gap));
  const cy = Math.floor((y - grid.y0) / (grid.cell + grid.gap));
  if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return -1;
  const lx = x - grid.x0 - cx * (grid.cell + grid.gap);
  const ly = y - grid.y0 - cy * (grid.cell + grid.gap);
  if (lx > grid.cell || ly > grid.cell) return -1;
  const idx = cy * grid.cols + cx;
  return idx < STAGES.length ? idx : -1;
}

function drawSelect(s, ctx, g, tt) {
  const grad = ctx.createLinearGradient(0, 0, 0, g.h);
  grad.addColorStop(0, Palette.bg);
  grad.addColorStop(1, '#04050a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, g.w, g.h);

  text(ctx, T('CAMPAIGN', '战役模式'), g.w / 2, 46, {
    size: 30, weight: 800, align: 'center', baseline: 'middle', color: Palette.ink,
  });
  text(ctx, T(`stage ${s.unlocked + 1} of ${STAGES.length} unlocked  ·  ESC to go back`,
    `已解锁第 ${s.unlocked + 1} / ${STAGES.length} 关  ·  按 ESC 返回`), g.w / 2, 76, {
    size: 13, weight: 600, align: 'center', baseline: 'middle', color: Palette.dim,
  });

  const grid = selectGrid(g);
  for (let i = 0; i < STAGES.length; i++) {
    const cx = i % grid.cols, cy = Math.floor(i / grid.cols);
    const x = grid.x0 + cx * (grid.cell + grid.gap);
    const y = grid.y0 + cy * (grid.cell + grid.gap);
    const locked = i > s.unlocked;
    const current = i === s.stageIndex;
    ctx.save();
    roundRect(ctx, x, y, grid.cell, grid.cell, 6);
    ctx.fillStyle = locked ? 'rgba(20,24,36,0.7)' : (current ? 'rgba(94,242,192,0.16)' : 'rgba(28,34,52,0.85)');
    ctx.fill();
    ctx.lineWidth = current ? 2 : 1;
    ctx.strokeStyle = locked ? Palette.grid : (current ? Palette.accent : Palette.dim);
    ctx.globalAlpha = locked ? 0.4 : 0.9;
    ctx.stroke();
    ctx.globalAlpha = 1;
    text(ctx, String(i + 1), x + grid.cell / 2, y + grid.cell / 2, {
      size: Math.max(11, grid.cell * 0.32), weight: 700, align: 'center', baseline: 'middle',
      color: locked ? Palette.dim : Palette.ink, alpha: locked ? 0.45 : 1,
    });
    ctx.restore();
  }

  const chip = grid.y0 + grid.rows * (grid.cell + grid.gap) + 20;
  text(ctx, T('CLICK A STAGE TO PLAY IT', '点击一关开始游戏'), g.w / 2, chip, {
    size: 13, weight: 600, align: 'center', baseline: 'middle', color: Palette.dim, alpha: 0.7,
  });
}

// ---------------------------------------------------------------- frame

function render(s, ctx, g) {
  if (s.phase === 'select') { drawSelect(s, ctx, g, s.t); return; }

  const v = s.view;
  const sim = s.sim;
  const tt = s.t;
  const dg = clamp(sim.overflowT / 0.9, 0, 1);
  const heat = clamp(Math.max(s.prox * 0.92, dg), 0, 1);

  // backdrop
  const grad = ctx.createLinearGradient(0, 0, 0, g.h);
  grad.addColorStop(0, Palette.bg);
  grad.addColorStop(1, '#04050a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, g.w, g.h);

  s.selSet = new Set(sim.sel);
  s.hintId = sim.hintIds.length ? sim.hintIds[0] : -1;

  // the jar reads as a lit object sitting in the layout, not a hole cut in black
  ctx.save();
  ctx.shadowColor = dg > 0 ? Palette.hot : 'rgba(59,167,255,0.45)';
  ctx.shadowBlur = 24 + dg * 30;
  ctx.fillStyle = '#0a0e18';
  roundRect(ctx, v.ox, v.oy, v.jarW, v.jarH, 10 * v.scale);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(v.ox, v.oy);
  ctx.scale(v.scale, v.scale);

  drawJar(ctx, sim, tt, heat);

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, 0, 0, WORLD_W, WORLD_H, 10);
  ctx.clip();
  drawTileShadows(ctx, sim.tiles);
  for (const t of sim.tiles) drawTile(ctx, t, s, tt);
  drawChain(ctx, sim, tt);
  ctx.restore();

  for (const p of s.pops) {
    const a = clamp(p.life / p.max, 0, 1);
    text(ctx, p.str, p.x, p.y, {
      size: p.size, weight: 700, align: 'center', baseline: 'middle',
      color: p.color, alpha: a * a,
    });
  }

  ctx.restore();

  drawDangerLine(ctx, s, v, tt, dg, heat);

  FX.draw(ctx);

  // ---- chrome
  drawHud(s, ctx, g, v, dg);
  drawStatusPanel(s, ctx, g, v, dg);
  drawWordsPanel(s, ctx, g, v, tt);
  drawWordBar(s, ctx, g, v, tt);

  // ---- flashes
  if (s.goodFlash > 0) {
    ctx.save();
    ctx.globalAlpha = s.goodFlash * 0.1;
    ctx.fillStyle = Palette.accent;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
  }
  if (s.flash > 0) {
    ctx.save();
    ctx.globalAlpha = s.flash * 0.14;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
  }

  vignette(ctx, g, 0.45);

  // ---- overlays
  if (s.phase === 'intro') {
    titleCard(ctx, g, {
      title: T('LEXICON', '词典'),
      tagline: T('Letters rain. Words vaporize. The pile collapses.',
        '字母如雨落下,拼出的单词会消失,堆叠随之坍塌。'),
      lines: [
        T('Drag through TOUCHING letters to spell a word.', '拖动经过相邻的字母来拼出一个单词。'),
        T('3 letters minimum · release to submit · backtrack to undo',
          '至少 3 个字母 · 松手提交 · 回退可撤销'),
        T('Spell again before the rubble settles for a CHAIN multiplier.',
          '在碎块落定前再拼一个单词,即可获得连击加成。'),
        T('Let the pile rest above the top line and it is over.', '堆叠一旦停在警戒线以上,游戏结束。'),
        T('Press C for the 50-stage Campaign.', '按 C 进入 50 关战役模式。'),
      ],
      prompt: T('CLICK TO START', '点击开始'),
      t: tt,
      accent: Palette.accent,
    });
  }

  if (s.phase === 'over') {
    ctx.save();
    ctx.fillStyle = 'rgba(7,8,13,' + clamp(s.overT * 1.6, 0, 0.9).toFixed(3) + ')';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
    if (s.overT > 0.18) {
      ctx.save();
      ctx.globalAlpha = clamp((s.overT - 0.18) * 3.2, 0, 1);
      if (s.mode === 'campaign') {
        const stage = STAGES[s.stageIndex];
        titleCard(ctx, g, {
          title: T('OVERFLOW', '已溢出'),
          tagline: T(stage.name, stage.nameZh) + '  ·  ' + sim.score + ' / ' + stage.target,
          lines: [
            T('The pile overflowed before you reached the target.', '在达到目标之前,堆叠已经溢出。'),
            T('CLICK OR PRESS R TO RETRY  ·  ESC FOR STAGE SELECT', '点击或按 R 重试  ·  按 ESC 返回选关'),
          ],
          prompt: T('RETRY', '重试'),
          t: tt,
          accent: Palette.hot,
        });
      } else {
        titleCard(ctx, g, {
          title: 'OVERFLOW',
          tagline: sim.score + ' POINTS',
          lines: [
            sim.wordsMade + ' words · longest ' + (sim.longest ? sim.longest.toUpperCase() : '—')
              + ' · best chain ×' + chainMult(sim.bestChain).toFixed(1),
            'personal best ' + Math.max(s.best, sim.score)
              + (s.bestWord ? '  ·  ' + s.bestWord.toUpperCase() : ''),
          ],
          prompt: 'CLICK OR PRESS R',
          t: tt,
          accent: Palette.hot,
        });
      }
      ctx.restore();
    }
  }

  if (s.phase === 'cleared') {
    ctx.save();
    ctx.fillStyle = 'rgba(7,8,13,' + clamp(s.overT * 1.6, 0, 0.9).toFixed(3) + ')';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
    if (s.overT > 0.15) {
      const stage = STAGES[s.stageIndex];
      const hasNext = s.stageIndex + 1 < STAGES.length;
      ctx.save();
      ctx.globalAlpha = clamp((s.overT - 0.15) * 3.2, 0, 1);
      titleCard(ctx, g, {
        title: T('STAGE CLEAR', '通关'),
        tagline: T(stage.name, stage.nameZh) + '  ·  ' + sim.score + ' / ' + stage.target,
        lines: [
          hasNext
            ? T('Stage ' + (s.stageIndex + 2) + ' is now unlocked.', '第 ' + (s.stageIndex + 2) + ' 关已解锁。')
            : T('That was the last stage — campaign complete!', '这是最后一关——通关完成!'),
          T('CLICK / SPACE FOR NEXT STAGE  ·  ESC FOR STAGE SELECT', '点击或空格进入下一关  ·  按 ESC 返回选关'),
        ],
        prompt: hasNext ? T('NEXT STAGE', '下一关') : T('STAGE SELECT', '选关'),
        t: tt,
        accent: Palette.accent,
      });
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------- boot

const game = boot({
  id: 'lexicon',
  title: 'Lexicon',
  seed: randomSeedString(),
  init, update, render,
});
mountLangToggle();
mountResetButton('lexicon');

// ---------------------------------------------------------------- self-test

const IDLE = { pointer: { x: -9999, y: -9999, down: false }, submit: false };

/** Lay a word out along the floor, left to right, tiles just touching. */
function layWord(sim, word, x0, y) {
  const out = [];
  for (let i = 0; i < word.length; i++) out.push(addTile(sim, word[i], x0 + i * 46, y));
  return out;
}

function drag(sim, tiles, dt) {
  const seen = [];
  for (const t of tiles) {
    stepSim(sim, { pointer: { x: t.x, y: t.y, down: true }, submit: false }, dt);
    stepSim(sim, { pointer: { x: t.x, y: t.y, down: true }, submit: false }, dt);
    seen.push(sim.sel.length);
  }
  const last = tiles[tiles.length - 1];
  stepSim(sim, { pointer: { x: last.x, y: last.y, down: false }, submit: false }, dt);
  return seen;
}

registerSelftest('lexicon', (check, log) => {
  const dt = 1 / 60;
  const FLOOR = WORLD_H - TILE_R;

  // 1. world initializes + dictionary is live
  const s0 = makeSim('LEX-INIT');
  check('world initializes with falling tiles', s0.tiles.length === 16 && s0.score === 0 && !s0.over,
    `tiles=${s0.tiles.length}`);
  check('dictionary loads', isWord('house') === true && isWord('zzzzq') === false && WORD_COUNT > 50000,
    `WORD_COUNT=${WORD_COUNT}`);
  check('letter distribution is playable', (() => {
    let ok = 0;
    for (let i = 0; i < 12; i++) {
      const p = makeSim('PLAY' + i, { prefill: 30, autoSpawn: false });
      settle(p, 700);
      if (findWord(p)) ok++;
    }
    log('piles containing a findable word: ' + ok + '/12');
    return ok >= 11;
  })(), 'random settled piles contain a word');

  // 2. injected drag grows the selection
  const s1 = makeSim('LEX-SEL', { prefill: 0, autoSpawn: false });
  const cat = layWord(s1, 'cat', 60, FLOOR);
  settle(s1, 200);
  const grew = drag(s1, cat, dt);
  check('drag grows the selection 1,2,3', grew.length === 3 && grew[0] === 1 && grew[1] === 2 && grew[2] === 3,
    `lengths=${grew.join(',')}`);

  // 3. a valid word scores and removes exactly those tiles
  check('valid word scores', s1.score === scoreFor('cat', 0) && s1.score > 0, `score=${s1.score}`);
  check('valid word removes its tiles', s1.tiles.length === 0, `tiles=${s1.tiles.length}`);
  check('longest word tracked', s1.longest === 'cat', s1.longest);

  // 9. an invalid word changes nothing
  const s2 = makeSim('LEX-BAD', { prefill: 0, autoSpawn: false });
  const junk = layWord(s2, 'qxj', 60, FLOOR);
  settle(s2, 200);
  drag(s2, junk, dt);
  check('invalid word is rejected', s2.score === 0 && s2.tiles.length === 3 && s2.wordsMade === 0,
    `score=${s2.score} tiles=${s2.tiles.length}`);

  // non-touching tiles cannot be chained
  const s3 = makeSim('LEX-GAP', { prefill: 0, autoSpawn: false });
  const gapped = [addTile(s3, 'c', 60, FLOOR), addTile(s3, 'a', 200, FLOOR), addTile(s3, 't', 340, FLOOR)];
  settle(s3, 200);
  drag(s3, gapped, dt);
  check('separated tiles cannot be chained', s3.tiles.length === 3 && s3.score === 0,
    `tiles=${s3.tiles.length}`);

  // 4. WIN-equivalent: a clear collapses the pile and the next clear chains
  const s4 = makeSim('LEX-CHAIN', { prefill: 0, autoSpawn: false });
  layWord(s4, 'cat', 60, FLOOR);
  layWord(s4, 'dog', 60, FLOOR - 46);
  settle(s4, 400);
  const topY = Math.min(...s4.tiles.filter((t) => 'dog'.includes(t.letter)).map((t) => t.y));
  drag(s4, s4.tiles.filter((t) => 'cat'.includes(t.letter)), dt);
  const afterFirst = s4.score;
  check('first clear removes 3 of 6 tiles', s4.tiles.length === 3 && afterFirst === scoreFor('cat', 0),
    `tiles=${s4.tiles.length} score=${afterFirst}`);
  settle(s4, 90);
  const fellY = Math.min(...s4.tiles.map((t) => t.y));
  check('the collapse actually drops the tiles above', fellY > topY + 20,
    `top ${topY.toFixed(1)} -> ${fellY.toFixed(1)}`);
  drag(s4, s4.tiles.slice(), dt);
  check('chain multiplier triggers on the follow-up clear',
    s4.chain === 1 && s4.lastMult > 1 && s4.lastGain === scoreFor('dog', 1) && s4.lastGain > scoreFor('dog', 0),
    `chain=${s4.chain} mult=${s4.lastMult} gain=${s4.lastGain} vs unchained ${scoreFor('dog', 0)}`);
  check('board is clear and scored', s4.tiles.length === 0 && s4.score === afterFirst + s4.lastGain,
    `score=${s4.score}`);

  // 5. LOSE is reachable — flood the jar and let it overflow the top line
  const s5 = makeSim('LEX-LOSE', { prefill: 20, spawnScale: 0.12 });
  let f = 0;
  for (; f < 2400 && !s5.over; f++) stepSim(s5, IDLE, dt);
  check('lose condition reachable (pile overflows the top line)', s5.over === true,
    `over=${s5.over} frames=${f} tiles=${s5.tiles.length}`);

  // 6. no NaN/Infinity after a long chaotic run
  const s6 = makeSim('LEX-NAN', { prefill: 24, spawnScale: 0.35 });
  for (let i = 0; i < 700; i++) {
    stepSim(s6, {
      pointer: { x: (i * 37) % WORLD_W, y: 260 + ((i * 71) % 300), down: i % 5 < 3 },
      submit: false,
    }, dt);
  }
  const fin = allFinite(s6);
  check('no NaN/Infinity after 700 frames of falling tiles', fin.ok, fin.bad.slice(0, 4).join(','));
  check('tile count is capped', s6.tiles.length <= MAX_TILES, `tiles=${s6.tiles.length}`);

  // 8. PHYSICS STABILITY — settled means settled
  let worstKE = 0, worstOv = 0, escaped = 0, unsettled = 0;
  for (let i = 0; i < 6; i++) {
    const p = makeSim('LEX-PHYS' + i, { prefill: 40, autoSpawn: false });
    if (settle(p, 900) >= 900) unsettled++;
    worstKE = Math.max(worstKE, totalKE(p));
    worstOv = Math.max(worstOv, maxOverlap(p));
    escaped += outOfBounds(p).length;
  }
  check('settled piles have ~zero kinetic energy (no eternal jitter)', worstKE < 1 && unsettled === 0,
    `maxKE=${worstKE.toFixed(4)} unsettled=${unsettled}`);
  check('no tile escapes the jar', escaped === 0, `escaped=${escaped}`);
  check('no tile overlaps another by more than a small tolerance', worstOv <= 3.5,
    `maxOverlap=${worstOv.toFixed(2)} of ${TILE_R * 2} diameter`);

  // determinism: same seed + same intents => identical run
  const dA = makeSim('LEX-DET', { prefill: 20 });
  const dB = makeSim('LEX-DET', { prefill: 20 });
  for (let i = 0; i < 240; i++) {
    const it = { pointer: { x: 90 + (i % 40) * 6, y: 430, down: i % 7 < 3 }, submit: false };
    stepSim(dA, it, dt); stepSim(dB, it, dt);
  }
  const fingerprint = (s) => s.tiles.map((t) => `${t.id}${t.letter}${t.x.toFixed(5)}${t.y.toFixed(5)}`).join('|') + s.score;
  check('same seed + same intents replay identically', fingerprint(dA) === fingerprint(dB));

  // hint search finds a real, connected, valid word
  const h = makeSim('LEX-HINT', { prefill: 40, autoSpawn: false });
  settle(h, 900);
  const hit = findWord(h);
  check('hint search returns a valid connected word', !!hit && isWord(hit.word) && (() => {
    for (let i = 1; i < hit.ids.length; i++) {
      const a = tileById(h, hit.ids[i - 1]), b = tileById(h, hit.ids[i]);
      if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r + 5.001) return false;
    }
    return true;
  })(), hit ? hit.word : 'no word found');

  // --- LIVE game, driven through the kit's own input path
  game.restart();
  game.state.phase = 'play';
  game.state.swallow = false;
  const live = game.state.sim;
  live.tiles.length = 0;
  live.autoSpawn = false;
  const word = layWord(live, 'pig', 70, FLOOR);
  game.step(180);
  const v = game.state.view;
  const before = live.score;
  const seen = [];
  for (const t of word) {
    game.input.pointDown(toScreenX(v, t.x), toScreenY(v, t.y));
    game.step(2);
    seen.push(live.sel.length);
  }
  game.input.pointUp(toScreenX(v, word[2].x), toScreenY(v, word[2].y));
  game.step(2);
  check('live game selects through kit pointer input', seen.join(',') === '1,2,3', `sel=${seen.join(',')}`);
  check('live game scores and clears the word', live.score > before && live.tiles.length === 0,
    `score ${before} -> ${live.score}, tiles=${live.tiles.length}`);
  check('live state stays finite', allFinite(game.state.sim).ok);

  // --- Campaign: STAGES structure, stage init, target-reachable, unlock persistence
  check('STAGES has exactly 50 stages', STAGES.length === 50, `n=${STAGES.length}`);
  check('stage targets climb monotonically', STAGES.every((st, i) => i === 0 || st.target > STAGES[i - 1].target),
    STAGES.map((st) => st.target).join(','));
  check('spawnScale never increases (tiles only speed up)',
    STAGES.every((st, i) => i === 0 || st.spawnScale <= STAGES[i - 1].spawnScale + 1e-9));
  check('vowelFloor stays in the clamped, playable band [0.20, 0.30]',
    STAGES.every((st) => st.vowelFloor >= 0.20 && st.vowelFloor <= 0.30),
    STAGES.map((st) => st.vowelFloor.toFixed(2)).join(','));
  check('dangerY only rises (playfield only shrinks) in the last 10 stages',
    STAGES.every((st, i) => (i < 40 ? st.dangerY === DANGER_Y : st.dangerY >= DANGER_Y) && st.dangerY <= DANGER_Y + 60),
    STAGES.map((st) => st.dangerY).join(','));

  // stage init wires the sim's tuning knobs through
  const stg5 = STAGES[5];
  const simStg5 = makeStageSim('LEX-STG5', stg5);
  check('makeStageSim wires target/spawnScale/vowelFloor/dangerY onto the sim',
    simStg5.target === stg5.target && simStg5.spawnScale === stg5.spawnScale
      && simStg5.vowelFloor === stg5.vowelFloor && simStg5.dangerY === stg5.dangerY,
    `target=${simStg5.target} spawnScale=${simStg5.spawnScale} vowelFloor=${simStg5.vowelFloor} dangerY=${simStg5.dangerY}`);

  // target-reachable: a tiny target clears the instant a valid word is scored
  const clearSim = makeSim('LEX-CLEAR', { prefill: 0, autoSpawn: false, target: 1 });
  const clearWord = layWord(clearSim, 'cat', 60, FLOOR);
  settle(clearSim, 200);
  drag(clearSim, clearWord, dt);
  check('stage clears the instant score reaches target', clearSim.cleared === true && clearSim.score >= 1,
    `cleared=${clearSim.cleared} score=${clearSim.score}`);

  // unlock persistence — drive the live game through a real stage clear and confirm Store persists it
  game.restart();
  game.state.mode = 'campaign';
  game.state.stageIndex = 0;
  game.state.unlocked = 0;
  game.state.phase = 'play';
  game.state.sim = makeSim('LEX-UNLOCK', { prefill: 0, autoSpawn: false, target: 1 });
  const unlockWord = layWord(game.state.sim, 'dog', 70, FLOOR);
  game.step(180);
  const uv = game.state.view;
  for (const t of unlockWord) { game.input.pointDown(toScreenX(uv, t.x), toScreenY(uv, t.y)); game.step(2); }
  game.input.pointUp(toScreenX(uv, unlockWord[2].x), toScreenY(uv, unlockWord[2].y));
  game.step(2);
  check('clearing a stage flips phase to cleared and unlocks the next one',
    game.state.phase === 'cleared' && game.state.unlocked === 1,
    `phase=${game.state.phase} unlocked=${game.state.unlocked}`);
  check('unlock is persisted to Store', Store.get(UNLOCK_KEY, -1) === 1, `stored=${Store.get(UNLOCK_KEY, -1)}`);
  Store.set(UNLOCK_KEY, 0); // leave the persisted save as we found it

  game.restart();
  log(`words=${WORD_COUNT} jar=${WORLD_W}x${WORLD_H} r=${TILE_R} cap=${MAX_TILES}`);
});

// dev console handles
globalThis.__lexicon = { makeSim, stepSim, findWord, settle, addTile, scoreFor, game, STAGES };

export default game;
