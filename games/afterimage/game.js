// Afterimage — every death or retry records your run as a ghost; the ghost replays
// forever, solid to you (stand on its head) but see-through to other ghosts. Levels are
// built so you cannot reach the goal alone — a ghost must hold a pressure plate open,
// or stand still so you can climb it.
//
// Architecture: sim.js holds the pure, cloneable simulation (makeSim/stepSim), driven
// by per-frame input masks only — no Math.random(), no Date.now(). The live game and
// the self-test call the exact same stepSim, so physics can never drift apart.

import {
  boot, registerSelftest, Palette, FX, Sound, Store, Music,
  clamp, text, roundRect, allFinite, TAU,
  Type, HUD_H, hudStrip, stat, panel, meter, orb, vignette, titleCard, withGlow,
  T, mountLangToggle, mountResetButton, registerTranslations,
} from '../../shared/kit.js';
import { LEVELS } from './levels.js';

registerTranslations({
  'LEVEL': { es: 'NIVEL', fr: 'NIVEAU', ja: 'レベル', ko: '레벨' },
  'GHOSTS': { es: 'FANTASMAS', fr: 'FANTÔMES', ja: '幻影', ko: '환영' },
  'RUN': { es: 'INTENTOS', fr: 'ESSAIS', ja: '試行', ko: '시도' },
  'BEST': { es: 'MEJOR', fr: 'MEILLEUR', ja: 'ベスト', ko: '최고' },
  'GHOST PAR': { es: 'PAR FANTASMA', fr: 'PAR FANTÔME', ja: '幻影パー', ko: '환영 파' },
  'HINT': { es: 'PISTA', fr: 'INDICE', ja: 'ヒント', ko: '힌트' },
  '← →  MOVE     SPACE  JUMP     R  RETRY': {
    es: '← →  MOVER     ESPACIO  SALTAR     R  REINTENTAR',
    fr: '← →  DÉPLACER     ESPACE  SAUTER     R  RÉESSAYER',
    ja: '← →  移動     SPACE  ジャンプ     R  リトライ',
    ko: '← →  이동     SPACE  점프     R  재시도',
  },
  'NEW BEST': { es: 'NUEVO RÉCORD', fr: 'NOUVEAU RECORD', ja: '自己ベスト更新', ko: '신기록' },
  'AFTERIMAGE': { es: 'REMANENCIA', fr: 'RÉMANENCE', ja: '残像', ko: '잔상' },
  'Death or retry records your run as a ghost.': {
    es: 'Morir o reintentar convierte tu partida en un fantasma.',
    fr: 'Mourir ou recommencer enregistre ta partie sous forme de fantôme.',
    ja: '死ぬかリトライすると、そのプレイが幻影として記録される。',
    ko: '죽거나 다시 시도하면 그 플레이가 환영으로 기록된다.',
  },
  'Park a ghost on a plate to hold a door open.': {
    es: 'Deja un fantasma sobre una placa para mantener una puerta abierta.',
    fr: 'Place un fantôme sur une plaque pour maintenir une porte ouverte.',
    ja: '幻影を踏板の上に残せば、扉は開いたままになる。',
    ko: '압력판 위에 환영을 남겨두면 문이 계속 열려 있는다.',
  },
  "Climb a ghost's head to reach higher ledges.": {
    es: 'Sube a la cabeza de un fantasma para alcanzar salientes más altos.',
    fr: "Grimpe sur la tête d'un fantôme pour atteindre des rebords plus hauts.",
    ja: '幻影の頭に乗って、高い足場まで登ろう。',
    ko: '환영의 머리를 밟고 더 높은 발판에 올라가자.',
  },
  'PRESS SPACE': { es: 'PULSA ESPACIO', fr: 'APPUYEZ SUR ESPACE', ja: 'スペースキーを押して', ko: '스페이스바를 누르세요' },
  'ALL CLEAR': { es: 'TODO SUPERADO', fr: 'TOUT TERMINÉ', ja: '全クリア', ko: '올 클리어' },
  'ENTER TO RUN IT BACK': { es: 'ENTER PARA REPETIRLO', fr: 'ENTRÉE POUR REJOUER', ja: 'Enterでもう一度', ko: '엔터로 다시 플레이' },
  'First Echo': { es: 'Primer Eco', fr: 'Premier Écho', ja: '最初の残響', ko: '첫 번째 메아리' },
  'Stand on the plate, then retry — your ghost will hold it for you.': {
    es: 'Párate sobre la placa y luego reintenta: tu fantasma la sostendrá por ti.',
    fr: 'Reste sur la plaque, puis recommence : ton fantôme la maintiendra pour toi.',
    ja: '踏板の上に立ってからリトライしよう。幻影が代わりに踏み続けてくれる。',
    ko: '압력판 위에 서 있다가 다시 시도해봐. 환영이 대신 밟아줄 거야.',
  },
  'Stepping Stone': { es: 'Peldaño', fr: 'Marchepied', ja: '踏み台', ko: '디딤돌' },
  'A ghost standing still is still standing. Climb it.': {
    es: 'Un fantasma quieto sigue de pie. Súbete a él.',
    fr: 'Un fantôme immobile reste debout. Grimpe dessus.',
    ja: '静止した幻影も、そこに立ち続けている。その上に登ろう。',
    ko: '가만히 있는 환영도 여전히 서 있다. 그 위에 올라타자.',
  },
  'Two Hands': { es: 'Dos Manos', fr: 'Deux Mains', ja: '二つの手', ko: '두 손' },
  'Hop onto a ledge plate, then retry. Two ghosts, two doors.': {
    es: 'Salta a una placa elevada y luego reintenta. Dos fantasmas, dos puertas.',
    fr: 'Saute sur une plaque en hauteur, puis recommence. Deux fantômes, deux portes.',
    ja: '高台の踏板に飛び乗ってからリトライしよう。幻影が二体、扉が二つ。',
    ko: '높은 곳의 압력판으로 뛰어올랐다가 다시 시도해봐. 환영 둘, 문 둘.',
  },
  'Three of a Kind': { es: 'Trío', fr: 'Trio', ja: '三重奏', ko: '삼중주' },
  'Two ledges to hold the doors, one more to boost you over the last wall.': {
    es: 'Dos salientes para sostener las puertas, y uno más para impulsarte sobre el último muro.',
    fr: 'Deux rebords pour maintenir les portes, et un dernier pour te faire franchir le mur final.',
    ja: '扉を支える足場が二つ、そして最後の壁を越えるための踏み台がもう一つ。',
    ko: '문을 지탱할 발판이 두 개, 그리고 마지막 벽을 넘게 해줄 발판이 하나 더.',
  },
});
import {
  makeSim, stepSim, retryRun, replaySolution,
  TILE, PW, PH, M_LEFT, M_RIGHT, M_JUMP, GHOST_CAP,
} from './sim.js';

const MAX_LEVEL_KEY = 'maxLevel';

// ---------------------------------------------------------------- game state

function init(g) {
  const startLevel = clamp(Store.get(MAX_LEVEL_KEY, 0), 0, LEVELS.length - 1);
  return {
    levelIndex: startLevel,
    sim: makeSim(startLevel, LEVELS),
    phase: 'intro',        // intro | play | dying | cleared | complete
    timer: 0,
    flash: 0,
    hintT: 0,
    totalDeaths: Store.get('deaths', 0),
    runDeaths: 0,
  };
}

function loadLevel(s, idx) {
  s.levelIndex = clamp(idx, 0, LEVELS.length - 1);
  s.sim = makeSim(s.levelIndex, LEVELS);
  s.hintT = 3.0;
}

function currentMask(g) {
  const I = g.input;
  let m = 0;
  if (I.isDown('left') || I.isDown('a')) m |= M_LEFT;
  if (I.isDown('right') || I.isDown('d')) m |= M_RIGHT;
  if (I.isDown('space') || I.isDown('up') || I.isDown('w')) m |= M_JUMP;
  return m;
}

function pushTrail(sim) {
  for (const g of sim.ghosts) {
    if (!g.trail) g.trail = [];
    if (g.visible) {
      g.trail.push({ x: g.x, y: g.y });
      if (g.trail.length > 10) g.trail.shift();
    }
  }
}

// Sparse, wistful minor-key loop — each note echoes itself quietly ~0.3s later,
// literalizing the ghost-replay theme in the music itself.
const AFTERIMAGE_SCALE = [220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00]; // A minor (nat.)
// Three sparse phrase variations, so the melody the echoes are chasing keeps
// shifting slightly over a longer macro-cycle instead of looping forever.
const AFTERIMAGE_PHRASES = [
  { 0: 0, 6: 3, 12: 2, 20: 4, 28: 1, 36: 3, 44: 5, 52: 2, 58: 0 },
  { 0: 2, 8: 4, 14: 1, 22: 5, 30: 3, 38: 0, 46: 4, 54: 1 },
  { 0: 0, 4: 2, 16: 5, 24: 3, 32: 1, 40: 4, 48: 2, 56: 6 },
];
// Very quiet sustained low pad, shifts root occasionally, stays under the melody.
const AFTERIMAGE_PAD_ROOTS = [110.00, 98.00, 130.81]; // A2, G2, C3
function afterimageMusic(step, atTime, gain) {
  const bar = step % 64;
  const cycle = Math.floor(step / 64);
  const phrase = AFTERIMAGE_PHRASES[cycle % AFTERIMAGE_PHRASES.length];
  const t0 = atTime - Sound.ctx.currentTime;
  const idx = phrase[bar];
  if (idx !== undefined) {
    const freq = AFTERIMAGE_SCALE[idx];
    Sound.tone({ freq, dur: 0.9, type: 'triangle', gain: 0.045 * gain, at: t0 });
    Sound.tone({ freq, dur: 0.5, type: 'triangle', gain: 0.018 * gain, at: t0 + 0.3 });
  }
  // quiet sustained low pad note, re-struck once per macro-cycle, root shifts slowly
  if (bar === 0) {
    const root = AFTERIMAGE_PAD_ROOTS[Math.floor(cycle / 2) % AFTERIMAGE_PAD_ROOTS.length];
    Sound.tone({ freq: root, dur: 6.5, type: 'sine', gain: 0.02 * gain, at: t0, attack: 1.2 });
  }
}

function update(s, dt, g) {
  s.flash = Math.max(0, s.flash - dt * 3);
  if (s.hintT > 0) s.hintT -= dt;

  if (s.phase === 'intro') {
    if (g.input.justPressed('space') || g.input.justPressed('enter') || g.input.pointerPressed) {
      s.phase = 'play';
      s.hintT = 3.0;
      Sound.init(); Sound.resume();
      if (!Music.playing) Music.start(afterimageMusic, { bpm: 66, gain: 1 });
    }
    return;
  }

  if (s.phase === 'complete') {
    if (g.input.justPressed('enter')) {
      Store.set(MAX_LEVEL_KEY, 0);
      s.runDeaths = 0;
      loadLevel(s, 0);
      s.phase = 'play';
    }
    return;
  }

  if (s.phase === 'dying') {
    s.timer -= dt;
    if (s.timer <= 0) { loadLevel(s, s.levelIndex); s.phase = 'play'; }
    return;
  }

  if (s.phase === 'cleared') {
    s.timer -= dt;
    if (s.timer <= 0) {
      const next = s.levelIndex + 1;
      if (next >= LEVELS.length) {
        s.phase = 'complete';
      } else {
        Store.set(MAX_LEVEL_KEY, Math.max(Store.get(MAX_LEVEL_KEY, 0), next));
        loadLevel(s, next);
        s.phase = 'play';
      }
    }
    return;
  }

  // --- playing
  if (g.input.justPressed('r')) {
    s.runDeaths++;
    s.totalDeaths++;
    Store.set('deaths', s.totalDeaths);
    retryRun(s.sim, false);
    Sound.blip(420);
    FX.burst(s.sim.player.x + PW / 2, s.sim.player.y + PH / 2, { count: 10, color: Palette.violet, speed: 70, life: 0.4, size: 2.5 });
    return;
  }

  stepSim(s.sim, currentMask(g), dt);
  pushTrail(s.sim);

  if (s.sim.dead) {
    s.runDeaths++;
    s.totalDeaths++;
    Store.set('deaths', s.totalDeaths);
    s.phase = 'dying'; s.timer = 0.34; s.flash = 1;
    FX.shake(9);
    Sound.bad();
    const p = s.sim.player;
    FX.burst(p.x + PW / 2, p.y + PH / 2, { count: 22, color: Palette.hot, speed: 150, life: 0.45, size: 3, gravity: 300 });
  } else if (s.sim.won) {
    s.phase = 'cleared'; s.timer = 0.6;
    const par = LEVELS[s.levelIndex].par;
    const used = s.sim.runsUsed;
    const improved = Store.best('best' + s.levelIndex, used, false);
    const p = s.sim.player;
    FX.burst(p.x + PW / 2, p.y + PH / 2, { count: 26, color: Palette.accent, speed: 110, life: 0.55, size: 3 });
    FX.shake(5);
    Sound.ok();
    s.lastUsed = used;
    s.lastPar = par;
    s.lastImproved = improved;
  }
}

// ---------------------------------------------------------------- render — helpers

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Structural tones. These are the game's existing surface colours; everything else
// is an alpha variant of the shared Palette so the arcade keeps one hue set.
const C_WALL = '#1c2436';
const C_WALL_TOP = '#28324a';
const C_LEDGE = '#3a4666';
const C_PLATE = '#4a5578';

/** Alpha variant of a Palette hex. Bit ops coerce a bad parse to 0, so never "NaN". */
function rgba(hex, a) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full, 16);
  const A = Number.isFinite(a) ? clamp(a, 0, 1) : 1;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${A})`;
}

const DIM_70 = rgba(Palette.dim, 0.7);
const ACCENT_12 = rgba(Palette.accent, 0.12);
const ACCENT_35 = rgba(Palette.accent, 0.35);
const ACCENT_95 = rgba(Palette.accent, 0.95);
const WARM_55 = rgba(Palette.warm, 0.55);
const WARM_22 = rgba(Palette.warm, 0.22);
const HOT_50 = rgba(Palette.hot, 0.5);
const WARM_28 = rgba(Palette.warm, 0.28);
const GRID_LINE = rgba(Palette.dim, 0.13);
const BG_85 = rgba(Palette.bg, 0.85);
const SHADE_18 = 'rgba(0,0,0,0.18)';
const SHADE_35 = 'rgba(0,0,0,0.35)';
const SHADE_45 = 'rgba(0,0,0,0.45)';
const LIT_12 = 'rgba(255,255,255,0.12)';
const LIT_16 = 'rgba(255,255,255,0.16)';
const LIT_55 = 'rgba(255,255,255,0.55)';

function measureWith(ctx, str, font) {
  ctx.save();
  ctx.font = font;
  const w = ctx.measureText(String(str)).width;
  ctx.restore();
  return Number.isFinite(w) ? w : 0;
}

/** Greedy word wrap capped at maxLines, with a hard-truncated final line. */
function wrapLines(ctx, str, maxW, size, maxLines) {
  const font = `500 ${size}px ${MONO}`;
  const s = String(str);
  // CJK text carries no spaces between words, so the space-splitter below would treat
  // the whole string as one unbreakable "word" and let it run past maxW. Detect that
  // case and wrap per-character instead — safe for Latin text too, just unnecessary.
  const units = /\s/.test(s) ? s.split(/\s+/).filter(Boolean) : s.split('');
  const joiner = /\s/.test(s) ? ' ' : '';
  const all = [];
  let cur = '';
  for (const w of units) {
    const trial = cur ? cur + joiner + w : w;
    if (cur && measureWith(ctx, trial, font) > maxW) { all.push(cur); cur = w; } else cur = trial;
  }
  if (cur) all.push(cur);
  if (all.length <= maxLines) return all;
  const out = all.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last.length > 1 && measureWith(ctx, last + '...', font) > maxW) last = last.slice(0, -1);
  out[maxLines - 1] = last + '...';
  return out;
}

/**
 * One layout for the whole screen: the HUD strip owns the top, the hint bar owns a
 * reserved slab at the bottom, and the framed playfield gets exactly what is left.
 * Because the scale subtracts the frame padding first, the frame can never creep
 * under the HUD or over the hint bar at any viewport size.
 */
const FRAME_PAD = 10;

function layout(g, level, compact) {
  const barH = compact ? 42 : 34;
  const gap = compact ? 8 : 12;
  const side = compact ? 8 : 14;
  const top = HUD_H + gap;
  const barY = Math.max(top + 20, g.h - barH - gap);
  const bottom = barY - gap;
  const availW = Math.max(60, g.w - side * 2);
  const availH = Math.max(48, bottom - top);
  const scale = Math.max(0.05, Math.min(
    (availW - FRAME_PAD * 2) / (level.cols * TILE),
    (availH - FRAME_PAD * 2) / (level.rows * TILE),
  ));
  const w = level.cols * TILE * scale, h = level.rows * TILE * scale;
  const x = (g.w - w) / 2;
  const y = top + (availH - h) / 2;
  return {
    x, y, scale, w, h,
    frame: { x: x - FRAME_PAD, y: y - FRAME_PAD, w: w + FRAME_PAD * 2, h: h + FRAME_PAD * 2 },
    barX: side, barW: Math.max(80, g.w - side * 2), barY, barH,
  };
}

/**
 * Render-side mirror of the sim's plate test (same 3px touch pad as
 * overlapsRectTouch) so the drawn mechanism state matches what physics does.
 */
function computeDoorState(sim) {
  const level = sim.level;
  const open = { 1: false, 2: false, 3: false, 4: false };
  const bodies = [];
  for (const gh of sim.ghosts) if (gh.visible) bodies.push(gh);
  bodies.push(sim.player);
  for (let r = 0; r < level.rows; r++) {
    const row = level.grid[r];
    for (let c = 0; c < level.cols; c++) {
      const ch = row[c];
      if (ch < '1' || ch > '4') continue;
      const id = ch.charCodeAt(0) - 48;
      if (open[id]) continue;
      const rx = c * TILE, ry = r * TILE;
      for (const b of bodies) {
        if (b.x < rx + TILE + 3 && b.x + PW > rx - 3 && b.y < ry + TILE + 3 && b.y + PH > ry - 3) {
          open[id] = true; break;
        }
      }
    }
  }
  return open;
}

/** A body with depth: soft halo, vertical gradient, rim light, single pixel eye. */
function drawBody(ctx, x, y, { color, alpha = 1, halo = 0, glow = 0, eye = false, face = 1 }) {
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  const cx = x + PW / 2, cy = y + PH / 2;
  if (halo > 0) {
    const grd = ctx.createRadialGradient(cx, cy, 0.5, cx, cy, halo);
    grd.addColorStop(0, rgba(color, 0.40));
    grd.addColorStop(0.45, rgba(color, 0.13));
    grd.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(cx, cy, halo, 0, TAU);
    ctx.fill();
  }
  if (glow > 0) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  const body = ctx.createLinearGradient(x, y, x, y + PH);
  body.addColorStop(0, rgba(color, 1));
  body.addColorStop(1, rgba(color, 0.68));
  ctx.fillStyle = body;
  roundRect(ctx, x, y, PW, PH, 2.5);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 0.6;
  roundRect(ctx, x + 0.4, y + 0.4, PW - 0.8, PH - 0.8, 2.2);
  ctx.stroke();
  if (eye) {
    ctx.fillStyle = BG_85;
    ctx.fillRect(x + PW / 2 - 1 + (face > 0 ? 1.2 : -1.2), y + 3.4, 2, 2);
  }
  ctx.restore();
}

/** Motion blur, not a row of stamps: a tapered stroke along the recorded path. */
function drawSmear(ctx, trail, color, baseAlpha) {
  if (!trail || trail.length < 2) return;
  let len = 0;
  for (let i = 1; i < trail.length; i++) {
    len += Math.abs(trail[i].x - trail[i - 1].x) + Math.abs(trail[i].y - trail[i - 1].y);
  }
  if (len < 1.5) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  const last = trail.length - 1;
  for (let i = 1; i <= last; i++) {
    const f = i / last;
    ctx.globalAlpha = clamp(baseAlpha * 0.34 * f * f, 0, 1);
    ctx.lineWidth = PW * (0.28 + 0.56 * f);
    ctx.beginPath();
    ctx.moveTo(trail[i - 1].x + PW / 2, trail[i - 1].y + PH / 2);
    ctx.lineTo(trail[i].x + PW / 2, trail[i].y + PH / 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- render — chrome

function drawHUD(s, ctx, g, compact) {
  hudStrip(ctx, g);

  const total = LEVELS.length;
  const idx = clamp(s.levelIndex, 0, total - 1);
  const lvValue = `${String(idx + 1).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
  const lvSize = compact ? Type.body : Type.value;
  stat(ctx, 18, 20, T('LEVEL', '关卡'), lvValue, { valueSize: lvSize, color: Palette.ink });
  const lvW = measureWith(ctx, lvValue, `700 ${lvSize}px ${MONO}`);

  // Right cluster, laid out right-to-left so the most important figure hugs the edge.
  const items = [{
    label: T('GHOSTS', '幻影'),
    value: `${s.sim.ghosts.length}/${GHOST_CAP}`,
    color: Palette.violet,
    size: compact ? Type.body : Type.value,
  }, {
    label: T('RUN', '次数'), value: String(s.sim.runsUsed), color: Palette.ink, size: Type.body,
  }];
  if (!compact) {
    const best = Store.get('best' + idx, null);
    if (typeof best === 'number' && Number.isFinite(best)) {
      items.push({ label: T('BEST', '最佳'), value: String(best), color: Palette.accent, size: Type.body });
    }
    items.push({
      label: T('GHOST PAR', '标准次数'), value: String(s.sim.level.par), color: Palette.dim,
      size: Type.body, labelColor: DIM_70,
    });
  }

  const gap = compact ? 20 : 28;
  let x = g.w - 18;
  for (const it of items) {
    stat(ctx, x, 20, it.label, it.value, {
      align: 'right', valueSize: it.size, color: it.color, labelColor: it.labelColor || Palette.dim,
    });
    const wLab = measureWith(ctx, it.label, `600 ${Type.label}px ${MONO}`) + it.label.length * Type.label * 0.14;
    const wVal = measureWith(ctx, it.value, `700 ${it.size}px ${MONO}`);
    x -= Math.max(wLab, wVal) + gap;
  }
  const clusterLeft = x + gap;

  // The level name is secondary: it appears only when it genuinely fits.
  const lvl = s.sim.level;
  const name = T(String(lvl.name || ''), String(lvl.nameZh || lvl.name || '')).toUpperCase();
  const nameX = 18 + lvW + 14;
  const nameFont = `600 ${Type.small}px ${MONO}`;
  if (name && nameX + measureWith(ctx, name, nameFont) < clusterLeft - 14) {
    text(ctx, name, nameX, 20 + lvSize + 2, {
      size: Type.small, color: Palette.dim, baseline: 'alphabetic', weight: 600,
    });
  }

  // Campaign progress rides the bottom edge of the strip.
  meter(ctx, 0, HUD_H - 3, g.w, 3, (idx + 1) / total, {
    color: Palette.accent, track: 'rgba(255,255,255,0.05)', radius: 0, glow: false,
  });
}

function drawHintBar(s, ctx, g, lay, compact) {
  const { barX, barW, barY, barH } = lay;
  panel(ctx, barX, barY, barW, barH, {
    fill: 'rgba(13,16,24,0.86)', border: Palette.grid, radius: 4,
  });

  const fresh = clamp(s.hintT / 0.6, 0, 1);
  let tx = barX + 14;
  let avail = barW - 28;

  if (!compact) {
    // A marker that lights while the hint is new, then settles.
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.75 * fresh;
    ctx.fillStyle = Palette.accent;
    ctx.fillRect(barX + 1, barY + 6, 2, barH - 12);
    ctx.restore();

    const hintLabel = T('HINT', '提示');
    text(ctx, hintLabel, tx, barY + barH / 2 + 4, {
      size: Type.label, color: DIM_70, baseline: 'alphabetic', weight: 600,
    });
    const labW = measureWith(ctx, hintLabel, `600 ${Type.label}px ${MONO}`) + hintLabel.length * Type.label * 0.14;
    tx += labW + 14;

    const keys = T('← →  MOVE     SPACE  JUMP     R  RETRY', '← →  移动     SPACE  跳跃     R  重试');
    const keysW = measureWith(ctx, keys, `500 ${Type.label}px ${MONO}`);
    text(ctx, keys, barX + barW - 14, barY + barH / 2 + 4, {
      size: Type.label, color: DIM_70, align: 'right', baseline: 'alphabetic', weight: 500,
    });
    avail = Math.max(60, barX + barW - 14 - keysW - 20 - tx);
  }

  const size = compact ? 11 : Type.small;
  const hintStr = T(s.sim.level.hint || '', s.sim.level.hintZh || s.sim.level.hint || '');
  const lines = wrapLines(ctx, hintStr, avail, size, compact ? 2 : 1);
  const step = size + 3;
  let ty = barY + (barH - lines.length * step) / 2 + size;
  for (const line of lines) {
    text(ctx, line, compact ? barX + barW / 2 : tx, ty, {
      size, color: Palette.ink, align: compact ? 'center' : 'left',
      baseline: 'alphabetic', alpha: 0.5 + 0.5 * fresh,
    });
    ty += step;
  }
}

// ---------------------------------------------------------------- render — playfield

function drawTiles(s, ctx, level, doorOpen, hair, t) {
  const W = level.cols * TILE, H = level.rows * TILE;

  ctx.fillStyle = Palette.bg2;
  ctx.fillRect(0, 0, W, H);
  const depth = ctx.createLinearGradient(0, 0, 0, H);
  depth.addColorStop(0, 'rgba(255,255,255,0.02)');
  depth.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = depth;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = hair;
  ctx.beginPath();
  for (let c = 1; c < level.cols; c++) { ctx.moveTo(c * TILE, 0); ctx.lineTo(c * TILE, H); }
  for (let r = 1; r < level.rows; r++) { ctx.moveTo(0, r * TILE); ctx.lineTo(W, r * TILE); }
  ctx.stroke();
  ctx.restore();

  const isWall = (rr, cc) => rr >= 0 && rr < level.rows && cc >= 0 && cc < level.cols && level.grid[rr][cc] === '#';

  for (let r = 0; r < level.rows; r++) {
    for (let c = 0; c < level.cols; c++) {
      const ch = level.grid[r][c];
      const bx = c * TILE, by = r * TILE;

      if (ch === '#') {
        ctx.fillStyle = C_WALL;
        ctx.fillRect(bx, by, TILE, TILE);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(bx, by, TILE, TILE);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(bx, by + TILE * 0.55, TILE, TILE * 0.45);
        if (!isWall(r - 1, c)) {
          ctx.fillStyle = C_WALL_TOP;
          ctx.fillRect(bx, by, TILE, 2.5);
          ctx.fillStyle = LIT_16;
          ctx.fillRect(bx, by, TILE, 0.9);
        }
        if (!isWall(r + 1, c)) { ctx.fillStyle = SHADE_35; ctx.fillRect(bx, by + TILE - 1.5, TILE, 1.5); }
        if (!isWall(r, c - 1)) { ctx.fillStyle = SHADE_18; ctx.fillRect(bx, by, 1, TILE); }
        if (!isWall(r, c + 1)) { ctx.fillStyle = SHADE_18; ctx.fillRect(bx + TILE - 1, by, 1, TILE); }

      } else if (ch === '^') {
        withGlow(ctx, Palette.hot, 5, () => {
          ctx.fillStyle = Palette.hot;
          ctx.beginPath();
          for (let k = 0; k < 4; k++) {
            ctx.moveTo(bx + k * 4, by + TILE);
            ctx.lineTo(bx + k * 4 + 2, by + TILE - 7);
            ctx.lineTo(bx + k * 4 + 4, by + TILE);
          }
          ctx.fill();
        });
        ctx.fillStyle = HOT_50;
        ctx.fillRect(bx, by + TILE - 1, TILE, 1);

      } else if (ch === '_') {
        // A floating one-way ledge is landed on at its tile's TOP edge, but a
        // floor-mounted one is walked over — so the plate sits on whichever edge the
        // player actually meets. Drawing both the same way is what made bodies look
        // like they were hovering a tile above the thing they stand on.
        const topY = isWall(r + 1, c) ? by + TILE - 4 : by;
        ctx.fillStyle = C_LEDGE;
        ctx.fillRect(bx, topY, TILE, 3);
        ctx.fillStyle = LIT_16;
        ctx.fillRect(bx, topY, TILE, 0.9);
        ctx.fillStyle = SHADE_35;
        ctx.fillRect(bx, topY + 2.2, TILE, 1.4);

      } else if (ch >= '1' && ch <= '4') {
        // Pressure plate: a cap on a housing that visibly sinks and lights under
        // weight. Same edge rule as the one-way ledge above.
        const id = ch.charCodeAt(0) - 48;
        const active = !!doorOpen[id];
        const drop = active ? 1.3 : 0;
        const grounded = isWall(r + 1, c);
        const capY = (grounded ? by + TILE - 3.4 : by) + drop;
        const houseY = grounded ? by + TILE - 5.4 : by + 1.4;
        ctx.fillStyle = SHADE_45;
        ctx.fillRect(bx + 1, houseY, TILE - 2, 5.2);
        if (active) { ctx.save(); ctx.shadowColor = Palette.accent; ctx.shadowBlur = 8; }
        ctx.fillStyle = active ? Palette.accent : C_PLATE;
        roundRect(ctx, bx + 1, capY, TILE - 2, 3.2, 1.2);
        ctx.fill();
        if (active) ctx.restore();
        ctx.fillStyle = active ? LIT_55 : LIT_12;
        ctx.fillRect(bx + 2, capY + 0.4, TILE - 4, 0.8);
        text(ctx, String(id), bx + TILE / 2, grounded ? by + TILE - 6 : by + 13, {
          size: 5.5, color: active ? ACCENT_95 : DIM_70, align: 'center', baseline: 'bottom', weight: 700,
        });

      } else if (ch >= 'a' && ch <= 'd') {
        const id = ch.charCodeAt(0) - 96;
        const open = !!doorOpen[id];
        if (!open) {
          // Closed: a solid slab, lit, with machined grooves.
          ctx.save();
          ctx.shadowColor = Palette.warm;
          ctx.shadowBlur = 6;
          const slab = ctx.createLinearGradient(bx, 0, bx + TILE, 0);
          slab.addColorStop(0, rgba(Palette.warm, 0.55));
          slab.addColorStop(0.5, rgba(Palette.warm, 0.92));
          slab.addColorStop(1, rgba(Palette.warm, 0.55));
          ctx.fillStyle = slab;
          ctx.fillRect(bx + 0.5, by, TILE - 1, TILE);
          ctx.restore();
          ctx.fillStyle = 'rgba(0,0,0,0.24)';
          for (let k = 1; k < 4; k++) ctx.fillRect(bx + 0.5, by + k * (TILE / 4) - 0.4, TILE - 1, 0.8);
          text(ctx, String(id), bx + TILE / 2, by + TILE / 2 + 2.5, {
            size: 6, color: BG_85, align: 'center', baseline: 'alphabetic', weight: 700,
          });
        } else {
          // Open: the slab has retracted into its housings, leaving a lit doorway.
          ctx.fillStyle = WARM_28;
          ctx.fillRect(bx + 0.5, by, 1, TILE);
          ctx.fillRect(bx + TILE - 1.5, by, 1, TILE);
          ctx.fillStyle = WARM_55;
          ctx.fillRect(bx + 1.5, by, TILE - 3, 2.5);
          ctx.fillRect(bx + 1.5, by + TILE - 2.5, TILE - 3, 2.5);
          ctx.save();
          ctx.strokeStyle = WARM_22;
          ctx.lineWidth = hair;
          ctx.setLineDash([1.5, 2.5]);
          ctx.beginPath();
          ctx.moveTo(bx + TILE / 2, by + 3);
          ctx.lineTo(bx + TILE / 2, by + TILE - 3);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
          text(ctx, String(id), bx + TILE / 2, by + TILE / 2 + 2.5, {
            size: 6, color: WARM_55, align: 'center', baseline: 'alphabetic', weight: 700,
          });
        }
      }
    }
  }

  // goal
  const gx = level.goal.x * TILE + TILE / 2, gy = level.goal.y * TILE + TILE / 2;
  const pulse = 0.55 + 0.45 * Math.sin(t * 3);
  const won = !!s.sim.won;
  ctx.save();
  ctx.globalAlpha = won ? 1 : 0.4 + 0.5 * pulse;
  ctx.strokeStyle = Palette.accent;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = Palette.accent;
  ctx.shadowBlur = won ? 12 : 6;
  roundRect(ctx, gx - TILE / 2 + 2.5, gy - TILE / 2 + 2.5, TILE - 5, TILE - 5, 3);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.14 * (won ? 1.8 : pulse);
  ctx.fillStyle = Palette.accent;
  ctx.fill();
  ctx.restore();
  orb(ctx, gx, gy, 1.6 + pulse * 0.9, Palette.accent, { glow: 0.8, rim: false });
}

function drawPlayfield(s, ctx, g, lay, t) {
  const level = s.sim.level;
  const f = lay.frame;

  panel(ctx, f.x, f.y, f.w, f.h, {
    fill: 'rgba(9,12,19,0.96)', border: Palette.grid, radius: 6,
    glowColor: ACCENT_12, glowBlur: 30,
  });

  ctx.save();
  roundRect(ctx, f.x + 1, f.y + 1, f.w - 2, f.h - 2, 5);
  ctx.clip();
  ctx.translate(lay.x, lay.y);
  ctx.scale(lay.scale, lay.scale);

  const hair = 1 / lay.scale;
  drawTiles(s, ctx, level, computeDoorState(s.sim), hair, t);

  // ghosts — older ones fade back, each dragging a soft smear
  const n = s.sim.ghosts.length;
  for (let i = 0; i < n; i++) {
    const gh = s.sim.ghosts[i];
    if (!gh.visible) continue;
    const age = n - i; // 1 = newest
    const a = clamp(0.52 - (age - 1) * 0.075, 0.13, 0.52);
    drawSmear(ctx, gh.trail, Palette.violet, a);
    drawBody(ctx, gh.x, gh.y, {
      color: Palette.violet, alpha: a, halo: 8 + (1 - a) * 2, glow: 5, face: gh.face,
    });
  }

  // the living player, unmistakably brighter than anything it left behind
  if (!s.sim.player.dead) {
    const p = s.sim.player;
    drawBody(ctx, p.x, p.y, {
      color: s.sim.won ? Palette.accent : Palette.warm,
      alpha: 1, halo: s.sim.won ? 18 : 14, glow: s.sim.won ? 14 : 9, eye: true, face: p.face,
    });
  }

  // particles live in level space, so bursts land on the character that made them
  FX.draw(ctx);
  ctx.restore();
}

// ---------------------------------------------------------------- render

function render(s, ctx, g) {
  const t = g.t;
  const compact = g.w < 760;
  const lay = layout(g, s.sim.level, compact);

  ctx.fillStyle = Palette.bg;
  ctx.fillRect(0, 0, g.w, g.h);

  drawPlayfield(s, ctx, g, lay, t);
  drawHUD(s, ctx, g, compact);
  drawHintBar(s, ctx, g, lay, compact);

  if (s.flash > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(s.flash * 0.28, 0, 1);
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.restore();
  }

  if (s.phase === 'cleared' && Number.isFinite(s.lastUsed)) {
    const a = clamp(s.timer / 0.6, 0, 1);
    const msg = T(`CLEARED IN ${s.lastUsed} RUN${s.lastUsed === 1 ? '' : 'S'}`, `用了 ${s.lastUsed} 次通关`);
    const sub = s.lastImproved ? T('NEW BEST', '新纪录')
      : (Number.isFinite(s.lastPar) ? T(`GHOST PAR ${s.lastPar}`, `标准次数 ${s.lastPar}`) : '');
    const bw = Math.min(g.w - 40, 340);
    const bh = sub ? 76 : 54;
    const bx = (g.w - bw) / 2, by = g.h / 2 - bh / 2;
    ctx.save();
    ctx.globalAlpha = a;
    panel(ctx, bx, by, bw, bh, {
      fill: 'rgba(13,16,24,0.94)', border: ACCENT_35, radius: 6,
      glowColor: ACCENT_35, glowBlur: 26,
    });
    ctx.restore();
    text(ctx, msg, g.w / 2, by + 34, {
      size: Type.body, color: Palette.accent, align: 'center', baseline: 'alphabetic', weight: 700, alpha: a,
    });
    if (sub) {
      text(ctx, sub, g.w / 2, by + 58, {
        size: Type.label, color: s.lastImproved ? Palette.warm : Palette.dim,
        align: 'center', baseline: 'alphabetic', weight: 600, alpha: a,
      });
    }
  }

  if (s.phase === 'intro') {
    titleCard(ctx, g, {
      title: T('AFTERIMAGE', '残影'),
      tagline: T('Death or retry records your run as a ghost.', '死亡或重试,都会把这一次操作录成一个幻影。'),
      lines: [
        T('Park a ghost on a plate to hold a door open.', '把幻影停在压力板上,门就会一直开着。'),
        T("Climb a ghost's head to reach higher ledges.", '踩着幻影的头,爬上更高的台子。'),
        '',
        T('← →  MOVE     SPACE  JUMP     R  RETRY', '← →  移动     SPACE  跳跃     R  重试'),
      ],
      prompt: T('PRESS SPACE', '按空格键开始'),
      t, accent: Palette.accent,
    });
  }

  if (s.phase === 'complete') {
    const d = Number.isFinite(s.runDeaths) ? s.runDeaths : 0;
    titleCard(ctx, g, {
      title: T('ALL CLEAR', '全部通关'),
      tagline: T(`${LEVELS.length} levels, every echo spent.`, `${LEVELS.length} 个关卡,每一次回响都用上了。`),
      lines: [T(`${d} retr${d === 1 ? 'y' : 'ies'} this run.`, `本轮重试了 ${d} 次。`)],
      prompt: T('ENTER TO RUN IT BACK', '按回车再玩一次'),
      t, accent: Palette.accent,
    });
  }

  vignette(ctx, g, 0.4);
}

// ---------------------------------------------------------------- boot + self-test

const game = boot({ id: 'afterimage', title: 'Afterimage', seed: 1, init, update, render });
mountLangToggle();
mountResetButton('afterimage');

registerSelftest('afterimage', (check, log) => {
  const dt = 1 / 60;

  // 1. world initializes
  const s0 = makeSim(0, LEVELS);
  check('level 0 initializes with a player and empty ghost list', !!s0.player && s0.ghosts.length === 0,
    `ghosts=${s0.ghosts.length}`);
  check('every level parses with a spawn and goal', LEVELS.every((_, i) => {
    const s = makeSim(i, LEVELS);
    return s.level.spawn && s.level.goal && s.player.x > 0;
  }), `${LEVELS.length} levels`);

  // 2. input actually moves the player — assert a real state delta
  const s1 = makeSim(0, LEVELS);
  const x0 = s1.player.x;
  for (let i = 0; i < 30; i++) stepSim(s1, M_RIGHT, dt);
  check('RIGHT moves the player right', s1.player.x > x0 + 4, `dx=${(s1.player.x - x0).toFixed(1)}`);
  const y0 = s1.player.y;
  for (let i = 0; i < 12; i++) stepSim(s1, M_JUMP, dt);
  check('JUMP raises the player', s1.player.y < y0 + 40 && s1.player.y < 60, `y=${s1.player.y.toFixed(1)}`);

  // 3. progress event: retrying archives the run as a visible ghost
  const s2 = makeSim(0, LEVELS);
  for (let i = 0; i < 20; i++) stepSim(s2, M_RIGHT, dt);
  check('ghost list empty before any retry', s2.ghosts.length === 0);
  retryRun(s2, false);
  check('retry archives a ghost and respawns the player', s2.ghosts.length === 1 && s2.player.x < 30,
    `ghosts=${s2.ghosts.length} playerX=${s2.player.x.toFixed(1)}`);
  check('ghost cap recycles the oldest', (() => {
    const s = makeSim(0, LEVELS);
    for (let n = 0; n < GHOST_CAP + 3; n++) {
      for (let i = 0; i < 5; i++) stepSim(s, M_RIGHT, dt);
      retryRun(s, false);
    }
    return s.ghosts.length === GHOST_CAP;
  })(), `cap=${GHOST_CAP}`);

  // 4. WIN reachable — replay every level's hand-verified solution
  let solvedCount = 0;
  const unsolved = [];
  for (let i = 0; i < LEVELS.length; i++) {
    const sol = LEVELS[i].solution;
    if (!sol) { unsolved.push(`${i}:no-solution`); continue; }
    const s = replaySolution(i, LEVELS, sol);
    if (s.won) solvedCount++; else unsolved.push(`${i}:${s.dead ? 'died' : 'timeout'}`);
  }
  check('every level has a verified winning multi-run script', solvedCount === LEVELS.length,
    `${solvedCount}/${LEVELS.length}${unsolved.length ? ' · failed: ' + unsolved.join(',') : ''}`);

  // 5. LOSE reachable — a spike directly in the walking path kills on contact
  const spikeFixture = [{
    name: 'fixture', hint: '', par: 1,
    grid: ['######', '#....#', '#S^..#', '######'],
  }];
  const s3 = makeSim(0, spikeFixture);
  for (let i = 0; i < 60 && !s3.dead && !s3.won; i++) stepSim(s3, M_RIGHT, dt);
  check('lose condition reachable (spikes kill)', s3.dead === true, `dead=${s3.dead} won=${s3.won}`);

  // 6. no NaN/Infinity after >=600 varied frames, including repeated retries
  const s4 = makeSim(LEVELS.length - 1, LEVELS);
  let mask = 0;
  for (let i = 0; i < 900; i++) {
    if (i % 11 === 0) mask = [0, M_LEFT, M_RIGHT, M_JUMP, M_LEFT | M_JUMP, M_RIGHT | M_JUMP][Math.floor(i / 11) % 6];
    stepSim(s4, mask, dt);
    if (s4.dead || s4.won) retryRun(s4, s4.dead);
  }
  const fin = allFinite({ player: s4.player, ghosts: s4.ghosts.map((g) => ({ x: g.x, y: g.y, vx: g.vx, vy: g.vy })) });
  check('no NaN/Infinity after 900 simulated frames', fin.ok, fin.bad.slice(0, 3).join(','));

  // 7. nothing throws while stepping every level's spawn once
  let threw = null;
  try {
    for (let i = 0; i < LEVELS.length; i++) {
      const s = makeSim(i, LEVELS);
      for (let f = 0; f < 30; f++) stepSim(s, M_RIGHT, dt);
    }
  } catch (e) { threw = e; }
  check('stepping every level does not throw', !threw, threw ? String(threw) : '');

  // 8. the live game responds to real injected input through the kit
  game.restart();
  game.state.phase = 'play';
  const live0 = game.state.sim.player.x;
  game.input.press('right');
  game.step(30);
  game.input.release('right');
  check('live game responds to kit input', game.state.sim.player.x > live0 + 4,
    `dx=${(game.state.sim.player.x - live0).toFixed(1)}`);
  check('live state stays finite', allFinite({ player: game.state.sim.player }).ok);

  game.restart();
  log(`levels=${LEVELS.length} solved=${solvedCount}`);
});

// expose for the dev console / verification tooling
globalThis.__afterimage = { makeSim, stepSim, retryRun, replaySolution, LEVELS, M_LEFT, M_RIGHT, M_JUMP, GHOST_CAP };

export default game;
