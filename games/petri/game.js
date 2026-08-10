// Petri — cellular-automata territory war.
// You never control units directly: you spend biomass to stamp Conway-style patterns onto a
// shared grid and they live, die and fight along their own rules. Same seed + same stamps
// always produces the same match — the sim below never touches Math.random()/Date.now().

import {
  boot, RNG, Palette, clamp, text, roundRect, allFinite, registerSelftest,
  Type, HUD_H, hudStrip, stat, panel, meter, vignette, titleCard,
  T, mountLangToggle, registerTranslations,
} from '../../shared/kit.js';
import { PATTERNS, patternById, rotatePattern, patternBounds, stampPattern } from './patterns.js';

registerTranslations({
  'PATTERNS': { es: 'PATRONES', fr: 'MOTIFS', ja: 'パターン', ko: '패턴' },
  'TERRITORY': { es: 'TERRITORIO', fr: 'TERRITOIRE', ja: '領地', ko: '영토' },
  'BIOMASS': { es: 'BIOMASA', fr: 'BIOMASSE', ja: 'バイオマス', ko: '바이오매스' },
  'TIME': { es: 'TIEMPO', fr: 'TEMPS', ja: 'タイム', ko: '시간' },
  'LEVEL': { es: 'NIVEL', fr: 'NIVEAU', ja: 'レベル', ko: '레벨' },
  'PETRI': { es: 'PETRI', fr: 'PETRI', ja: 'ペトリ', ko: '페트리' },
  "seed it, don't steer it": {
    es: 'siémbralo, no lo dirijas',
    fr: 'semez-le, ne le pilotez pas',
    ja: '種をまけ、操るな',
    ko: '씨를 뿌려라, 조종하지 마라',
  },
  'You never move a unit. You spend biomass to stamp living patterns onto': {
    es: 'Nunca mueves una unidad. Gastas biomasa para estampar patrones vivos',
    fr: "Vous ne déplacez jamais une unité. Vous dépensez de la biomasse pour",
    ja: 'ユニットを直接動かすことはない。バイオマスを使って生きたパターンを',
    ko: '유닛을 직접 움직이지 않는다. 바이오매스를 소모해 살아있는 패턴을',
  },
  'the dish, and they spread, collide and consume on their own.': {
    es: 'en el plato, y se propagan, chocan y se consumen por sí solos.',
    fr: "tamponner des motifs vivants sur la boîte, qui se propagent, se heurtent et se consument seuls.",
    ja: 'シャーレに刻印する。あとは自ら広がり、衝突し、食い合う。',
    ko: '접시에 새겨 넣는다. 그러면 스스로 퍼지고, 부딪히고, 잡아먹는다.',
  },
  '1-6 pick a pattern  ·  R rotates it  ·  click stamps it': {
    es: '1-6 elige un patrón  ·  R lo rota  ·  clic lo estampa',
    fr: '1-6 choisir un motif  ·  R le fait pivoter  ·  clic pour tamponner',
    ja: '1-6でパターン選択  ·  Rで回転  ·  クリックで刻印',
    ko: '1-6 패턴 선택  ·  R 회전  ·  클릭으로 찍기',
  },
  'PRESS SPACE': { es: 'PULSA ESPACIO', fr: 'APPUYEZ SUR ESPACE', ja: 'スペースキーを押す', ko: '스페이스바를 누르세요' },
  'TERRITORY SECURED': { es: 'TERRITORIO ASEGURADO', fr: 'TERRITOIRE SÉCURISÉ', ja: '領地確保', ko: '영토 확보' },
  'COLONY LOST': { es: 'COLONIA PERDIDA', fr: 'COLONIE PERDUE', ja: 'コロニー壊滅', ko: '군락 붕괴' },
  'PRESS SPACE FOR THE NEXT COLONY': {
    es: 'PULSA ESPACIO PARA LA SIGUIENTE COLONIA',
    fr: 'APPUYEZ SUR ESPACE POUR LA COLONIE SUIVANTE',
    ja: 'スペースキーで次のコロニーへ',
    ko: '스페이스바로 다음 군락으로',
  },
  'PRESS SPACE TO RETRY': { es: 'PULSA ESPACIO PARA REINTENTAR', fr: 'APPUYEZ SUR ESPACE POUR RÉESSAYER', ja: 'スペースキーでリトライ', ko: '스페이스바로 재시도' },
  // pattern palette (patterns.js is out of scope to edit, but its T(p.name, ...) call sites
  // resolve through this registry same as any other)
  'Block': { es: 'Bloque', fr: 'Bloc', ja: 'ブロック', ko: '블록' },
  'Blinker': { es: 'Parpadeador', fr: 'Clignotant', ja: 'ブリンカー', ko: '블링커' },
  'Glider': { es: 'Planeador', fr: 'Planeur', ja: 'グライダー', ko: '글라이더' },
  'LWSS': { es: 'LWSS', fr: 'LWSS', ja: 'LWSS', ko: 'LWSS' },
  'Gun': { es: 'Cañón', fr: 'Canon', ja: 'ガン', ko: '건' },
  'Seed': { es: 'Semilla', fr: 'Graine', ja: 'シード', ko: '씨앗' },
  // original campaign level names (LEVELS indices 0-4); the other 45 are procedurally
  // generated and out of scope
  'Spore': { es: 'Espora', fr: 'Spore', ja: '胞子', ko: '포자' },
  'Colony': { es: 'Colonia', fr: 'Colonie', ja: 'コロニー', ko: '군락' },
  'Bloom': { es: 'Floración', fr: 'Floraison', ja: '開花', ko: '개화' },
  'Swarm': { es: 'Enjambre', fr: 'Essaim', ja: '群れ', ko: '무리' },
  'Hive': { es: 'Colmena', fr: 'Ruche', ja: '巣', ko: '벌집' },
});

// ---------------------------------------------------------------- constants

const GW = 120, GH = 80;
const CA_STEP = 1 / 11;              // CA ticks per second, independent of render
const DOMINANCE_PCT = 0.70;          // territory share needed to win
const DOMINANCE_HOLD = 4;            // seconds it must be sustained
const MIN_LIVE_FOR_EXTINCTION = 40;  // don't call extinction before the match has really begun
const REGEN_BASE = 2.2;              // biomass/sec baseline
const REGEN_PER_CELL = 0.028;        // biomass/sec per live cell you own

// aiSkill scales 0..MAX_AI_SKILL across the 50-level campaign (finer-grained than the old
// 0..4 range so the curve doesn't cliff); pickAiTarget()/aiAct() normalize against this max.
const MAX_AI_SKILL = 8;

// name/nameZh pairs — single evocative words, escalating from a single spore to cosmic-scale
// dominance. Indices 0-4 are the original Spore/Colony/Bloom/Swarm/Hive campaign, unchanged.
const LEVEL_NAMES = [
  ['Spore', '孢子'], ['Colony', '群落'], ['Bloom', '绽放'], ['Swarm', '蜂群'], ['Hive', '蜂巢'],
  ['Culture', '培养'], ['Strain', '菌株'], ['Thicket', '密丛'], ['Cluster', '簇群'], ['Lattice', '晶格'],
  ['Mycelium', '菌丝'], ['Biofilm', '生物膜'], ['Spawn', '孵生'], ['Brood', '孵群'], ['Tide', '潮涌'],
  ['Surge', '涌动'], ['Cascade', '瀑流'], ['Legion', '军团'], ['Phalanx', '方阵'], ['Vanguard', '前锋'],
  ['Bastion', '堡垒'], ['Citadel', '要塞'], ['Dominion', '领域'], ['Empire', '帝国'], ['Overgrowth', '蔓生'],
  ['Contagion', '蔓延'], ['Plague', '瘟疫'], ['Blight', '枯萎'], ['Malignancy', '恶性'], ['Metastasis', '转移'],
  ['Cataclysm', '剧变'], ['Maelstrom', '漩涡'], ['Vortex', '涡流'], ['Tempest', '风暴'], ['Wildfire', '野火'],
  ['Inferno', '烈焰'], ['Eruption', '爆发'], ['Fracture', '断裂'], ['Rupture', '破裂'], ['Collapse', '崩塌'],
  ['Singularity', '奇点'], ['Ascendant', '升腾'], ['Leviathan', '利维坦'], ['Behemoth', '巨兽'], ['Colossus', '巨像'],
  ['Juggernaut', '主宰'], ['Apex', '顶点'], ['Zenith', '巅峰'], ['Omega', '欧米伽'], ['Genesis', '创世'],
];

/** Pattern roster available to the AI at a given level index (0-based, 0..49). Grows from a
 * bare glider/block opener to the full arsenal, with higher-value patterns duplicated into
 * the pool at high levels so the AI's weighted random pick favors them more often. */
function aiPatternsForLevel(i) {
  if (i < 5) return ['glider', 'block'];
  if (i < 10) return ['glider', 'blinker', 'seed'];
  if (i < 18) return ['glider', 'lwss', 'seed'];
  if (i < 26) return ['glider', 'lwss', 'gun', 'seed'];
  if (i < 34) return ['glider', 'lwss', 'gun', 'seed', 'blinker'];
  if (i < 42) return ['glider', 'lwss', 'lwss', 'gun', 'seed', 'blinker'];
  return ['glider', 'lwss', 'lwss', 'gun', 'gun', 'seed', 'blinker'];
}

const LEVELS = LEVEL_NAMES.map(([name, nameZh], i) => {
  const n = LEVEL_NAMES.length - 1; // 49
  const t = i / n;                  // 0..1
  // Exponential decay from 3.6s down to 0.5s — matches the original 5-level pacing at the
  // start (3.6 -> 1.2 over the first 4 steps) and keeps easing smoothly beyond it.
  const aiInterval = i < 5
    ? [3.6, 2.8, 2.2, 1.7, 1.2][i]
    : Math.max(0.5, 3.6 * Math.pow(0.5 / 3.6, t));
  const aiSkill = i < 5 ? i : Math.min(MAX_AI_SKILL, t * MAX_AI_SKILL);
  return { name, nameZh, aiInterval, aiPatterns: aiPatternsForLevel(i), aiSkill };
});

// ---------------------------------------------------------------- pure CA step

/** One Conway-ish generation. Majority-of-neighbors decides color; ties on birth cancel to empty. */
function stepCA(grid, next, gw, gh) {
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let n1 = 0, n2 = 0;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < gh - 1 ? y + 1 : gh - 1;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < gw - 1 ? x + 1 : gw - 1;
      for (let ny = y0; ny <= y1; ny++) {
        const row = ny * gw;
        for (let nx = x0; nx <= x1; nx++) {
          if (nx === x && ny === y) continue;
          const v = grid[row + nx];
          if (v === 1) n1++; else if (v === 2) n2++;
        }
      }
      const total = n1 + n2;
      const idx = y * gw + x;
      const c = grid[idx];
      if (c === 0) {
        next[idx] = total === 3 ? (n1 > n2 ? 1 : n2 > n1 ? 2 : 0) : 0;
      } else if (total === 2 || total === 3) {
        next[idx] = n1 === n2 ? c : (n1 > n2 ? 1 : 2);
      } else {
        next[idx] = 0;
      }
    }
  }
}

function countColors(grid) {
  let n1 = 0, n2 = 0;
  for (let i = 0; i < grid.length; i++) { if (grid[i] === 1) n1++; else if (grid[i] === 2) n2++; }
  return { n1, n2 };
}

// ---------------------------------------------------------------- sim (pure state, deterministic)

export function makeSim(seed, levelIndex = 0) {
  const level = LEVELS[clamp(levelIndex, 0, LEVELS.length - 1)];
  const sim = {
    seed, levelIndex, level: level.name,
    rng: new RNG(RNG.hash(String(seed)) ^ (levelIndex * 7919 + 1)),
    gw: GW, gh: GH,
    grid: new Uint8Array(GW * GH),
    next: new Uint8Array(GW * GH),
    caAccum: 0,
    tickCount: 0,
    matchTime: 0,
    biomassP: 40,
    biomassAI: 40,
    n1: 0, n2: 0, total: 0,
    pctP: 0, pctAI: 0,
    domTimerP: 0, domTimerAI: 0,
    aiTimer: level.aiInterval * 0.5,
    aiInterval: level.aiInterval,
    aiPatterns: level.aiPatterns,
    aiSkill: level.aiSkill,
    phase: 'playing', // 'playing' | 'won' | 'lost'
    lastStamp: null,
    lastAiStamp: null,
    shakeEvent: 0, // set >0 for one tick when a big colony dies, visual layer consumes it
  };
  seedColonies(sim);
  const c = countColors(sim.grid);
  sim.n1 = c.n1; sim.n2 = c.n2; sim.total = c.n1 + c.n2;
  updateTerritory(sim);
  return sim;
}

function seedColonies(sim) {
  // Player bottom-left, AI top-right — small starter colonies, mirrored for fairness.
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('glider'), 14, sim.gh - 14, 0, 1);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('block'), 8, sim.gh - 8, 0, 1);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('blinker'), 20, sim.gh - 20, 0, 1);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('glider'), sim.gw - 14, 14, 2, 2);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('block'), sim.gw - 8, 8, 0, 2);
  stampPattern(sim.grid, sim.gw, sim.gh, patternById('blinker'), sim.gw - 20, 20, 0, 2);
}

function updateTerritory(sim) {
  const c = countColors(sim.grid);
  sim.n1 = c.n1; sim.n2 = c.n2; sim.total = c.n1 + c.n2;
  sim.pctP = sim.total > 0 ? sim.n1 / sim.total : 0;
  sim.pctAI = sim.total > 0 ? sim.n2 / sim.total : 0;
}

function tryStamp(sim, patternId, x, y, rot, color) {
  const pattern = patternById(patternId);
  const budget = color === 1 ? sim.biomassP : sim.biomassAI;
  if (budget < pattern.cost) return false;
  stampPattern(sim.grid, sim.gw, sim.gh, pattern, x, y, rot, color);
  if (color === 1) { sim.biomassP -= pattern.cost; sim.lastStamp = { patternId, x, y, rot }; }
  else { sim.biomassAI -= pattern.cost; sim.lastAiStamp = { patternId, x, y, rot }; }
  return true;
}

/** Pick an AI stamp target: a contested cell along the front, or fall back to own territory edge. */
function pickAiTarget(sim) {
  const gw = sim.gw, gh = sim.gh, grid = sim.grid;
  const candidates = [];
  // Sample on a coarse stride for speed; look for empty/player cells adjacent to AI cells (the front).
  const stride = sim.aiSkill >= MAX_AI_SKILL * 0.75 ? 2 : 4;
  for (let y = 1; y < gh - 1; y += stride) {
    for (let x = 1; x < gw - 1; x += stride) {
      const v = grid[y * gw + x];
      if (v === 1) {
        // contested if an AI cell is nearby within radius 6
        candidates.push({ x, y, w: 2 });
      } else if (v === 0) {
        let nearAI = false, nearP = false;
        for (let dy = -2; dy <= 2 && !(nearAI && nearP); dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const nv = grid[ny * gw + nx];
            if (nv === 2) nearAI = true; else if (nv === 1) nearP = true;
          }
        }
        if (nearAI && nearP) candidates.push({ x, y, w: 3 });
      }
    }
  }
  if (candidates.length === 0) {
    // No visible front yet — aim near the player's known cluster (mirrored spawn corner).
    return { x: sim.gw - 1 - sim.rng.intRange(6, 24), y: sim.rng.intRange(6, 24) };
  }
  // Weighted pick biased toward higher-weight (more contested) candidates; higher skill = less random.
  const skillFocus = sim.aiSkill / MAX_AI_SKILL; // 0..1
  if (sim.rng.bool(0.3 + skillFocus * 0.5)) {
    candidates.sort((a, b) => b.w - a.w);
    return candidates[0];
  }
  return sim.rng.pick(candidates);
}

function aiAct(sim, dt) {
  sim.aiTimer -= dt;
  if (sim.aiTimer > 0) return;
  sim.aiTimer = sim.aiInterval * (0.8 + sim.rng.next() * 0.4);
  const t = pickAiTarget(sim);
  const patId = sim.rng.pick(sim.aiPatterns);
  const rot = sim.aiSkill >= MAX_AI_SKILL * 0.5 ? sim.rng.intRange(0, 3) : 0;
  tryStamp(sim, patId, t.x, t.y, rot, 2);
}

/**
 * Advance the sim by one fixed frame (dt seconds). intent (optional) = {stamp:{patternId,x,y,rot}}
 * stamped for the player. Deterministic: only uses sim.rng and dt, never wall clock.
 */
export function stepSim(sim, intent, dt) {
  if (sim.phase !== 'playing') return sim;
  sim.matchTime += dt;

  if (intent && intent.stamp) {
    const { patternId, x, y, rot } = intent.stamp;
    tryStamp(sim, patternId, x, y, rot || 0, 1);
  }

  aiAct(sim, dt);

  sim.biomassP = Math.min(999, sim.biomassP + (REGEN_BASE + sim.n1 * REGEN_PER_CELL) * dt);
  sim.biomassAI = Math.min(999, sim.biomassAI + (REGEN_BASE + sim.n2 * REGEN_PER_CELL) * dt);

  sim.caAccum += dt;
  let stepped = false;
  while (sim.caAccum >= CA_STEP) {
    const prevN1 = sim.n1, prevN2 = sim.n2;
    stepCA(sim.grid, sim.next, sim.gw, sim.gh);
    const tmp = sim.grid; sim.grid = sim.next; sim.next = tmp;
    sim.tickCount++;
    sim.caAccum -= CA_STEP;
    stepped = true;
    updateTerritory(sim);
    // A colony "dying big" — used by the render layer to trigger screenshake.
    if (prevN1 - sim.n1 > 25 || prevN2 - sim.n2 > 25) sim.shakeEvent = Math.max(sim.shakeEvent, 1);
  }

  if (stepped) {
    const enoughLife = sim.total >= MIN_LIVE_FOR_EXTINCTION;
    if (sim.pctP >= DOMINANCE_PCT && sim.total > 0) sim.domTimerP += CA_STEP; else sim.domTimerP = 0;
    if (sim.pctAI >= DOMINANCE_PCT && sim.total > 0) sim.domTimerAI += CA_STEP; else sim.domTimerAI = 0;

    if (enoughLife && sim.n2 === 0 && sim.n1 > 0) sim.phase = 'won';
    else if (enoughLife && sim.n1 === 0 && sim.n2 > 0) sim.phase = 'lost';
    else if (sim.domTimerP >= DOMINANCE_HOLD) sim.phase = 'won';
    else if (sim.domTimerAI >= DOMINANCE_HOLD) sim.phase = 'lost';
  }

  return sim;
}

// ---------------------------------------------------------------- kit-facing game wrapper

const MAX_COST = PATTERNS.reduce((m, p) => (p.cost > m ? p.cost : m), 0);

/**
 * Single source of truth for the screen. The top chrome (stats + territory bar) and the
 * pattern palette are reserved first; whatever is left is the dish. pointerToGrid() reads
 * the SAME rect the board is drawn into, so a click always lands on the cell under the
 * cursor at any canvas size. Under ~560px tall (or ~620px wide) everything drops to a
 * compact scale rather than overlapping.
 */
function layout(game) {
  const compact = game.h < 560 || game.w < 620;
  const hudH = compact ? 46 : HUD_H;
  const terrH = compact ? 24 : 30;
  const palH = compact ? 74 : 92;
  const boardTop = hudH + terrH;
  const boardH = Math.max(24, game.h - boardTop - palH);
  return { compact, hudH, terrH, palH, boardTop, boardH, pad: compact ? 12 : 16 };
}

function pointerToGrid(game) {
  const L = layout(game);
  const gx = clamp(Math.floor((game.input.pointer.x / game.w) * GW), 0, GW - 1);
  const gy = clamp(Math.floor(((game.input.pointer.y - L.boardTop) / L.boardH) * GH), 0, GH - 1);
  return { gx, gy };
}

/** rotatePattern allocates; the render layer asks for the same 24 combinations forever. */
const rotCache = new Map();
function rotatedCells(pattern, rot) {
  const key = pattern.id + '|' + (((rot % 4) + 4) % 4);
  let cells = rotCache.get(key);
  if (!cells) { cells = rotatePattern(pattern.cells, rot); rotCache.set(key, cells); }
  return cells;
}

function init(game) {
  const level = Number(game.store.get('level', 0)) || 0;
  return {
    sim: makeSim(game.seed, level),
    levelIndex: level,
    selected: 'glider',
    rot: 0,
    introDone: false,
    fade: new Float32Array(GW * GH),
    // last colour each cell belonged to, so a dying colony fades out in its own colour
    // instead of blinking straight to background. Render-layer only; never read by the sim.
    owner: new Uint8Array(GW * GH),
    imgData: null,
    offCanvas: null,
    offCtx: null,
    glowCanvas: null,
    glowCtx: null,
    glowData: null,
    blurCanvas: null,
    blurCtx: null,
    flashT: 0,
    territoryTone: 0,
    endTimer: 0,
    bestLevel: Number(game.store.get('bestLevel', 0)) || 0,
    fastestWin: game.store.get('fastestWin', null),
  };
}

function selectPatternFromInput(state, game) {
  for (const p of PATTERNS) {
    if (game.input.justPressed(p.key)) { state.selected = p.id; game.sound.blip(500); }
  }
  if (game.input.justPressed('r') || game.input.justPressed('KeyR')) {
    state.rot = (state.rot + 1) % 4;
    game.sound.blip(700);
  }
}

function update(state, dt, game) {
  if (!state.introDone) {
    if (game.input.justPressed('space') || game.input.pointerPressed) state.introDone = true;
    return;
  }

  if (state.sim.phase !== 'playing') {
    state.endTimer += dt;
    if (game.input.justPressed('space') || game.input.justPressed('enter')) {
      const won = state.sim.phase === 'won';
      const nextLevel = won ? Math.min(LEVELS.length - 1, state.levelIndex + 1) : state.levelIndex;
      state.levelIndex = nextLevel;
      if (won) game.store.set('level', nextLevel);
      state.sim = makeSim(game.seed + '#' + game.frame, nextLevel);
      state.endTimer = 0;
      state.fade.fill(0);
      state.owner.fill(0);
    }
    return;
  }

  selectPatternFromInput(state, game);

  let intent = null;
  if (game.input.pointerPressed) {
    const { gx, gy } = pointerToGrid(game);
    const pattern = patternById(state.selected);
    if (state.sim.biomassP >= pattern.cost) {
      intent = { stamp: { patternId: state.selected, x: gx, y: gy, rot: state.rot } };
      game.sound.tone({ freq: 220, dur: 0.05, type: 'square', gain: 0.1 });
      game.fx.burst(game.input.pointer.x, game.input.pointer.y, {
        count: 10, color: Palette.accent, speed: 90, life: 0.35, size: 2, drag: 0.86,
      });
    } else {
      game.sound.bad();
    }
  }

  const prevPhase = state.sim.phase;
  const prevPct = state.sim.pctP;
  stepSim(state.sim, intent, dt);

  if (state.sim.shakeEvent) { game.fx.shake(10); state.sim.shakeEvent = 0; }

  // rising tone as territory grows
  if (state.sim.pctP > prevPct + 0.002) {
    state.territoryTone += dt;
    if (state.territoryTone > 0.4) { game.sound.tone({ freq: 300 + state.sim.pctP * 500, dur: 0.08, type: 'sine', gain: 0.05 }); state.territoryTone = 0; }
  }

  if (prevPhase === 'playing' && state.sim.phase !== 'playing') {
    game.fx.shake(16);
    if (state.sim.phase === 'won') {
      game.sound.ok();
      game.store.best('bestLevel', state.levelIndex + 1, true);
      state.bestLevel = Math.max(state.bestLevel, state.levelIndex + 1);
      const isNewBest = game.store.best('fastestWin', Math.round(state.sim.matchTime), false);
      if (isNewBest) state.fastestWin = Math.round(state.sim.matchTime);
    } else {
      game.sound.bad();
    }
  }

  // cell fade toward alive/dead for smooth render
  const grid = state.sim.grid, fade = state.fade, owner = state.owner;
  const k = Math.min(1, dt * 9);
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v !== 0) owner[i] = v;
    fade[i] += ((v === 0 ? 0 : 1) - fade[i]) * k;
  }
}

// ---------------------------------------------------------------- render

function ensureOffscreen(state) {
  if (state.offCanvas) return;
  // The dish itself: one 120x80 ImageData blitted with smoothing off. This is the fast
  // path — 9600 cells as per-cell fillRect() calls would cost an order of magnitude more.
  state.offCanvas = document.createElement('canvas');
  state.offCanvas.width = GW; state.offCanvas.height = GH;
  state.offCtx = state.offCanvas.getContext('2d');
  state.imgData = state.offCtx.createImageData(GW, GH);
  // Bloom source: the same cells with a transparent background, so compositing it back
  // with 'lighter' adds light only where something is alive.
  state.glowCanvas = document.createElement('canvas');
  state.glowCanvas.width = GW; state.glowCanvas.height = GH;
  state.glowCtx = state.glowCanvas.getContext('2d');
  state.glowData = state.glowCtx.createImageData(GW, GH);
  // ...and the blur runs at 2x grid resolution (240x160), not at screen resolution. The
  // upscale to the board does the rest of the softening for free, which keeps the whole
  // bloom pass at a few tens of thousands of pixels per frame instead of a million.
  state.blurCanvas = document.createElement('canvas');
  state.blurCanvas.width = GW * 2; state.blurCanvas.height = GH * 2;
  state.blurCtx = state.blurCanvas.getContext('2d');
}

const COL_P = [94, 242, 192];   // accent (mint) — player
const COL_AI = [255, 77, 109];  // hot (red) — rival

function renderBoard(state, ctx, game, L) {
  ensureOffscreen(state);
  const grid = state.sim.grid;
  const fade = state.fade, owner = state.owner;
  const data = state.imgData.data, glow = state.glowData.data;
  for (let i = 0, o = 0; i < grid.length; i++, o += 4) {
    const v = grid[i];
    const a = fade[i];
    const c = owner[i] === 2 ? COL_AI : COL_P;
    const mix = v === 0 ? a * 0.55 : 0.45 + a * 0.55;
    data[o] = 13 + (c[0] - 13) * mix;
    data[o + 1] = 16 + (c[1] - 16) * mix;
    data[o + 2] = 24 + (c[2] - 24) * mix;
    data[o + 3] = 255;
    glow[o] = c[0]; glow[o + 1] = c[1]; glow[o + 2] = c[2];
    glow[o + 3] = v === 0 ? a * a * 130 : 90 + a * 130;
  }
  state.offCtx.putImageData(state.imgData, 0, 0);
  state.glowCtx.putImageData(state.glowData, 0, 0);

  const bw = game.w, by = L.boardTop, bh = L.boardH;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.offCanvas, 0, 0, GW, GH, 0, by, bw, bh);
  ctx.restore();

  // Blur pass. ctx.filter silently does nothing where it is unsupported; the bilinear
  // upscale below still softens the copy, so the bloom degrades rather than disappears.
  const bc = state.blurCanvas, bctx = state.blurCtx;
  bctx.save();
  bctx.filter = 'none';
  bctx.clearRect(0, 0, bc.width, bc.height);
  bctx.filter = 'blur(2.5px)';
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(state.glowCanvas, 0, 0, GW, GH, 0, 0, bc.width, bc.height);
  bctx.filter = 'none';
  bctx.restore();

  const spread = Math.max(3, (bw / GW) * 1.5);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, by, bw, bh);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 0.45;
  ctx.drawImage(bc, 0, 0, bc.width, bc.height, 0, by, bw, bh);
  ctx.globalAlpha = 0.18;
  ctx.drawImage(bc, 0, 0, bc.width, bc.height, -spread, by - spread, bw + spread * 2, bh + spread * 2);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, by + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));
  ctx.restore();
}

function renderGhost(state, ctx, game, L) {
  const p = game.input.pointer;
  if (p.x === 0 && p.y === 0) return;      // pointer never moved — don't park a ghost in the corner
  const { gx, gy } = pointerToGrid(game);
  const pattern = patternById(state.selected);
  const cells = rotatedCells(pattern, state.rot);
  const { w, h } = patternBounds(cells);
  const ox = gx - ((w / 2) | 0), oy = gy - ((h / 2) | 0);
  const sx = game.w / GW, sy = L.boardH / GH;
  const affordable = state.sim.biomassP >= pattern.cost;
  const glowColor = affordable ? Palette.accent : Palette.hot;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, L.boardTop, game.w, L.boardH);
  ctx.clip();
  ctx.strokeStyle = affordable ? 'rgba(94,242,192,0.30)' : 'rgba(255,77,109,0.30)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(ox * sx) + 0.5, Math.round(L.boardTop + oy * sy) + 0.5,
    Math.max(1, w * sx - 1), Math.max(1, h * sy - 1),
  );
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 8;
  ctx.globalAlpha = 0.68 + 0.22 * Math.sin(game.t * 6);
  ctx.fillStyle = affordable ? 'rgba(94,242,192,0.75)' : 'rgba(255,77,109,0.65)';
  for (let i = 0; i < cells.length; i++) {
    const x = ox + cells[i][0], y = oy + cells[i][1];
    if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
    ctx.fillRect(x * sx, L.boardTop + y * sy, Math.max(1, sx), Math.max(1, sy));
  }
  ctx.restore();
}

// ---------------------------------------------------------------- top chrome

function renderTop(state, ctx, game, L) {
  const s = state.sim;
  const pad = L.pad;
  // One strip covers the stats AND the territory bar, so the board gets a single horizon.
  hudStrip(ctx, game, { h: L.boardTop, fill: 'rgba(13,16,24,0.95)', border: Palette.grid });

  const vs = L.compact ? 18 : Type.value;
  const ls = L.compact ? 10 : Type.label;
  const labelY = L.compact ? 16 : 21;
  const gap = L.compact ? 16 : 26;
  const mw = (chars) => chars * vs * 0.6;    // monospace advance
  const lw = (chars) => chars * ls * 0.74;   // ...plus stat()'s 0.14em label tracking

  const sel = patternById(state.selected);
  const afford = s.biomassP >= sel.cost;
  const levelDef = LEVELS[clamp(state.levelIndex, 0, LEVELS.length - 1)];
  const levelName = T(s.level, levelDef.nameZh || s.level);
  const lvlLabel = T(`LEVEL ${state.levelIndex + 1}/${LEVELS.length}`, `关卡 ${state.levelIndex + 1}/${LEVELS.length}`);
  const bioStr = String(Math.floor(s.biomassP));
  const timeStr = `${s.matchTime.toFixed(1)}s`;
  const timeW = Math.max(mw(timeStr.length), lw(4));

  // Fit the columns to the width rather than letting them collide: shrink the biomass
  // meter first, then drop territory (the bar below already says it), then the strain name.
  let showName = true, showTerr = true;
  let meterW = L.compact ? 70 : 104;
  const avail = game.w - pad * 2 - timeW - gap;
  const measure = () => {
    const a = showName ? Math.max(mw(levelName.length), lw(lvlLabel.length)) : Math.max(mw(3), lw(5));
    const b = showTerr ? Math.max(mw(4), lw(9)) : 0;
    const c = Math.max(mw(bioStr.length) + 10 + meterW, lw(7));
    return { a, b, c, total: a + b + c + gap * (showTerr ? 2 : 1) };
  };
  let col = measure();
  if (col.total > avail) { meterW = Math.max(0, meterW - (col.total - avail)); col = measure(); }
  if (col.total > avail) { showTerr = false; col = measure(); }
  if (col.total > avail) { showName = false; col = measure(); }

  let x = pad;
  stat(ctx, x, labelY,
    showName ? lvlLabel : T('LEVEL', '关卡'),
    showName ? levelName.toUpperCase() : `${state.levelIndex + 1}/${LEVELS.length}`,
    { valueSize: vs, labelSize: ls, color: Palette.ink });
  x += col.a + gap;

  if (showTerr) {
    stat(ctx, x, labelY, T('TERRITORY', '领地'), `${Math.round(s.pctP * 100)}%`,
      { valueSize: vs, labelSize: ls, color: Palette.accent });
    x += col.b + gap;
  }

  stat(ctx, x, labelY, T('BIOMASS', '生物质'), bioStr,
    { valueSize: vs, labelSize: ls, color: afford ? Palette.ink : Palette.warm });
  const mx = x + mw(bioStr.length) + 10;
  const mh = L.compact ? 7 : 8;
  const my = labelY + 2 + vs * 0.5 - mh / 2;
  if (meterW >= 24 && mx + meterW <= game.w - pad - timeW - 8) {
    // Full meter = you can afford anything in the palette; the tick is the selected
    // pattern's price, so the bar reads as "how close am I to the thing I want".
    meter(ctx, mx, my, meterW, mh, clamp(s.biomassP / MAX_COST, 0, 1),
      { color: afford ? Palette.accent : Palette.warm, track: 'rgba(255,255,255,0.07)' });
    ctx.save();
    ctx.fillStyle = afford ? 'rgba(233,237,247,0.45)' : Palette.warm;
    ctx.fillRect(mx + meterW * clamp(sel.cost / MAX_COST, 0, 1) - 0.5, my - 3, 1, mh + 6);
    ctx.restore();
  }

  stat(ctx, game.w - pad, labelY, T('TIME', '时间'), timeStr,
    { align: 'right', valueSize: vs, labelSize: ls, color: Palette.dim });

  renderTerritoryBar(state, ctx, game, L, ls);
}

/** Two-sided share bar: both colonies push in from their own edge and meet at the front. */
function renderTerritoryBar(state, ctx, game, L, ls) {
  const s = state.sim;
  const x = L.pad;
  const w = Math.max(8, game.w - L.pad * 2);
  const top = L.hudH;
  const labelY = top + (L.compact ? 10 : 12);
  const barY = top + (L.compact ? 13 : 16);
  const barH = L.compact ? 7 : 9;
  const r = barH / 2;
  const pw = w * clamp(s.pctP, 0, 1);
  const aw = w * clamp(s.pctAI, 0, 1);

  text(ctx, T(`YOU ${Math.round(s.pctP * 100)}%`, `你方 ${Math.round(s.pctP * 100)}%`), x, labelY,
    { size: ls, color: Palette.accent, weight: 700, baseline: 'alphabetic' });
  text(ctx, T(`${Math.round(s.pctAI * 100)}% RIVAL`, `对手 ${Math.round(s.pctAI * 100)}%`), x + w, labelY,
    { size: ls, color: Palette.hot, weight: 700, align: 'right', baseline: 'alphabetic' });

  if (s.domTimerP > 0 || s.domTimerAI > 0) {
    const mine = s.domTimerP > 0;
    const left = Math.max(0, DOMINANCE_HOLD - (mine ? s.domTimerP : s.domTimerAI));
    text(ctx, mine ? T(`HOLD ${left.toFixed(1)}s`, `坚守 ${left.toFixed(1)}秒`) : T(`LOSING ${left.toFixed(1)}s`, `失守 ${left.toFixed(1)}秒`), x + w / 2, labelY,
      { size: ls, color: Palette.warm, weight: 700, align: 'center', baseline: 'alphabetic' });
  }

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  roundRect(ctx, x, barY, w, barH, r);
  ctx.fill();

  if (pw > 0.5) {
    ctx.shadowColor = Palette.accent; ctx.shadowBlur = 9;
    ctx.fillStyle = Palette.accent;
    roundRect(ctx, x, barY, Math.max(barH, pw), barH, r);
    ctx.fill();
  }
  if (aw > 0.5) {
    ctx.shadowColor = Palette.hot; ctx.shadowBlur = 9;
    ctx.fillStyle = Palette.hot;
    const rw = Math.max(barH, aw);
    roundRect(ctx, x + w - rw, barY, rw, barH, r);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // the two win lines — reach your own and hold it
  ctx.fillStyle = 'rgba(255,200,87,0.5)';
  ctx.fillRect(x + w * DOMINANCE_PCT - 0.5, barY - 3, 1, barH + 6);
  ctx.fillRect(x + w * (1 - DOMINANCE_PCT) - 0.5, barY - 3, 1, barH + 6);
  ctx.fillStyle = 'rgba(233,237,247,0.18)';
  ctx.fillRect(x + w / 2 - 0.5, barY - 2, 1, barH + 4);
  ctx.restore();
}

// ---------------------------------------------------------------- pattern palette

function drawPatternPreview(ctx, pattern, rot, bx, by, bw, bh, color) {
  if (bw < 5 || bh < 5) return;
  const cells = rotatedCells(pattern, rot);
  const b = patternBounds(cells);
  const cs = Math.min(bw / b.w, bh / b.h);
  const ox = bx + (bw - b.w * cs) / 2;
  const oy = by + (bh - b.h * cs) / 2;
  const dot = Math.max(1, cs - (cs > 3 ? 1 : 0.25));
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < cells.length; i++) {
    ctx.fillRect(ox + cells[i][0] * cs, oy + cells[i][1] * cs, dot, dot);
  }
  ctx.restore();
}

function renderPalette(state, ctx, game, L) {
  const s = state.sim;
  const pad = L.pad;
  const y0 = game.h - L.palH;

  ctx.save();
  ctx.fillStyle = 'rgba(13,16,24,0.95)';
  ctx.fillRect(0, y0, game.w, L.palH);
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y0 + 0.5);
  ctx.lineTo(game.w, y0 + 0.5);
  ctx.stroke();
  ctx.restore();

  const ls = L.compact ? 10 : Type.label;
  const headY = y0 + (L.compact ? 13 : 16);
  text(ctx, T('PATTERNS', '图案'), pad, headY, { size: ls, color: Palette.dim, weight: 700, baseline: 'alphabetic' });
  const hint = game.w < 620
    ? T(`ROT ${state.rot * 90}`, `旋转 ${state.rot * 90}`)
    : T(`ROT ${state.rot * 90}  ·  R ROTATE  ·  CLICK TO STAMP`, `旋转 ${state.rot * 90}  ·  R 键旋转  ·  点击放置`);
  text(ctx, hint, game.w - pad, headY,
    { size: ls, color: Palette.dim, weight: 600, align: 'right', baseline: 'alphabetic' });

  const n = PATTERNS.length;
  const gap = L.compact ? 6 : 8;
  const chipW = Math.max(20, (game.w - pad * 2 - gap * (n - 1)) / n);
  const chipH = L.compact ? 46 : 58;
  const chipY = y0 + (L.compact ? 19 : 25);
  const badgeW = L.compact ? 15 : 18, badgeH = L.compact ? 13 : 15;

  for (let i = 0; i < n; i++) {
    const p = PATTERNS[i];
    const x = pad + i * (chipW + gap);
    const selected = state.selected === p.id;
    const afford = s.biomassP >= p.cost;

    panel(ctx, x, chipY, chipW, chipH, {
      radius: 5,
      fill: selected ? 'rgba(94,242,192,0.10)' : afford ? 'rgba(17,22,36,0.92)' : 'rgba(10,12,18,0.85)',
      border: selected ? Palette.accent : afford ? Palette.grid : 'rgba(120,132,156,0.22)',
      glowColor: selected ? Palette.accent : null,
      glowBlur: 16,
    });

    const ink = selected ? Palette.accent : afford ? Palette.ink : 'rgba(120,132,156,0.72)';
    const bx = x + (L.compact ? 6 : 9);
    const by = chipY + (L.compact ? 6 : 8);

    ctx.save();
    roundRect(ctx, bx, by, badgeW, badgeH, 3);
    ctx.fillStyle = selected ? 'rgba(94,242,192,0.22)' : 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.restore();
    text(ctx, p.key, bx + badgeW / 2, by + badgeH - (L.compact ? 3 : 4), {
      size: Type.label, color: selected ? Palette.accent : afford ? Palette.dim : 'rgba(120,132,156,0.7)',
      align: 'center', baseline: 'alphabetic', weight: 700,
    });
    text(ctx, T(p.name, p.nameZh || p.name), bx + badgeW + 6, by + badgeH - (L.compact ? 2 : 3),
      { size: Type.small, color: ink, weight: 700, baseline: 'alphabetic' });
    text(ctx, T(`${p.cost} BM`, `${p.cost} 生物质`), bx, chipY + chipH - (L.compact ? 8 : 11), {
      size: L.compact ? Type.label : Type.small,
      color: afford ? Palette.accent2 : Palette.hot, weight: 700, baseline: 'alphabetic',
    });

    const pvW = Math.min(L.compact ? 24 : 32, chipW * 0.3);
    const pvH = L.compact ? 14 : 20;
    drawPatternPreview(
      ctx, p, state.rot,
      x + chipW - (L.compact ? 6 : 9) - pvW,
      chipY + chipH - (L.compact ? 5 : 8) - pvH,
      pvW, pvH,
      selected ? Palette.accent : afford ? 'rgba(233,237,247,0.6)' : 'rgba(120,132,156,0.35)',
    );
  }
}

// ---------------------------------------------------------------- overlays

function renderIntro(state, ctx, game) {
  titleCard(ctx, game, {
    title: T('PETRI', '培养皿'),
    tagline: T("seed it, don't steer it", '播下种子,而非操控它'),
    lines: [
      T('You never move a unit. You spend biomass to stamp living patterns onto',
        '你不能直接操控单元。你花费生物质,把有生命的图案印在'),
      T('the dish, and they spread, collide and consume on their own.',
        '培养皿上,任由它们自行扩散、碰撞、吞噬。'),
      '',
      T('1-6 pick a pattern  ·  R rotates it  ·  click stamps it',
        '1-6 选择图案  ·  R 键旋转  ·  点击放置'),
      T(`Hold ${Math.round(DOMINANCE_PCT * 100)}% of the living cells for ${DOMINANCE_HOLD}s to take the dish.`,
        `占据 ${Math.round(DOMINANCE_PCT * 100)}% 的存活细胞并坚持 ${DOMINANCE_HOLD} 秒即可占领培养皿。`),
    ],
    prompt: T('PRESS SPACE', '按空格键开始'),
    t: game.t,
    accent: Palette.accent,
  });
}

function renderEnd(state, ctx, game) {
  const s = state.sim;
  const won = s.phase === 'won';
  const levelDef = LEVELS[clamp(state.levelIndex, 0, LEVELS.length - 1)];
  const levelName = T(s.level, levelDef.nameZh || s.level);
  titleCard(ctx, game, {
    title: won ? T('TERRITORY SECURED', '领地已占领') : T('COLONY LOST', '菌落覆灭'),
    tagline: T(`${s.level}  ·  level ${state.levelIndex + 1} of ${LEVELS.length}`,
      `${levelName}  ·  第 ${state.levelIndex + 1}/${LEVELS.length} 关`),
    lines: [
      won
        ? T(`cleared in ${s.matchTime.toFixed(1)}s`, `用时 ${s.matchTime.toFixed(1)} 秒通关`)
        : T(`the rival colony took the dish in ${s.matchTime.toFixed(1)}s`,
          `对手菌落用了 ${s.matchTime.toFixed(1)} 秒占领了培养皿`),
      T(`final share  ·  you ${Math.round(s.pctP * 100)}%  ·  rival ${Math.round(s.pctAI * 100)}%`,
        `最终占比  ·  你方 ${Math.round(s.pctP * 100)}%  ·  对手 ${Math.round(s.pctAI * 100)}%`),
      T(`best level ${state.bestLevel}/${LEVELS.length}` + (state.fastestWin ? `  ·  fastest win ${state.fastestWin}s` : ''),
        `最佳关卡 ${state.bestLevel}/${LEVELS.length}` + (state.fastestWin ? `  ·  最快通关 ${state.fastestWin} 秒` : '')),
    ],
    prompt: won && state.levelIndex < LEVELS.length - 1
      ? T('PRESS SPACE FOR THE NEXT COLONY', '按空格键进入下一菌落')
      : T('PRESS SPACE TO RETRY', '按空格键重试'),
    t: game.t,
    accent: won ? Palette.accent : Palette.hot,
  });
}

function render(state, ctx, game) {
  const L = layout(game);
  renderBoard(state, ctx, game, L);
  if (state.introDone && state.sim.phase === 'playing') renderGhost(state, ctx, game, L);
  ctx.save();
  game.fx.draw(ctx);
  ctx.restore();
  // Vignette lands on the dish while the chrome, drawn on top of it, stays crisp.
  vignette(ctx, game, 0.45);
  renderTop(state, ctx, game, L);
  renderPalette(state, ctx, game, L);
  if (!state.introDone) renderIntro(state, ctx, game);
  else if (state.sim.phase !== 'playing') renderEnd(state, ctx, game);
}

// ---------------------------------------------------------------- boot

const game = boot({
  id: 'petri',
  title: 'Petri',
  seed: 'petri-' + Math.floor(Math.random() * 1e9),
  init, update, render,
});
mountLangToggle();

globalThis.__petri = { makeSim, stepSim, stepCA, countColors, PATTERNS, patternById, rotatePattern, stampPattern, LEVELS };

// ---------------------------------------------------------------- self-test

registerSelftest('petri', (check, log) => {
  // 8. CA correctness on a clean single-color board.
  {
    const gw = 10, gh = 10;
    const grid = new Uint8Array(gw * gh);
    const next = new Uint8Array(gw * gh);
    // block at (2,2)-(3,3)
    grid[2 * gw + 2] = 1; grid[2 * gw + 3] = 1; grid[3 * gw + 2] = 1; grid[3 * gw + 3] = 1;
    // blinker (vertical) at x=6, y=2..4
    grid[2 * gw + 6] = 1; grid[3 * gw + 6] = 1; grid[4 * gw + 6] = 1;
    const before = grid.slice();
    stepCA(grid, next, gw, gh);
    let g1 = next;
    const blockStable = g1[2 * gw + 2] === 1 && g1[2 * gw + 3] === 1 && g1[3 * gw + 2] === 1 && g1[3 * gw + 3] === 1;
    check('block is a still life after 1 gen', blockStable, JSON.stringify([...g1.slice(0, 40)]));
    const blinkerFlippedHoriz = g1[3 * gw + 5] === 1 && g1[3 * gw + 6] === 1 && g1[3 * gw + 7] === 1;
    check('blinker flips to horizontal after 1 gen', blinkerFlippedHoriz);
    const next2 = new Uint8Array(gw * gh);
    stepCA(g1, next2, gw, gh);
    const blinkerBackToVert = next2[2 * gw + 6] === 1 && next2[3 * gw + 6] === 1 && next2[4 * gw + 6] === 1;
    check('blinker returns to vertical after 2 gens (period 2)', blinkerBackToVert);

    // glider: after 4 generations, returns to original shape translated by (1,1)
    const gg = new Uint8Array(gw * gh);
    let gn = new Uint8Array(gw * gh);
    const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
    for (const [dx, dy] of glider) gg[(1 + dy) * gw + (1 + dx)] = 1;
    let cur = gg;
    for (let i = 0; i < 4; i++) {
      stepCA(cur, gn, gw, gh);
      const t = cur; cur = gn; gn = t;
    }
    let match = true;
    for (const [dx, dy] of glider) if (cur[(2 + dy) * gw + (2 + dx)] !== 1) match = false;
    let liveCount = 0;
    for (let i = 0; i < cur.length; i++) if (cur[i] === 1) liveCount++;
    check('glider returns to its shape translated by (1,1) after 4 gens', match && liveCount === 5, 'live=' + liveCount);
  }

  // 1. world initializes
  const sim = makeSim('selftest-seed', 0);
  check('world initializes: grid allocated', sim.grid.length === GW * GH);
  check('world initializes: both colonies seeded', sim.n1 > 0 && sim.n2 > 0, `n1=${sim.n1} n2=${sim.n2}`);
  check('world initializes: biomass starts correct', sim.biomassP === 40 && sim.biomassAI === 40);

  // 3. progress events: territory percentages update as the CA runs
  {
    const s = makeSim('progress-seed', 0);
    const p0 = s.pctP;
    for (let i = 0; i < 200; i++) stepSim(s, null, 1 / 60);
    check('territory percentages update over time', s.tickCount > 0 && (s.pctP !== p0 || s.pctAI !== 0));
  }

  // 4/5. win and lose are both reachable via scripted sims
  {
    const s = makeSim('win-seed', 0);
    // wipe AI cells, heavily seed player so it dominates & AI never respawns (no biomass either).
    for (let i = 0; i < s.grid.length; i++) if (s.grid[i] === 2) s.grid[i] = 0;
    s.biomassAI = 0; s.aiInterval = 999999; s.aiTimer = 999999;
    for (let y = 4; y < GH - 4; y += 3) {
      for (let x = 4; x < GW - 4; x += 3) {
        stampPattern(s.grid, s.gw, s.gh, patternById('block'), x, y, 0, 1);
      }
    }
    let steps = 0;
    while (s.phase === 'playing' && steps < 2000) { stepSim(s, null, 1 / 20); steps++; }
    check('WIN is reachable from a scripted dominant-player sim', s.phase === 'won', `phase=${s.phase} pctP=${s.pctP.toFixed(2)} steps=${steps}`);
  }
  {
    const s = makeSim('lose-seed', 0);
    for (let i = 0; i < s.grid.length; i++) if (s.grid[i] === 1) s.grid[i] = 0;
    s.biomassP = 0;
    for (let y = 4; y < GH - 4; y += 3) {
      for (let x = 4; x < GW - 4; x += 3) {
        stampPattern(s.grid, s.gw, s.gh, patternById('block'), x, y, 0, 2);
      }
    }
    let steps = 0;
    while (s.phase === 'playing' && steps < 2000) { stepSim(s, null, 1 / 20); steps++; }
    check('LOSE is reachable from a scripted dominant-AI sim', s.phase === 'lost', `phase=${s.phase} pctAI=${s.pctAI.toFixed(2)} steps=${steps}`);
  }

  // 6. finite state + legal cell enum over >=600 frames
  {
    const s = makeSim('finite-seed', 1);
    for (let i = 0; i < 620; i++) stepSim(s, null, 1 / 60);
    const fin = allFinite({ biomassP: s.biomassP, biomassAI: s.biomassAI, pctP: s.pctP, pctAI: s.pctAI, matchTime: s.matchTime });
    check('allFinite after >=600 frames', fin.ok, JSON.stringify(fin.bad));
    let legal = true;
    for (let i = 0; i < s.grid.length; i++) if (s.grid[i] !== 0 && s.grid[i] !== 1 && s.grid[i] !== 2) legal = false;
    check('grid contains only legal cell values (0/1/2)', legal);
  }

  // 2 + live game drive: injected pointer click stamps the selected pattern
  {
    // boot() always repoints globalThis.__game at whatever it just created — this
    // throwaway instance would otherwise silently orphan the real page's debug
    // handle (the real game keeps running and rendering fine either way, since
    // this instance never calls .draw(), but anyone poking at __game in devtools
    // after calling __selftest() would be looking at a dead object).
    const realGameHandle = globalThis.__game;
    const g = boot({
      id: 'petri-selftest', title: 'Petri (selftest)', seed: 'live-seed',
      init, update, render, autoStart: false,
    });
    g.state.introDone = true;
    const before = g.state.sim.n1;
    g.state.selected = 'glider';
    const patternCells = patternById('glider').cells.length;
    g.input.pointTo(g.w * 0.5, g.h * 0.5);
    g.input.pointDown(g.w * 0.5, g.h * 0.5);
    g.step(1);
    g.input.pointUp(g.w * 0.5, g.h * 0.5);
    // n1 is a population count only recomputed on the CA's own throttled tick
    // (CA_STEP = 1/11s, independent of the 60fps render step), not every frame —
    // one step(1) is ~1/60s, not enough real time for a tick to have fired yet.
    // lastStamp already proves the write landed; step past a tick boundary (>=6
    // frames at 1/60 each) before trusting n1 to reflect it.
    for (let i = 0; i < 8; i++) g.step(1);
    const after = g.state.sim.n1;
    check('injected pointer click writes the pattern into the grid', !!g.state.sim.lastStamp && g.state.sim.lastStamp.patternId === 'glider');
    check('injected pointer click stamps the selected pattern', after - before === patternCells, `before=${before} after=${after} expected+${patternCells}`);

    // run the live game forward a bit to make sure nothing throws through the render/update path
    for (let i = 0; i < 120; i++) g.step(1);
    const fin2 = allFinite({ biomass: g.state.sim.biomassP, pct: g.state.sim.pctP });
    check('live game runs 120+ frames without producing non-finite state', fin2.ok, JSON.stringify(fin2.bad));
    if (realGameHandle) globalThis.__game = realGameHandle;
  }

  log('petri self-test complete');
});
