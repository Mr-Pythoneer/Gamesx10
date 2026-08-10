// The Nine — a procedural deduction puzzle aboard the survey barque FERRAND WAKE.
//
// Nine berths. Each holds a hidden NAME, ROLE and (above CADET) a FATE. The recovered
// papers constrain them; a machine-verified generator guarantees exactly one consistent
// roster and no redundant clue. The player fills the roster and CONFIRMs: three or more
// simultaneously-correct assignments lock in forever, fewer reveal nothing at all — so
// partial knowledge compounds instead of resetting, and guessing is never worth it.
//
// Shape (mirrors games/mirrorbind):
//   generate.js is pure + DOM-free, so the self-test can hammer the generator and the
//   solver headlessly. game.js is state + one update() + one render(), and every player
//   action here (assign / confirm / lock) is a plain function the self-test drives directly.

import {
  boot, registerSelftest, Palette, FX, Sound, Store,
  RNG, randomSeedString, clamp, text, roundRect, allFinite, TAU,
  T, mountLangToggle,
} from '../../shared/kit.js';
import {
  generate, countSolutions, solveFirst, positionsOf, clueHolds,
  TIERS, ATTRS, SHIP, BERTHS, valueLabel,
  CASES, generateCaseN,
} from './generate.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const ATTR_COLOR = { name: Palette.accent2, role: Palette.warm, fate: Palette.violet };
const LOCK_HOLD = 3;   // simultaneous correct assignments required to lock a batch

// ---------------------------------------------------------------- i18n for generate.js's fixed vocab
//
// TIERS/ATTRS/SHIP in generate.js are fixed constants (not per-seed procedural content),
// but generate.js itself is out of scope to edit (see file header). These small lookup
// tables translate that fixed vocabulary for display without touching generate.js.
const TIER_ZH = { CADET: '新兵', OFFICER: '军官', ARCHIVIST: '档案员' };
const TIER_BLURB_ZH = {
  'Two ledgers — names and roles. The papers speak plainly.': '两本记录——姓名与职务。文书直言不讳。',
  'Three ledgers — names, roles, and how each one ended.': '三本记录——姓名、职务,以及各自的结局。',
  'Three ledgers, and nothing stated outright.': '三本记录,却无一直言。',
};
const ATTR_ZH = { NAME: '姓名', ROLE: '职务', FATE: '结局' };
const SHIP_LINE_ZH = '勘测三桅船。九人于佩尔港登船,无一归来。';

const CAMPAIGN_UNLOCKED_KEY = 'campaignUnlocked';
const CAMPAIGN_SOLVED_KEY = 'campaignSolved';

function tierLabel(tier) { return T(tier.label, TIER_ZH[tier.label] || tier.label); }
function tierBlurb(tier) { return T(tier.blurb, TIER_BLURB_ZH[tier.blurb] || tier.blurb); }
function attrLabel(attr) { const l = ATTRS[attr].label; return T(l, ATTR_ZH[l] || l); }

/** Builds the status-line text for the roster panel from a key, not a baked string, so it
 *  re-translates live if the player flips language while the message is still showing. */
function msgText(s) {
  switch (s.msgKey) {
    case 'start': return T('Read the papers. Fill the roster. Confirm three at once.', '阅读文书,填写花名册。一次确认三项。');
    case 'need3': return T('Assign at least three before confirming.', '确认前至少分配三项。');
    case 'nohold': return T('No three hold together.', '没有三项能同时成立。');
    case 'held': return s.msgArg + T(' held. They are yours for good.', ' 项已锁定,永久属于你。');
    case 'taken': return T(`That one is already proven at berth ${s.msgArg}.`, `该项已在 ${s.msgArg} 号铺位得到证实。`);
    case 'locked': return T('Proven. That one cannot change.', '已证实,无法更改。');
    default: return '';
  }
}

// ---------------------------------------------------------------- state

function blankBoard(attrs) {
  const grid = {}, locked = {}, ruled = {};
  for (const a of attrs) {
    grid[a] = new Array(BERTHS).fill(-1);
    locked[a] = new Array(BERTHS).fill(0);
    ruled[a] = new Array(BERTHS).fill(0);
  }
  return { grid, locked, ruled };
}

/** Shared board/session reset — used by both free-roll and Campaign puzzle loads. */
function applyPuzzle(s, puzzle) {
  s.puzzle = puzzle;
  s.seedStr = String(puzzle.seed).toUpperCase();
  s.tierIndex = puzzle.tierIndex;
  s.attrs = puzzle.attrs.slice();
  Object.assign(s, blankBoard(s.attrs));
  s.pinned = puzzle.clues.map(() => 0);
  s.cells = s.attrs.length * BERTHS;
  s.lockedCount = 0;
  s.confirms = 0;
  s.time = 0;
  s.focus = -1;
  s.picker = null;
  s.scroll = 0;
  s.scrollMax = 0;
  s.drag = null;
  s.lock = null;
  s.fail = 0;
  s.msg = 'Read the papers. Fill the roster. Confirm three at once.';
  s.msgT = 5;
  s.msgTone = 0;
  s.solvedAt = 0;
  s._wrapKey = '';
  s._wrap = null;
  s._boxes = null;
  if (s.phase === 'solved' || s.phase === 'lockin') s.phase = 'play';
}

function newPuzzle(s, seedStr, tierIndex) {
  const tier = TIERS[clamp(tierIndex | 0, 0, TIERS.length - 1)];
  s.mode = 'free';
  s.caseN = 0;
  applyPuzzle(s, generate(String(seedStr).toUpperCase(), tier.id));
  Store.set('tier', s.tierIndex);
  return s;
}

/** Load Campaign case N (1-based, clamped). Refuses locked cases — falls back to
 *  whichever case is currently unlocked. */
function newPuzzleCase(s, n) {
  const unlocked = clamp(Store.get(CAMPAIGN_UNLOCKED_KEY, 1), 1, CASES.length);
  const caseN = clamp(n | 0, 1, unlocked);
  s.mode = 'campaign';
  s.caseN = caseN;
  applyPuzzle(s, generateCaseN(caseN));
  return s;
}

function init(g) {
  const s = {
    phase: 'intro',
    seedStr: '', tierIndex: 1, puzzle: null, attrs: [],
    grid: {}, locked: {}, ruled: {}, pinned: [],
    cells: 0, lockedCount: 0, confirms: 0, time: 0,
    focus: -1, picker: null, view: 0,
    scroll: 0, scrollMax: 0, drag: null,
    lock: null, fail: 0, flash: 0,
    msg: '', msgT: 0, msgTone: 0, solvedAt: 0,
    solvedTotal: Store.get('solved', 0),
    mode: 'free', caseN: 0,
    campaignUnlocked: clamp(Store.get(CAMPAIGN_UNLOCKED_KEY, 1), 1, CASES.length),
    campaignSolved: Store.get(CAMPAIGN_SOLVED_KEY, {}),
    casesScroll: 0, casesScrollMax: 0,
    _wrapKey: '', _wrap: null, _wrapSpace: 8, _boxes: null,
  };
  const tier = clamp(Store.get('tier', 1), 0, TIERS.length - 1);
  newPuzzle(s, g.puzzleSeed || randomSeedString(6), tier);
  s.phase = 'intro';
  return s;
}

// ---------------------------------------------------------------- board actions (pure-ish)

function unlockedCells(s) {
  let n = 0;
  for (const a of s.attrs) for (let b = 0; b < BERTHS; b++) if (!s.locked[a][b]) n++;
  return n;
}
function assignedUnlocked(s) {
  let n = 0;
  for (const a of s.attrs) for (let b = 0; b < BERTHS; b++) if (!s.locked[a][b] && s.grid[a][b] >= 0) n++;
  return n;
}

/** Place `val` at (attr, berth); the value is a bijection, so it leaves any other berth. */
function assign(s, attr, berth, val) {
  if (s.locked[attr][berth]) return false;
  const other = s.grid[attr].indexOf(val);
  if (other >= 0 && other !== berth) {
    if (s.locked[attr][other]) return false;   // that one is proven — refuse the steal
    s.grid[attr][other] = -1;
  }
  s.grid[attr][berth] = val;
  s.ruled[attr][berth] &= ~(1 << val);
  return true;
}
function clearCell(s, attr, berth) {
  if (s.locked[attr][berth]) return false;
  s.grid[attr][berth] = -1;
  return true;
}
function toggleRuled(s, attr, berth, val) {
  if (s.locked[attr][berth]) return false;
  s.ruled[attr][berth] ^= (1 << val);
  if (s.grid[attr][berth] === val && (s.ruled[attr][berth] >> val) & 1) s.grid[attr][berth] = -1;
  return true;
}
function clearBoard(s) {
  for (const a of s.attrs) for (let b = 0; b < BERTHS; b++) if (!s.locked[a][b]) s.grid[a][b] = -1;
}

function canConfirm(s) {
  const rem = unlockedCells(s);
  if (rem === 0) return false;
  const asg = assignedUnlocked(s);
  return asg >= LOCK_HOLD || (asg === rem && asg > 0);
}

/**
 * The whole design lives here. Count the unlocked assignments that are correct; if three
 * or more hold at once they lock permanently. Otherwise nothing is revealed — not which
 * ones were wrong, not how many were right.
 */
function doConfirm(s, g) {
  if (s.phase !== 'play' || !s.puzzle) return -1;
  if (!canConfirm(s)) {
    s.msg = 'Assign at least three before confirming.';
    s.msgT = 2.4; s.msgTone = -1;
    Sound.blip(220);
    return -1;
  }
  s.confirms++;
  const hits = [];
  let rem = 0, complete = true;
  for (let ai = 0; ai < s.attrs.length; ai++) {
    const a = s.attrs[ai];
    for (let b = 0; b < BERTHS; b++) {
      if (s.locked[a][b]) continue;
      rem++;
      const v = s.grid[a][b];
      if (v < 0) { complete = false; continue; }
      if (v === s.puzzle.truth[a][b]) hits.push({ ai, a, b });
      else complete = false;
    }
  }
  if (hits.length >= LOCK_HOLD || (complete && hits.length === rem && rem > 0)) {
    lockIn(s, hits, g);
    return hits.length;
  }
  // deflate: nothing happened, and the player learns nothing from it
  s.fail = 1;
  s.msg = 'No three hold together.';
  s.msgT = 2.6; s.msgTone = -1;
  FX.shake(2.5);
  Sound.tone({ freq: 190, dur: 0.13, type: 'triangle', gain: 0.08 });
  Sound.tone({ freq: 132, dur: 0.22, type: 'triangle', gain: 0.07, at: 0.1, slide: -34 });
  return 0;
}

function lockIn(s, hits, g) {
  for (const hit of hits) s.locked[hit.a][hit.b] = 1;
  s.lockedCount += hits.length;
  s.lock = {
    t: 0,
    dur: Math.min(1.5, 0.5 + hits.length * 0.075),
    cells: hits.map((hit, i) => ({ ...hit, delay: i * 0.07, popped: 0 })),
  };
  s.phase = 'lockin';
  s.msg = hits.length + ' held. They are yours for good.';
  s.msgT = 3.2; s.msgTone = 1;
  s.flash = 1;
  FX.shake(5 + Math.min(6, hits.length));
  Sound.tone({ freq: 240, dur: 0.5, type: 'sine', gain: 0.1, slide: 180 });
  Sound.thud();
}

function finishSolve(s, g) {
  s.phase = 'solved';
  s.solvedAt = s.time;
  for (const a of s.attrs) for (let b = 0; b < BERTHS; b++) s.grid[a][b] = s.puzzle.truth[a][b];
  s.solvedTotal = Store.get('solved', 0) + 1;
  Store.set('solved', s.solvedTotal);
  const tier = TIERS[s.tierIndex].id;
  s.newBestTime = Store.best('bestTime:' + tier, Math.round(s.time * 10) / 10, false);
  s.newBestConf = Store.best('bestConfirms:' + tier, s.confirms, false);
  if (s.mode === 'campaign' && s.caseN > 0) {
    const solved = { ...s.campaignSolved, [s.caseN]: true };
    s.campaignSolved = solved;
    Store.set(CAMPAIGN_SOLVED_KEY, solved);
    const nextUnlock = clamp(s.caseN + 1, 1, CASES.length);
    s.campaignUnlocked = Math.max(s.campaignUnlocked, nextUnlock);
    Store.set(CAMPAIGN_UNLOCKED_KEY, s.campaignUnlocked);
    s.newCaseUnlocked = nextUnlock > s.caseN && nextUnlock <= CASES.length && nextUnlock === s.campaignUnlocked;
  }
  FX.shake(10);
  Sound.ok();
  Sound.tone({ freq: 523, dur: 0.5, type: 'triangle', gain: 0.1, at: 0.08 });
  Sound.tone({ freq: 784, dur: 0.6, type: 'triangle', gain: 0.09, at: 0.2 });
}

// ---------------------------------------------------------------- layout (pure arithmetic)

function layout(g, s) {
  const w = g.w, h = g.h;
  const S = clamp(Math.min(w / 900, h / 620), 0.58, 1.3);
  const pad = Math.max(6, Math.round(9 * S));
  const narrow = w < 720;
  const headH = Math.max(24, Math.round(32 * S));
  const btnH = Math.max(22, Math.round(27 * S));
  const rows = narrow ? 2 : 1;
  const footH = btnH * rows + pad * (rows + 1);
  const bodyY = headH;
  const bodyH = Math.max(80, h - headH - footH);
  const A = Math.max(1, s.attrs.length);

  let roster, papers;
  if (narrow) {
    const r = { x: pad, y: bodyY + pad, w: Math.max(120, w - pad * 2), h: Math.max(60, bodyH - pad * 2) };
    roster = r; papers = { ...r };
  } else {
    const rw = clamp(Math.round(w * 0.47), 250, 540);
    roster = { x: pad, y: bodyY + pad, w: rw, h: Math.max(60, bodyH - pad * 2) };
    papers = { x: pad * 2 + rw, y: roster.y, w: Math.max(120, w - rw - pad * 3), h: roster.h };
  }

  // roster grid
  const colHeadH = Math.max(13, Math.round(15 * S));
  const rowH = clamp((roster.h - colHeadH - 4) / BERTHS, 15, 44 * S);
  const gridH = rowH * BERTHS;
  const gridTop = roster.y + colHeadH + Math.max(2, Math.min(10, (roster.h - colHeadH - gridH) / 2));
  const bnW = clamp(Math.round(26 * S), 17, 38);
  const colStride = (roster.w - bnW) / A;
  const colGap = Math.max(2, Math.round(3 * S));

  const cell = (ai, b) => ({
    x: roster.x + bnW + ai * colStride,
    y: gridTop + b * rowH,
    w: colStride - colGap,
    h: rowH - Math.max(2, 3 * S),
  });
  const berthTag = (b) => ({ x: roster.x, y: gridTop + b * rowH, w: bnW - 2, h: rowH - Math.max(2, 3 * S) });

  // papers list
  const listHeadH = Math.max(15, Math.round(17 * S));
  const list = {
    x: papers.x + Math.round(7 * S), y: papers.y + listHeadH + Math.round(4 * S),
    w: Math.max(60, papers.w - Math.round(20 * S)),
    h: Math.max(40, papers.h - listHeadH - Math.round(10 * S)),
  };

  // footer buttons
  const buttons = [];
  const avail = w - pad * 2;
  const y1 = h - footH + pad;
  const y2 = y1 + btnH + pad;
  if (narrow) {
    const cw = Math.max(70, Math.round(avail * 0.42));
    const sw = Math.max(44, Math.round((avail - cw - pad * 2) / 2));
    buttons.push({ id: 'confirm', x: pad, y: y1, w: cw, h: btnH, label: T('CONFIRM', '确认') });
    buttons.push({ id: 'clear', x: pad + cw + pad, y: y1, w: sw, h: btnH, label: T('CLEAR', '清空') });
    buttons.push({ id: 'new', x: pad + cw + pad + sw + pad, y: y1, w: sw, h: btnH, label: T('NEW', '新局') });
    const tw = Math.max(32, Math.round((avail - pad * 4) / 5));
    for (let i = 0; i < 3; i++) buttons.push({ id: 'tier' + i, x: pad + i * (tw + pad), y: y2, w: tw, h: btnH, label: T(TIERS[i].label, TIERS[i].labelZh || TIERS[i].label).slice(0, 5) });
    buttons.push({ id: 'view', x: pad + 3 * (tw + pad), y: y2, w: tw, h: btnH, label: s.view ? T('ROSTER', '名册') : T('PAPERS', '文书') });
    buttons.push({ id: 'cases', x: pad + 4 * (tw + pad), y: y2, w: tw, h: btnH, label: T('CASES', '战役') });
  } else {
    const cw = clamp(Math.round(w * 0.2), 120, 210);
    const sw = Math.max(58, Math.round(74 * S));
    buttons.push({ id: 'confirm', x: pad, y: y1, w: cw, h: btnH, label: T('CONFIRM  ⏎', '确认  ⏎') });
    buttons.push({ id: 'clear', x: pad + cw + pad, y: y1, w: sw, h: btnH, label: T('CLEAR', '清空') });
    buttons.push({ id: 'new', x: pad + cw + pad * 2 + sw, y: y1, w: sw + Math.round(18 * S), h: btnH, label: T('NEW SEED', '新种子') });
    buttons.push({ id: 'cases', x: pad + cw + pad * 3 + sw * 2 + Math.round(18 * S), y: y1, w: sw + Math.round(6 * S), h: btnH, label: T('CASES', '战役') });
    const tw = Math.max(56, Math.round(84 * S));
    const x0 = w - pad - tw * 3 - pad * 2;
    for (let i = 0; i < 3; i++) buttons.push({ id: 'tier' + i, x: x0 + i * (tw + pad), y: y1, w: tw, h: btnH, label: T(TIERS[i].label, TIERS[i].labelZh || TIERS[i].label) });
  }

  // Campaign case-picker grid — a simple wrap of numbered tiles between header and footer.
  const casesArea = { x: pad, y: bodyY + pad, w: Math.max(120, w - pad * 2), h: Math.max(60, bodyH - pad * 2) };
  const casesCols = clamp(Math.floor(casesArea.w / (narrow ? 56 : 74)), 4, 10);
  const casesGap = Math.max(4, Math.round(6 * S));
  const caseTileW = (casesArea.w - casesGap * (casesCols - 1)) / casesCols;
  const caseTileH = Math.max(30, Math.round(38 * S));
  const casesRows = Math.ceil(CASES.length / casesCols);
  const caseTile = (i) => {
    const col = i % casesCols, row = Math.floor(i / casesCols);
    return {
      x: casesArea.x + col * (caseTileW + casesGap),
      y: casesArea.y + row * (caseTileH + casesGap) - s.casesScroll,
      w: caseTileW, h: caseTileH,
    };
  };
  const casesContentH = casesRows * caseTileH + Math.max(0, casesRows - 1) * casesGap;

  return {
    S, pad, narrow, headH, footH, btnH, roster, papers, colHeadH, rowH, gridTop, bnW, colStride, colGap,
    cell, berthTag, list, listHeadH, buttons, A, w, h,
    casesArea, casesCols, casesRows, caseTile, casesContentH,
  };
}

/** Popup for the currently open cell. Pure arithmetic so the self-test can click it. */
function pickerBox(L, s) {
  if (!s.picker) return null;
  const { attr, berth } = s.picker;
  const ai = s.attrs.indexOf(attr);
  const c = L.cell(ai, berth);
  const rowH = Math.max(15, Math.round(19 * L.S));
  const pw = clamp(Math.max(L.colStride * 1.35, 132 * L.S), 110, 250);
  const ph = rowH * (BERTHS + 1) + Math.round(8 * L.S);
  let x = c.x - 4;
  let y = c.y + c.h + 3;
  if (y + ph > L.h - 4) y = Math.max(4, c.y - ph - 3);
  x = clamp(x, 4, L.w - pw - 4);
  y = clamp(y, 4, Math.max(4, L.h - ph - 4));
  return { x, y, w: pw, h: ph, rowH, pad: Math.round(4 * L.S) };
}
function pickerRow(box, i) {
  return { x: box.x + box.pad, y: box.y + box.pad + i * box.rowH, w: box.w - box.pad * 2, h: box.rowH };
}

function hit(r, x, y) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

// ---------------------------------------------------------------- clue list ordering

function clueOrder(s) {
  const cl = s.puzzle.clues;
  let idx = cl.map((c, i) => i);
  if (s.focus >= 0) {
    const want = [];
    for (const a of s.attrs) { const v = s.grid[a][s.focus]; if (v >= 0) want.push({ a, v }); }
    idx = idx.filter((i) => want.some((t) => cl[i].terms.some((tm) => tm.a === t.a && tm.v === t.v)));
  }
  idx.sort((a, b) => (s.pinned[b] - s.pinned[a]) || (a - b));
  return idx;
}

// ---------------------------------------------------------------- update

function update(s, dt, g) {
  const I = g.input;
  const L = layout(g, s);

  s.flash = Math.max(0, s.flash - dt * 2.6);
  s.fail = Math.max(0, s.fail - dt * 2.2);
  if (s.msgT > 0) s.msgT -= dt;

  if (s.phase === 'intro') {
    if (I.justPressed('space') || I.justPressed('enter') || I.pointerPressed) {
      s.phase = 'play';
      Sound.init(); Sound.resume();
      Sound.blip(520);
    }
    return;
  }

  if (s.phase === 'cases') {
    s.casesScrollMax = Math.max(0, L.casesContentH - L.casesArea.h);
    if (I.justPressed('escape') || I.justPressed('c')) { s.phase = 'play'; Sound.blip(340); return; }
    if (I.isDown('down')) s.casesScroll = clamp(s.casesScroll + 420 * dt, 0, s.casesScrollMax);
    if (I.isDown('up')) s.casesScroll = clamp(s.casesScroll - 420 * dt, 0, s.casesScrollMax);
    s.casesScroll = clamp(s.casesScroll, 0, s.casesScrollMax);
    if (I.pointerPressed) {
      const px0 = I.pointer.x, py0 = I.pointer.y;
      for (const b of L.buttons) {
        if (b.id === 'cases' && hit(b, px0, py0)) { s.phase = 'play'; Sound.blip(340); return; }
      }
      for (let i = 0; i < CASES.length; i++) {
        const r = L.caseTile(i);
        if (!hit(r, px0, py0)) continue;
        const n = i + 1;
        if (n <= s.campaignUnlocked) {
          newPuzzleCase(s, n);
          s.phase = 'play';
          Sound.blip(560 + (n % 12) * 10);
        } else {
          Sound.blip(160);
        }
        return;
      }
    }
    return;
  }

  if (s.phase === 'play' || s.phase === 'lockin') s.time += dt;

  if (s.phase === 'lockin' && s.lock) {
    s.lock.t += dt;
    for (const c of s.lock.cells) {
      if (!c.popped && s.lock.t >= c.delay) {
        c.popped = 1;
        const r = L.cell(c.ai, c.b);
        FX.burst(r.x + r.w / 2, r.y + r.h / 2, {
          count: 14, color: ATTR_COLOR[c.a] || Palette.accent,
          speed: 130, life: 0.5, size: 2.6, drag: 0.86,
        });
        Sound.tone({ freq: 420 + c.delay * 900, dur: 0.1, type: 'triangle', gain: 0.07 });
      }
    }
    if (s.lock.t >= s.lock.dur) {
      s.lock = null;
      if (unlockedCells(s) === 0) finishSolve(s, g);
      else s.phase = 'play';
    }
    return;
  }

  // ---- keyboard
  if (I.justPressed('enter')) doConfirm(s, g);
  if (I.justPressed('escape')) { if (s.picker) s.picker = null; else s.focus = -1; }
  if (I.justPressed('n')) { newPuzzle(s, randomSeedString(6), s.tierIndex); s.phase = 'play'; Sound.blip(600); return; }
  if (I.justPressed('r')) { clearBoard(s); s.picker = null; Sound.blip(300); }
  if (I.justPressed('tab') || I.justPressed('v')) s.view = s.view ? 0 : 1;
  if (I.justPressed('c')) { s.phase = 'cases'; Sound.blip(400); return; }
  for (let i = 0; i < 3; i++) {
    if (I.justPressed(String(i + 1))) {
      newPuzzle(s, randomSeedString(6), i);
      s.phase = 'play'; Sound.blip(500 + i * 80);
      return;
    }
  }
  if (I.isDown('down')) s.scroll = clamp(s.scroll + 420 * dt, 0, s.scrollMax);
  if (I.isDown('up')) s.scroll = clamp(s.scroll - 420 * dt, 0, s.scrollMax);

  if (s.phase === 'solved') {
    if (I.justPressed('space') || I.pointerPressed) {
      if (s.mode === 'campaign' && s.caseN < s.campaignUnlocked) {
        newPuzzleCase(s, s.caseN + 1);
      } else {
        newPuzzle(s, randomSeedString(6), s.tierIndex);
      }
      s.phase = 'play';
    }
    return;
  }

  // ---- pointer
  const px = I.pointer.x, py = I.pointer.y;

  if (I.pointerPressed) {
    // 1. picker popup swallows the click
    const box = pickerBox(L, s);
    if (box) {
      let used = false;
      if (hit(box, px, py)) {
        used = true;
        const attr = s.picker.attr, berth = s.picker.berth;
        for (let i = 0; i < BERTHS + 1; i++) {
          const r = pickerRow(box, i);
          if (!hit(r, px, py)) continue;
          if (i === BERTHS) { clearCell(s, attr, berth); s.picker = null; Sound.blip(280); break; }
          const markW = Math.max(14, 18 * L.S);
          if (px >= r.x + r.w - markW) {
            toggleRuled(s, attr, berth, i);
            Sound.blip(360);
          } else {
            const owner = s.grid[attr].indexOf(i);
            if (owner >= 0 && owner !== berth && s.locked[attr][owner]) {
              s.msg = 'That one is already proven at berth ' + (owner + 1) + '.';
              s.msgT = 2.2; s.msgTone = -1;
              Sound.blip(200);
            } else {
              assign(s, attr, berth, i);
              s.picker = null;
              Sound.blip(620 + i * 18);
            }
          }
          break;
        }
      }
      // A click anywhere else dismisses the popup and is still delivered normally, so
      // hitting a button or another cell takes one click rather than two.
      if (!used) s.picker = null;
      if (used) return;
    }

    // 2. footer buttons
    let onButton = false;
    for (const b of L.buttons) {
      if (!hit(b, px, py)) continue;
      onButton = true;
      if (b.id === 'confirm') doConfirm(s, g);
      else if (b.id === 'clear') { clearBoard(s); Sound.blip(300); }
      else if (b.id === 'new') { newPuzzle(s, randomSeedString(6), s.tierIndex); s.phase = 'play'; Sound.blip(600); }
      else if (b.id === 'view') { s.view = s.view ? 0 : 1; Sound.blip(440); }
      else if (b.id === 'cases') { s.phase = 'cases'; Sound.blip(400); }
      else if (b.id.startsWith('tier')) {
        const t = Number(b.id.slice(4));
        newPuzzle(s, randomSeedString(6), t); s.phase = 'play'; Sound.blip(500 + t * 80);
      }
      break;
    }
    if (onButton) return;

    // 3. roster
    const showRoster = !L.narrow || s.view === 0;
    if (showRoster && hit(L.roster, px, py)) {
      for (let b = 0; b < BERTHS; b++) {
        if (hit(L.berthTag(b), px, py)) {
          s.focus = s.focus === b ? -1 : b;
          s.scroll = 0;
          Sound.blip(s.focus >= 0 ? 500 : 340);
          return;
        }
        for (let ai = 0; ai < s.attrs.length; ai++) {
          if (!hit(L.cell(ai, b), px, py)) continue;
          const attr = s.attrs[ai];
          if (s.locked[attr][b]) {
            s.msg = 'Proven. That one cannot change.';
            s.msgT = 1.8; s.msgTone = 0;
            Sound.blip(240);
          } else {
            s.picker = { attr, berth: b };
            Sound.blip(700);
          }
          return;
        }
      }
      return;
    }

    // 4. papers list — press starts a drag that may turn out to be a click
    const showPapers = !L.narrow || s.view === 1;
    if (showPapers && hit(L.papers, px, py)) {
      let idx = -1;
      if (s._boxes) for (const bx of s._boxes) if (py >= bx.y && py <= bx.y + bx.h) { idx = bx.i; break; }
      s.drag = { y0: py, s0: s.scroll, moved: 0, idx };
      return;
    }
  }

  if (s.drag) {
    if (I.pointer.down) {
      const dy = py - s.drag.y0;
      if (Math.abs(dy) > 4) s.drag.moved = 1;
      s.scroll = clamp(s.drag.s0 - dy, 0, s.scrollMax);
    } else {
      if (!s.drag.moved && s.drag.idx >= 0 && s.drag.idx < s.pinned.length) {
        s.pinned[s.drag.idx] = s.pinned[s.drag.idx] ? 0 : 1;
        Sound.blip(s.pinned[s.drag.idx] ? 760 : 420);
      }
      s.drag = null;
    }
  }
  s.scroll = clamp(s.scroll, 0, s.scrollMax);
}

// ---------------------------------------------------------------- render helpers

function tokensToWords(tokens) {
  const words = [];
  let cur = [];
  for (const tk of tokens) {
    for (const part of tk.t.split(/(\s+)/)) {
      if (part === '') continue;
      if (/^\s+$/.test(part)) { if (cur.length) { words.push(cur); cur = []; } continue; }
      cur.push({ t: part, a: tk.a, v: tk.v });
    }
  }
  if (cur.length) words.push(cur);
  return words;
}

function ensureWrap(s, ctx, width, size) {
  const key = `${Math.round(width)}|${size.toFixed(1)}|${s.puzzle.seed}|${s.puzzle.difficulty}`;
  if (s._wrapKey === key && s._wrap) return s._wrap;
  ctx.font = `500 ${size}px ${MONO}`;
  const spaceW = ctx.measureText(' ').width;
  s._wrap = s.puzzle.clues.map((c) => {
    const lines = [];
    let cur = [], curW = 0;
    for (const word of tokensToWords(c.tokens)) {
      let ww = 0;
      for (const seg of word) ww += ctx.measureText(seg.t).width;
      const add = cur.length ? spaceW + ww : ww;
      if (cur.length && curW + add > width) { lines.push(cur); cur = [word]; curW = ww; }
      else { cur.push(word); curW += add; }
    }
    if (cur.length) lines.push(cur);
    return lines;
  });
  s._wrapKey = key;
  s._wrapSpace = spaceW;
  return s._wrap;
}

function fmtTime(t) {
  const m = Math.floor(t / 60), sec = Math.floor(t % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Width of `str` in the font it will actually be drawn in.
 * text() save/restores the font, so a bare ctx.measureText() here would silently
 * measure the canvas default (10px sans-serif) and lay the header out from it.
 */
function measureIn(ctx, str, size, weight = 600) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${MONO}`;
  const w = ctx.measureText(String(str)).width;
  ctx.restore();
  return w;
}

function panel(ctx, r, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = Palette.bg2;
  roundRect(ctx, r.x, r.y, r.w, r.h, 9);
  ctx.fill();
  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 9);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function button(ctx, b, S, opts = {}) {
  const { active = false, hot = false, dim = false, scale = 1 } = opts;
  ctx.save();
  ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
  ctx.scale(scale, scale);
  ctx.translate(-b.w / 2, -b.h / 2);
  if (hot) {
    ctx.fillStyle = Palette.accent;
    ctx.globalAlpha = dim ? 0.28 : 1;
    roundRect(ctx, 0, 0, b.w, b.h, 7);
    ctx.fill();
    ctx.globalAlpha = 1;
    text(ctx, b.label, b.w / 2, b.h / 2, { size: Math.max(9, 11 * S), color: dim ? Palette.dim : Palette.bg, align: 'center', baseline: 'middle', weight: 700 });
  } else {
    ctx.fillStyle = active ? Palette.panel : 'rgba(17,22,36,0.55)';
    roundRect(ctx, 0, 0, b.w, b.h, 7);
    ctx.fill();
    ctx.strokeStyle = active ? Palette.accent : Palette.grid;
    ctx.lineWidth = 1;
    roundRect(ctx, 0.5, 0.5, b.w - 1, b.h - 1, 7);
    ctx.stroke();
    text(ctx, b.label, b.w / 2, b.h / 2, { size: Math.max(9, 10.5 * S), color: active ? Palette.accent : Palette.dim, align: 'center', baseline: 'middle', weight: 600 });
  }
  ctx.restore();
}

// ---------------------------------------------------------------- render

function render(s, ctx, g) {
  const L = layout(g, s);
  ctx.fillStyle = Palette.bg;
  ctx.fillRect(0, 0, g.w, g.h);

  drawHeader(s, ctx, g, L);
  const showRoster = !L.narrow || s.view === 0;
  const showPapers = !L.narrow || s.view === 1;
  if (showRoster) drawRoster(s, ctx, g, L);
  if (showPapers) drawPapers(s, ctx, g, L);
  else s._boxes = null;
  drawFooter(s, ctx, g, L);

  FX.draw(ctx);

  if (s.picker && showRoster) drawPicker(s, ctx, g, L);

  if (s.flash > 0) {
    ctx.globalAlpha = s.flash * 0.16;
    ctx.fillStyle = Palette.accent;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalAlpha = 1;
  }
  if (s.phase === 'intro') drawIntro(s, ctx, g, L);
  if (s.phase === 'solved') drawSolved(s, ctx, g, L);
  if (s.phase === 'cases') drawCases(s, ctx, g, L);
}

function drawCases(s, ctx, g, L) {
  const S = L.S;
  ctx.fillStyle = 'rgba(7,8,13,0.93)';
  ctx.fillRect(0, 0, g.w, g.h);

  const hy = L.headH / 2;
  text(ctx, T('THE CAMPAIGN', '战役'), L.pad, hy, { size: Math.max(11, 13 * S), color: Palette.accent, baseline: 'middle', weight: 700 });
  text(ctx, T(`${s.campaignUnlocked}/${CASES.length} UNLOCKED  ·  ESC or C to close`, `已解锁 ${s.campaignUnlocked}/${CASES.length} · 按 ESC 或 C 关闭`),
    g.w - L.pad, hy, { size: Math.max(9, 9.5 * S), color: Palette.dim, align: 'right', baseline: 'middle' });

  ctx.save();
  ctx.beginPath();
  ctx.rect(L.casesArea.x, L.casesArea.y - 2, L.casesArea.w, L.casesArea.h + 4);
  ctx.clip();

  for (let i = 0; i < CASES.length; i++) {
    const r = L.caseTile(i);
    if (r.y + r.h < L.casesArea.y - 4 || r.y > L.casesArea.y + L.casesArea.h + 4) continue;
    const n = i + 1;
    const unlocked = n <= s.campaignUnlocked;
    const solved = !!s.campaignSolved[n];
    const current = s.mode === 'campaign' && s.caseN === n;
    const tierIdx = CASES[i].tierIndex;

    ctx.fillStyle = solved ? 'rgba(94,242,192,0.14)' : unlocked ? Palette.panel : 'rgba(17,22,36,0.4)';
    roundRect(ctx, r.x, r.y, r.w, r.h, 5); ctx.fill();
    ctx.strokeStyle = current ? Palette.accent : solved ? Palette.accent : unlocked ? Palette.grid : 'rgba(255,255,255,0.06)';
    ctx.globalAlpha = current ? 1 : 0.6;
    ctx.lineWidth = current ? 1.5 : 1;
    roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 5); ctx.stroke();
    ctx.globalAlpha = 1;

    if (unlocked) {
      text(ctx, String(n), r.x + r.w / 2, r.y + r.h * 0.36, {
        size: Math.max(10, 12 * S), color: solved ? Palette.accent : Palette.ink, align: 'center', baseline: 'middle', weight: 700,
      });
      text(ctx, TIERS[tierIdx].label.slice(0, 3), r.x + r.w / 2, r.y + r.h * 0.72, {
        size: Math.max(7, 7.5 * S), color: Palette.dim, align: 'center', baseline: 'middle',
      });
    } else {
      text(ctx, '·', r.x + r.w / 2, r.y + r.h / 2, { size: Math.max(10, 12 * S), color: Palette.dim, align: 'center', baseline: 'middle', alpha: 0.4 });
    }
  }
  ctx.restore();
}

function drawHeader(s, ctx, g, L) {
  const S = L.S, y = L.headH / 2;
  ctx.fillStyle = Palette.bg2;
  ctx.fillRect(0, 0, g.w, L.headH);
  ctx.strokeStyle = Palette.grid;
  ctx.beginPath(); ctx.moveTo(0, L.headH - 0.5); ctx.lineTo(g.w, L.headH - 0.5); ctx.stroke();

  const fs = Math.max(9, 10.5 * S);
  const gap = Math.max(7, 10 * S);
  const tight = Math.max(4, 5 * S);
  const labelFs = Math.max(8.5, fs * 0.86);

  // left cluster — every advance measured in the font it is drawn in
  let x = L.pad;
  text(ctx, SHIP.name, x, y, { size: fs, color: Palette.ink, baseline: 'middle', weight: 700 });
  x += measureIn(ctx, SHIP.name, fs, 700) + gap;
  if (s.mode === 'campaign' && s.caseN > 0) {
    const lCase = T('CASE', '案');
    text(ctx, lCase, x, y, { size: labelFs, color: Palette.dim, baseline: 'middle', weight: 600 });
    x += measureIn(ctx, lCase, labelFs, 600) + tight;
    const caseVal = `#${s.caseN}/${CASES.length}`;
    text(ctx, caseVal, x, y, { size: fs, color: Palette.accent, baseline: 'middle', weight: 700 });
    if (!L.narrow) {
      x += measureIn(ctx, caseVal, fs, 700) + gap;
      text(ctx, tierLabel(TIERS[s.tierIndex]), x, y, { size: fs, color: Palette.dim, baseline: 'middle' });
    }
  } else {
    const lSeed = T('SEED', '种子');
    text(ctx, lSeed, x, y, { size: labelFs, color: Palette.dim, baseline: 'middle', weight: 600 });
    x += measureIn(ctx, lSeed, labelFs, 600) + tight;
    text(ctx, s.seedStr, x, y, { size: fs, color: Palette.accent, baseline: 'middle', weight: 700 });
    if (!L.narrow) {
      x += measureIn(ctx, s.seedStr, fs, 700) + gap;
      text(ctx, tierLabel(TIERS[s.tierIndex]), x, y, { size: fs, color: Palette.dim, baseline: 'middle' });
    }
  }

  // right cluster — dim label, bright value, laid out right to left.
  // Same tokens and roughly the same width as before; the hierarchy is what changes.
  const segs = L.narrow
    ? [['', `${s.lockedCount}/${s.cells}`], ['', String(s.confirms)], ['', fmtTime(s.time)]]
    : [[T('PROVEN', '已证实'), `${s.lockedCount}/${s.cells}`], [T('CONFIRMS', '确认次数'), String(s.confirms)], ['', fmtTime(s.time)]];
  let rx = g.w - L.pad;
  for (let i = segs.length - 1; i >= 0; i--) {
    const [label, value] = segs[i];
    text(ctx, value, rx, y, { size: fs, color: Palette.ink, align: 'right', baseline: 'middle', weight: 700 });
    rx -= measureIn(ctx, value, fs, 700);
    if (label) {
      rx -= tight;
      text(ctx, label, rx, y, { size: labelFs, color: Palette.dim, align: 'right', baseline: 'middle', weight: 600 });
      rx -= measureIn(ctx, label, labelFs, 600);
    }
    rx -= gap;
  }
}

function drawRoster(s, ctx, g, L) {
  const S = L.S;
  panel(ctx, L.roster);

  // column headers
  const hy = L.roster.y + L.colHeadH / 2 + 2;
  text(ctx, T('BERTH', '铺位'), L.roster.x + 3, hy, { size: Math.max(8, 8.5 * S), color: Palette.dim, baseline: 'middle', weight: 700 });
  for (let ai = 0; ai < s.attrs.length; ai++) {
    const a = s.attrs[ai];
    const c = L.cell(ai, 0);
    text(ctx, ATTRS[a].label, c.x + c.w / 2, hy, { size: Math.max(8, 9 * S), color: ATTR_COLOR[a], align: 'center', baseline: 'middle', weight: 700 });
  }

  const fs = Math.max(8, Math.min(12 * S, L.colStride / 6.2));
  for (let b = 0; b < BERTHS; b++) {
    const tag = L.berthTag(b);
    const focused = s.focus === b;
    if (focused) {
      ctx.fillStyle = 'rgba(94,242,192,0.09)';
      roundRect(ctx, L.roster.x + 1, tag.y - 1, L.roster.w - 2, tag.h + 2, 5);
      ctx.fill();
    }
    ctx.fillStyle = focused ? Palette.accent : Palette.panel;
    roundRect(ctx, tag.x + 1, tag.y, tag.w - 1, tag.h, 4);
    ctx.fill();
    text(ctx, String(b + 1), tag.x + tag.w / 2, tag.y + tag.h / 2, {
      size: Math.max(9, 11 * S), color: focused ? Palette.bg : Palette.dim,
      align: 'center', baseline: 'middle', weight: 700,
    });

    for (let ai = 0; ai < s.attrs.length; ai++) {
      const a = s.attrs[ai];
      const r = L.cell(ai, b);
      const v = s.grid[a][b];
      const isLocked = !!s.locked[a][b];
      const col = ATTR_COLOR[a];

      let pop = 1;
      if (s.lock) {
        const lc = s.lock.cells.find((c) => c.a === a && c.b === b);
        if (lc) {
          const p = clamp((s.lock.t - lc.delay) / 0.28, 0, 1);
          pop = p < 1 ? 1 + Math.sin(p * Math.PI) * 0.22 : 1;
        }
      }

      ctx.save();
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.scale(pop, pop);
      ctx.translate(-r.w / 2, -r.h / 2);

      if (isLocked) {
        ctx.fillStyle = 'rgba(94,242,192,0.13)';
        roundRect(ctx, 0, 0, r.w, r.h, 5); ctx.fill();
        ctx.strokeStyle = Palette.accent;
        ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
        roundRect(ctx, 0.5, 0.5, r.w - 1, r.h - 1, 5); ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (v >= 0) {
        ctx.fillStyle = Palette.panel;
        roundRect(ctx, 0, 0, r.w, r.h, 5); ctx.fill();
        ctx.strokeStyle = col; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
        roundRect(ctx, 0.5, 0.5, r.w - 1, r.h - 1, 5); ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = Palette.grid;
        ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        roundRect(ctx, 0.5, 0.5, r.w - 1, r.h - 1, 5); ctx.stroke();
        ctx.setLineDash([]);
      }

      if (v >= 0) {
        text(ctx, valueLabel(a, v), r.w / 2, r.h / 2, {
          size: fs, color: isLocked ? Palette.accent : col,
          align: 'center', baseline: 'middle', weight: isLocked ? 700 : 600,
        });
        if (isLocked) {
          ctx.fillStyle = Palette.accent;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(r.w - 5, 3, 2, 2);
          ctx.globalAlpha = 1;
        }
      } else {
        const ruled = s.ruled[a][b] & 0x1ff;
        let left = 0, only = -1;
        for (let i = 0; i < 9; i++) if (!((ruled >> i) & 1)) { left++; only = i; }
        if (left === 1) {
          text(ctx, valueLabel(a, only), r.w / 2, r.h / 2, { size: fs, color: col, align: 'center', baseline: 'middle', alpha: 0.4 });
        } else if (ruled) {
          text(ctx, '−' + (9 - left), r.w / 2, r.h / 2, { size: Math.max(8, fs * 0.8), color: Palette.dim, align: 'center', baseline: 'middle', alpha: 0.6 });
        } else {
          text(ctx, '·', r.w / 2, r.h / 2, { size: fs, color: Palette.grid, align: 'center', baseline: 'middle' });
        }
      }
      ctx.restore();
    }
  }

  // status line under the grid
  const msgY = L.roster.y + L.roster.h - Math.max(9, 11 * S);
  if (s.msgT > 0 && s.msg) {
    const col = s.msgTone > 0 ? Palette.accent : s.msgTone < 0 ? Palette.hot : Palette.dim;
    text(ctx, s.msg, L.roster.x + L.roster.w / 2, msgY, {
      size: Math.max(8, 9.5 * S), color: col, align: 'center', baseline: 'middle',
      alpha: clamp(s.msgT, 0, 1), weight: 600,
    });
  } else {
    text(ctx, 'CLICK A CELL · TAP A BERTH NUMBER TO FILTER', L.roster.x + L.roster.w / 2, msgY, {
      size: Math.max(8, 8.5 * S), color: Palette.dim, align: 'center', baseline: 'middle', alpha: 0.45,
    });
  }
}

function drawPapers(s, ctx, g, L) {
  const S = L.S;
  panel(ctx, L.papers);
  const order = clueOrder(s);
  const hy = L.papers.y + L.listHeadH / 2 + 2;
  text(ctx, T('THE PAPERS', '文书'), L.papers.x + Math.round(7 * S), hy, {
    size: Math.max(8, 9 * S), color: Palette.ink, baseline: 'middle', weight: 700,
  });
  const label = s.focus >= 0
    ? `BERTH ${s.focus + 1} · ${order.length}/${s.puzzle.clues.length}  (ESC clears)`
    : `${s.puzzle.clues.length} FRAGMENTS`;
  text(ctx, label, L.papers.x + L.papers.w - Math.round(7 * S), hy, {
    size: Math.max(8, 8.5 * S), color: s.focus >= 0 ? Palette.accent : Palette.dim, align: 'right', baseline: 'middle',
  });

  const size = Math.max(9, Math.min(11.5 * S, L.list.w / 30));
  const lineH = size * 1.32;
  const srcH = size * 1.1;
  const gap = Math.max(5, 7 * S);
  const wrap = ensureWrap(s, ctx, L.list.w - Math.round(16 * S), size);

  ctx.save();
  ctx.beginPath();
  ctx.rect(L.papers.x + 1, L.list.y - 2, L.papers.w - 2, L.list.h + 4);
  ctx.clip();

  const boxes = [];
  let y = L.list.y - s.scroll;
  for (const i of order) {
    const lines = wrap[i];
    const h = srcH + lines.length * lineH + gap;
    boxes.push({ i, y, h });
    if (y + h > L.list.y - 4 && y < L.list.y + L.list.h + 4) {
      const c = s.puzzle.clues[i];
      const px = L.list.x + Math.round(11 * S);
      if (s.pinned[i]) {
        ctx.fillStyle = 'rgba(255,200,87,0.07)';
        roundRect(ctx, L.list.x - 4, y - 3, L.list.w + 8, h - gap + 6, 5);
        ctx.fill();
        ctx.fillStyle = Palette.warm;
        ctx.fillRect(L.list.x - 4, y - 3, 2, h - gap + 6);
      }
      text(ctx, c.source, px, y, { size: Math.max(7.5, size * 0.72), color: Palette.dim, weight: 700, alpha: 0.75 });
      ctx.font = `500 ${size}px ${MONO}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      let ly = y + srcH;
      for (const line of lines) {
        let lx = px;
        for (const word of line) {
          for (const seg of word) {
            let col = Palette.ink, alpha = 1;
            if (seg.a) { col = ATTR_COLOR[seg.a]; }
            if (s.focus >= 0 && seg.a && s.grid[seg.a][s.focus] === seg.v) col = Palette.accent;
            ctx.globalAlpha = alpha;
            ctx.fillStyle = col;
            ctx.fillText(seg.t, lx, ly);
            lx += ctx.measureText(seg.t).width;
          }
          lx += s._wrapSpace;
        }
        ctx.globalAlpha = 1;
        ly += lineH;
      }
    }
    y += h;
  }
  ctx.restore();

  s._boxes = boxes;
  const total = y + s.scroll - L.list.y;
  s.scrollMax = Math.max(0, total - L.list.h);
  if (s.scroll > s.scrollMax) s.scroll = s.scrollMax;

  if (s.scrollMax > 1) {
    const tx = L.papers.x + L.papers.w - Math.round(5 * S);
    const th = Math.max(18, L.list.h * (L.list.h / total));
    const ty = L.list.y + (L.list.h - th) * (s.scroll / s.scrollMax);
    ctx.fillStyle = Palette.grid;
    roundRect(ctx, tx - 1, L.list.y, 3, L.list.h, 2); ctx.fill();
    ctx.fillStyle = Palette.dim;
    roundRect(ctx, tx - 1, ty, 3, th, 2); ctx.fill();
  }
  if (order.length === 0) {
    text(ctx, 'Nothing assigned at that berth yet.', L.papers.x + L.papers.w / 2, L.list.y + 20, {
      size: Math.max(8, 9.5 * S), color: Palette.dim, align: 'center',
    });
  }
}

function drawPicker(s, ctx, g, L) {
  const box = pickerBox(L, s);
  if (!box) return;
  const S = L.S, attr = s.picker.attr, berth = s.picker.berth;
  const col = ATTR_COLOR[attr];

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = Palette.panel;
  roundRect(ctx, box.x, box.y, box.w, box.h, 8); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
  roundRect(ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, 8); ctx.stroke();
  ctx.globalAlpha = 1;

  const fs = Math.max(8, Math.min(10.5 * S, box.w / 11));
  const markW = Math.max(14, 18 * S);
  for (let i = 0; i < BERTHS; i++) {
    const r = pickerRow(box, i);
    const owner = s.grid[attr].indexOf(i);
    const taken = owner >= 0 && owner !== berth;
    const proven = taken && !!s.locked[attr][owner];
    const isRuled = !!((s.ruled[attr][berth] >> i) & 1);
    const isMine = s.grid[attr][berth] === i;

    if (isMine) {
      ctx.fillStyle = 'rgba(94,242,192,0.14)';
      roundRect(ctx, r.x, r.y, r.w, r.h - 1, 4); ctx.fill();
    }
    const label = valueLabel(attr, i);
    const tcol = proven ? Palette.dim : isRuled ? Palette.dim : taken ? Palette.dim : col;
    text(ctx, label, r.x + 6, r.y + r.h / 2, {
      size: fs, color: tcol, baseline: 'middle', weight: isMine ? 700 : 500,
      alpha: isRuled ? 0.45 : 1,
    });
    if (isRuled) {
      const tw = fs * 0.62 * label.length;
      ctx.strokeStyle = Palette.hot; ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(r.x + 5, r.y + r.h / 2); ctx.lineTo(r.x + 7 + tw, r.y + r.h / 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (taken) {
      text(ctx, proven ? '✓' + (owner + 1) : String(owner + 1), r.x + r.w - markW - 4, r.y + r.h / 2, {
        size: Math.max(7.5, fs * 0.82), color: proven ? Palette.accent : Palette.dim, align: 'right', baseline: 'middle',
      });
    }
    // rule-out toggle
    ctx.strokeStyle = isRuled ? Palette.hot : Palette.grid;
    ctx.lineWidth = 1;
    const bx = r.x + r.w - markW + 3, by = r.y + r.h / 2 - markW * 0.28;
    roundRect(ctx, bx, by, markW * 0.56, markW * 0.56, 2); ctx.stroke();
    if (isRuled) {
      ctx.beginPath();
      ctx.moveTo(bx + 2, by + 2); ctx.lineTo(bx + markW * 0.56 - 2, by + markW * 0.56 - 2);
      ctx.moveTo(bx + markW * 0.56 - 2, by + 2); ctx.lineTo(bx + 2, by + markW * 0.56 - 2);
      ctx.stroke();
    }
  }
  const cr = pickerRow(box, BERTHS);
  text(ctx, '— CLEAR —', cr.x + cr.w / 2, cr.y + cr.h / 2, {
    size: Math.max(8, fs * 0.9), color: Palette.dim, align: 'center', baseline: 'middle',
  });
}

function drawFooter(s, ctx, g, L) {
  const S = L.S;
  ctx.fillStyle = Palette.bg2;
  ctx.fillRect(0, g.h - L.footH, g.w, L.footH);
  ctx.strokeStyle = Palette.grid;
  ctx.beginPath(); ctx.moveTo(0, g.h - L.footH + 0.5); ctx.lineTo(g.w, g.h - L.footH + 0.5); ctx.stroke();

  const ready = canConfirm(s) && s.phase === 'play';
  for (const b of L.buttons) {
    if (b.id === 'confirm') {
      const sc = 1 - s.fail * 0.05 + (ready ? Math.sin(g.t * 3) * 0.006 : 0);
      button(ctx, b, S, { hot: true, dim: !ready, scale: sc });
    } else if (b.id.startsWith('tier')) {
      button(ctx, b, S, { active: Number(b.id.slice(4)) === s.tierIndex });
    } else {
      button(ctx, b, S);
    }
  }
}

function drawIntro(s, ctx, g, L) {
  const S = clamp(Math.min(g.w / 780, g.h / 560), 0.5, 1.25);
  ctx.fillStyle = 'rgba(7,8,13,0.93)';
  ctx.fillRect(0, 0, g.w, g.h);
  const cx = g.w / 2;
  let y = g.h / 2 - 118 * S;
  text(ctx, T('THE NINE', '九人'), cx, y, { size: 34 * S, color: Palette.accent, align: 'center', weight: 700 });
  y += 34 * S;
  text(ctx, SHIP.line, cx, y, { size: 12 * S, color: Palette.dim, align: 'center' });
  y += 34 * S;
  text(ctx, T('Nine berths. Nine names. Nine ends.', '九个铺位。九个姓名。九种结局。'), cx, y, { size: 14 * S, color: Palette.ink, align: 'center', weight: 600 });
  y += 22 * S;
  text(ctx, T('The papers survive. The crew does not. Work out who slept where.', '文书留了下来,船员没有。查清谁睡在哪里。'), cx, y, { size: 12 * S, color: Palette.dim, align: 'center' });
  y += 34 * S;
  text(ctx, T('CONFIRM three or more correct at once and they lock in FOREVER.', '一次确认三项或以上正确,它们将永久锁定。'), cx, y, { size: 12.5 * S, color: Palette.warm, align: 'center', weight: 600 });
  y += 20 * S;
  text(ctx, T('Fewer than three, and nothing is revealed. Guessing gets you nowhere.', '少于三项则什么都不会揭示。瞎猜没有用。'), cx, y, { size: 12 * S, color: Palette.dim, align: 'center' });
  y += 34 * S;
  text(ctx, T('CLICK a cell to assign  ·  ENTER to confirm  ·  1 2 3 difficulty  ·  N new seed  ·  C campaign', '点击格子分配  ·  ENTER 确认  ·  1 2 3 难度  ·  N 换种子  ·  C 战役'), cx, y, { size: 11.5 * S, color: Palette.dim, align: 'center' });
  y += 18 * S;
  text(ctx, T('Click a berth number to filter the papers  ·  R clears  ·  ESC backs out', '点击铺位编号筛选文书  ·  R 清空  ·  ESC 退出'), cx, y, { size: 11.5 * S, color: Palette.dim, align: 'center', alpha: 0.75 });
  y += 36 * S;
  const p = 0.5 + 0.5 * Math.sin(g.t * 3);
  text(ctx, T('PRESS SPACE', '按空格键开始'), cx, y, { size: 14 * S, color: Palette.warm, align: 'center', weight: 700, alpha: 0.4 + p * 0.6 });
  y += 26 * S;
  text(ctx, T(`SEED ${s.seedStr} · ${TIERS[s.tierIndex].label} · ${TIERS[s.tierIndex].blurb}`,
    `种子 ${s.seedStr} · ${T(TIERS[s.tierIndex].label, TIERS[s.tierIndex].labelZh || TIERS[s.tierIndex].label)} · ${T(TIERS[s.tierIndex].blurb, TIERS[s.tierIndex].blurbZh || TIERS[s.tierIndex].blurb)}`), cx, y, {
    size: 10.5 * S, color: Palette.dim, align: 'center', alpha: 0.7,
  });
}

function drawSolved(s, ctx, g, L) {
  const S = clamp(Math.min(g.w / 780, g.h / 560), 0.5, 1.2);
  ctx.fillStyle = 'rgba(7,8,13,0.9)';
  ctx.fillRect(0, 0, g.w, g.h);
  const cx = g.w / 2;
  let y = g.h / 2 - 92 * S;
  text(ctx, 'THE NINE ARE NAMED', cx, y, { size: 26 * S, color: Palette.accent, align: 'center', weight: 700 });
  y += 32 * S;
  text(ctx, T(`${SHIP.name} · SEED ${s.seedStr} · ${TIERS[s.tierIndex].label}`,
    `${SHIP.name} · 种子 ${s.seedStr} · ${tierLabel(TIERS[s.tierIndex])}`), cx, y, { size: 11.5 * S, color: Palette.dim, align: 'center' });
  y += 32 * S;
  text(ctx, `${fmtTime(s.solvedAt)}   ·   ${s.confirms} CONFIRM${s.confirms === 1 ? '' : 'S'}`, cx, y, {
    size: 17 * S, color: Palette.ink, align: 'center', weight: 700,
  });
  y += 26 * S;
  const tier = TIERS[s.tierIndex].id;
  const bt = Store.get('bestTime:' + tier, null), bc = Store.get('bestConfirms:' + tier, null);
  text(ctx, `BEST ${bt === null ? '—' : fmtTime(bt)} · FEWEST ${bc === null ? '—' : bc} · SOLVED ${s.solvedTotal}`, cx, y, {
    size: 11.5 * S, color: Palette.dim, align: 'center',
  });
  if (s.newBestTime || s.newBestConf) {
    y += 22 * S;
    text(ctx, s.newBestTime && s.newBestConf ? 'NEW BEST TIME AND FEWEST CONFIRMS' : s.newBestTime ? 'NEW BEST TIME' : 'FEWEST CONFIRMS YET', cx, y, {
      size: 12 * S, color: Palette.warm, align: 'center', weight: 700,
    });
  }
  y += 40 * S;
  const p = 0.5 + 0.5 * Math.sin(g.t * 3);
  text(ctx, 'SPACE for another wreck  ·  1 2 3 to change difficulty', cx, y, {
    size: 12 * S, color: Palette.warm, align: 'center', weight: 600, alpha: 0.45 + p * 0.55,
  });
}

// ---------------------------------------------------------------- boot

const game = boot({ id: 'the-nine', title: 'The Nine', seed: 1, init, update, render });
mountLangToggle();

// Progressive enhancement: wheel scrolling for the clue list. Never traps browser zoom.
if (game.canvas && game.canvas.addEventListener) {
  game.canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const s = game.state;
    if (!s || s.phase === 'intro') return;
    s.scroll = clamp(s.scroll + e.deltaY, 0, s.scrollMax);
    e.preventDefault();
  }, { passive: false });
}

// ---------------------------------------------------------------- self-test

registerSelftest('the-nine', (check, log) => {
  const t0 = (globalThis.performance && performance.now()) || 0;

  // --- deterministic seeds, independent of Math.random()
  const seeds = [];
  {
    const r = new RNG(20260810);
    const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 30; i++) {
      let sd = '';
      for (let k = 0; k < 6; k++) sd += AB[r.int(32)];
      seeds.push(sd);
    }
  }

  // 1. determinism — same seed + tier => identical puzzle
  let detOK = true, detWhy = '';
  for (const tier of TIERS) {
    for (const sd of seeds.slice(0, 6)) {
      const a = JSON.stringify(generate(sd, tier.id));
      const b = JSON.stringify(generate(sd, tier.id));
      if (a !== b) { detOK = false; detWhy = `${tier.id}/${sd}`; break; }
    }
  }
  check('generation is deterministic (deep-equal over 18 regenerations)', detOK, detWhy);

  // 2. UNIQUENESS — the most important check in the game
  const puzzles = [];
  let uniqFail = [], truthFail = [], solFail = [], clueCounts = [];
  for (const tier of TIERS) {
    for (const sd of seeds) {
      const p = generate(sd, tier.id);
      puzzles.push(p);
      clueCounts.push(p.clues.length);
      if (countSolutions(p, 2) !== 1) uniqFail.push(`${tier.id}/${sd}`);
      // 4. the ground truth must satisfy every clue, and be the solution the solver finds
      const pos = positionsOf(p);
      for (const c of p.clues) if (!clueHolds(c, pos)) truthFail.push(`${tier.id}/${sd}#${c.id}`);
      const sol = solveFirst(p);
      if (!sol || p.attrs.some((a) => String(sol[a]) !== String(p.truth[a]))) solFail.push(`${tier.id}/${sd}`);
    }
  }
  check('every generated puzzle has exactly ONE solution', uniqFail.length === 0,
    `${puzzles.length} puzzles over ${seeds.length} seeds x ${TIERS.length} tiers · failures: ${uniqFail.slice(0, 4).join(',') || 'none'}`);
  check('the ground truth satisfies every generated clue', truthFail.length === 0, truthFail.slice(0, 4).join(','));
  check('the solver recovers exactly the ground truth', solFail.length === 0, solFail.slice(0, 4).join(','));
  check('every tier is covered and produces a readable clue list', clueCounts.every((n) => n >= 5 && n <= 32),
    `clues ${Math.min(...clueCounts)}..${Math.max(...clueCounts)}`);

  // 3. MINIMALITY — no clue is redundant
  let redundant = [], minChecked = 0;
  for (const tier of TIERS) {
    for (const sd of seeds.slice(0, 2)) {
      const p = generate(sd, tier.id);
      minChecked++;
      for (let i = 0; i < p.clues.length; i++) {
        const sub = { attrs: p.attrs, clues: p.clues.filter((_, k) => k !== i) };
        if (countSolutions(sub, 2) === 1) redundant.push(`${tier.id}/${sd}#${i}`);
      }
    }
  }
  check('removing ANY single clue destroys uniqueness (minimal puzzles)', redundant.length === 0,
    `${minChecked} puzzles fully re-checked · redundant: ${redundant.slice(0, 4).join(',') || 'none'}`);

  // --- live game from here on
  // This section deliberately wins a real puzzle through the real confirm path (check
  // 7 below), and doConfirm() on a real win writes 'solved', 'bestTime:<tier>' and
  // 'bestConfirms:<tier>' to Store — so without isolating it, running this self-test
  // once would overwrite whatever the player had actually earned. Tier 1 is the only
  // tier this section touches.
  const savedSolved = Store.get('solved', 0);
  const savedBestTime1 = Store.get('bestTime:1', null);
  const savedBestConfirms1 = Store.get('bestConfirms:1', null);
  game.puzzleSeed = 'TESTAA';
  game.restart();
  newPuzzle(game.state, 'TESTAA', 1);
  game.state.phase = 'play';
  const s = game.state;
  check('live puzzle loads (officer: 3 attributes x 9 berths)', s.attrs.length === 3 && s.cells === 27,
    `attrs=${s.attrs.join(',')} cells=${s.cells}`);

  // 5. injected click assigns an identity, through the real pointer path
  const L0 = layout(game, s);
  const cell = L0.cell(0, 0);
  const before = s.grid[s.attrs[0]][0];
  game.input.pointDown(cell.x + cell.w / 2, cell.y + cell.h / 2);
  game.step(1);
  game.input.pointUp();
  game.step(1);
  const pickerOpened = !!s.picker;
  const box = pickerBox(layout(game, s), s);
  const want = (s.puzzle.truth[s.attrs[0]][0] + 3) % 9;      // deliberately NOT the answer
  const row = pickerRow(box, want);
  game.input.pointDown(row.x + row.w * 0.3, row.y + row.h / 2);
  game.step(1);
  game.input.pointUp();
  game.step(1);
  check('a click opens the picker and a second click assigns an identity',
    pickerOpened && s.grid[s.attrs[0]][0] === want && before === -1,
    `before=${before} after=${s.grid[s.attrs[0]][0]} picker=${pickerOpened}`);

  // 8. LOSE / no-progress path: three WRONG assignments reveal and lock nothing.
  //    Values are a 3-cycle of the true ones, so all three are distinct (no bijection
  //    auto-clear) and every one of them sits at the wrong berth.
  clearBoard(s);
  const a0 = s.attrs[0];
  const T0 = s.puzzle.truth[a0];
  assign(s, a0, 0, T0[1]); assign(s, a0, 1, T0[2]); assign(s, a0, 2, T0[0]);
  const wrongOK = [0, 1, 2].every((b) => s.grid[a0][b] >= 0 && s.grid[a0][b] !== T0[b]);
  const confBefore = s.confirms;
  const hitsWrong = doConfirm(s, game);
  check('confirming three WRONG assignments locks nothing and reveals nothing',
    wrongOK && hitsWrong === 0 && s.lockedCount === 0 && s.phase === 'play' && s.confirms === confBefore + 1,
    `wrongOK=${wrongOK} hits=${hitsWrong} locked=${s.lockedCount} phase=${s.phase} confirms+${s.confirms - confBefore}`);

  // 6a. fewer than three CORRECT locks nothing either
  clearBoard(s);
  assign(s, a0, 0, T0[0]);
  assign(s, a0, 1, T0[1]);
  assign(s, a0, 2, T0[3]);   // wrong, and distinct from the two correct ones
  const hits2 = doConfirm(s, game);
  check('two correct + one wrong still locks nothing',
    hits2 === 0 && s.lockedCount === 0 && s.grid[a0][0] === T0[0] && s.grid[a0][2] !== T0[2],
    `hits=${hits2} locked=${s.lockedCount}`);

  // 6b. three CORRECT locks exactly those three, permanently
  clearBoard(s);
  for (let b = 0; b < 3; b++) assign(s, a0, b, T0[b]);
  const hits3 = doConfirm(s, game);
  const lockedThree = [0, 1, 2].every((b) => s.locked[a0][b] === 1);
  game.step(120);   // run the lock-in animation to completion
  const stuck = assign(s, a0, 0, T0[4]);
  check('confirming three CORRECT assignments locks exactly those three, permanently',
    hits3 === 3 && lockedThree && s.lockedCount === 3 && stuck === false && s.grid[a0][0] === T0[0],
    `hits=${hits3} locked=${s.lockedCount} reassign-refused=${stuck === false} phase=${s.phase}`);

  // 7. WIN is reachable through the real confirm path
  for (const a of s.attrs) for (let b = 0; b < BERTHS; b++) assign(s, a, b, s.puzzle.truth[a][b]);
  const hitsWin = doConfirm(s, game);
  game.step(200);
  check('the win condition is reachable via the real confirm path',
    s.phase === 'solved' && s.lockedCount === s.cells && hitsWin === s.cells - 3,
    `phase=${s.phase} locked=${s.lockedCount}/${s.cells} lastBatch=${hitsWin}`);
  Store.set('solved', savedSolved);
  Store.set('bestTime:1', savedBestTime1);
  Store.set('bestConfirms:1', savedBestConfirms1);

  // --- CAMPAIGN: 50-case structure, uniqueness, escalation and unlock persistence.
  // Isolated the same way as the win-condition test above: real Store keys are saved
  // and restored around it so running the self-test never overwrites real progress.
  const savedUnlocked = Store.get(CAMPAIGN_UNLOCKED_KEY, 1);
  const savedCampSolved = Store.get(CAMPAIGN_SOLVED_KEY, {});

  check('CASES has exactly 50 entries, numbered 1..50 in order', CASES.length === 50 && CASES.every((c, i) => c.n === i + 1),
    `len=${CASES.length}`);

  let capUniqFail = [], capTruthFail = [];
  const capPuzzles = CASES.map((c) => generateCaseN(c.n));
  for (let i = 0; i < capPuzzles.length; i++) {
    const p = capPuzzles[i];
    if (countSolutions(p, 2) !== 1) capUniqFail.push(CASES[i].n);
    const pos = positionsOf(p);
    for (const cl of p.clues) if (!clueHolds(cl, pos)) capTruthFail.push(CASES[i].n);
  }
  check('every Campaign case (1-50) has exactly ONE solution', capUniqFail.length === 0,
    `failures: ${capUniqFail.slice(0, 6).join(',') || 'none'}`);
  check('the ground truth satisfies every clue in every Campaign case', capTruthFail.length === 0,
    capTruthFail.slice(0, 6).join(','));

  const capTierIdx = capPuzzles.map((p) => p.tierIndex);
  const escalates = capTierIdx.slice(0, 15).every((t) => t === 0)
    && capTierIdx.slice(15, 35).every((t) => t === 1)
    && capTierIdx.slice(35, 50).every((t) => t === 2);
  check('Campaign tier escalates cadet(1-15) -> officer(16-35) -> archivist(36-50)', escalates,
    `tiers=${capTierIdx.join('')}`);

  const cadetClues = capPuzzles.slice(0, 15).map((p) => p.clues.length);
  const officerClues = capPuzzles.slice(15, 35).map((p) => p.clues.length);
  const archivistClues = capPuzzles.slice(35, 50).map((p) => p.clues.length);
  const roughlyDescends = (arr) => arr[0] >= arr[arr.length - 1];
  check('within each tier band, clue count generally tapers from case 1 toward the last (looser -> tighter to the uniqueness boundary)',
    roughlyDescends(cadetClues) && roughlyDescends(officerClues) && roughlyDescends(archivistClues),
    `cadet ${cadetClues.join(',')} | officer ${officerClues.join(',')} | archivist ${archivistClues.join(',')}`);

  // minimality sample across the Campaign (>=10 cases): removing any single clue breaks uniqueness
  const capSampleIdx = [0, 5, 10, 14, 15, 20, 25, 34, 35, 40, 45, 49];
  let capMinFail = [];
  for (const i of capSampleIdx) {
    const p = capPuzzles[i];
    for (let k = 0; k < p.clues.length; k++) {
      const sub = { attrs: p.attrs, clues: p.clues.filter((_, j) => j !== k) };
      if (countSolutions(sub, 2) === 1) capMinFail.push(`case${CASES[i].n}#${k}`);
    }
  }
  check(`Campaign minimality holds on a ${capSampleIdx.length}-case sample (no redundant clue)`, capMinFail.length === 0,
    capMinFail.slice(0, 6).join(','));

  // case init: loading case 1 through the real game gives the expected puzzle
  Store.set(CAMPAIGN_UNLOCKED_KEY, 1);
  Store.set(CAMPAIGN_SOLVED_KEY, {});
  game.puzzleSeed = null;
  game.restart();
  newPuzzleCase(game.state, 1);
  const sc = game.state;
  check('Campaign case init loads case 1 through newPuzzleCase',
    sc.mode === 'campaign' && sc.caseN === 1 && sc.puzzle.seed === CASES[0].seed && sc.puzzle.tierIndex === CASES[0].tierIndex,
    `mode=${sc.mode} caseN=${sc.caseN} seed=${sc.puzzle.seed}`);
  check('case 2 is locked until case 1 is solved (loading it clamps back to the unlocked ceiling)',
    (() => { newPuzzleCase(sc, 2); return sc.caseN === 1; })(), `caseN=${sc.caseN}`);

  // solve-path + unlock persistence, via the real assign/doConfirm path, for every one of the 50 cases
  let capSolveFail = [];
  for (const c of CASES) {
    Store.set(CAMPAIGN_UNLOCKED_KEY, c.n);
    newPuzzleCase(sc, c.n);
    sc.phase = 'play';
    for (const a of sc.attrs) for (let b = 0; b < BERTHS; b++) assign(sc, a, b, sc.puzzle.truth[a][b]);
    doConfirm(sc, game);
    game.step(200);
    const wantUnlock = Math.min(c.n + 1, CASES.length);
    const unlockedOK = c.n === CASES.length ? true : Store.get(CAMPAIGN_UNLOCKED_KEY, 1) >= wantUnlock;
    if (!(sc.phase === 'solved' && sc.lockedCount === sc.cells && unlockedOK)) {
      capSolveFail.push(`case${c.n}:phase=${sc.phase},locked=${sc.lockedCount}/${sc.cells},unlock=${Store.get(CAMPAIGN_UNLOCKED_KEY, 1)}`);
    }
  }
  check('every one of the 50 Campaign cases is solvable via the real confirm path, and solving one unlocks the next',
    capSolveFail.length === 0, capSolveFail.slice(0, 3).join(' | ') || 'all 50 ok');

  Store.set(CAMPAIGN_UNLOCKED_KEY, savedUnlocked);
  Store.set(CAMPAIGN_SOLVED_KEY, savedCampSolved);

  // 9. long chaotic run: no throw, nothing goes non-finite
  game.puzzleSeed = 'TESTBB';
  game.restart();
  newPuzzle(game.state, 'TESTBB', 2);
  game.state.phase = 'play';
  const s2 = game.state;
  const rng = new RNG(4242);
  let frames = 0;
  for (let i = 0; i < 660; i++) {
    if (i % 6 === 0) {
      const L = layout(game, s2);
      const x = rng.range(0, game.w), y = rng.range(0, game.h);
      game.input.pointDown(x, y);
      game.step(1); frames++;
      game.input.pointUp(x, y);
    }
    if (i % 97 === 0) game.input.tap('enter');
    if (i % 53 === 0) game.input.tap('escape');
    game.step(1); frames++;
  }
  const fin = allFinite(s2);
  check('no NaN/Infinity anywhere in state after ' + frames + ' simulated frames', fin.ok, fin.bad.slice(0, 4).join(','));
  check('scroll and counters stay in range after the chaos run',
    s2.scroll >= 0 && s2.scroll <= s2.scrollMax + 1 && s2.lockedCount >= 0 && s2.lockedCount <= s2.cells && s2.confirms >= 0,
    `scroll=${s2.scroll.toFixed(1)}/${s2.scrollMax.toFixed(1)} locked=${s2.lockedCount} confirms=${s2.confirms}`);

  // layout must survive absurd canvas sizes without producing garbage geometry
  const SIZES = [[320, 240], [480, 900], [700, 420], [960, 600], [1920, 1080], [2400, 700]];
  let geomOK = true, geomWhy = '';
  for (const [w, h] of SIZES) {
    const L = layout({ w, h }, s2);
    const c = L.cell(s2.attrs.length - 1, 8);
    const ok = allFinite(L.roster).ok && allFinite(L.papers).ok && c.w > 4 && c.h > 4 &&
      c.x + c.w <= L.roster.x + L.roster.w + 1 && L.list.h > 10 &&
      L.buttons.every((b) => b.x >= 0 && b.x + b.w <= w + 1 && b.y + b.h <= h + 1);
    if (!ok) { geomOK = false; geomWhy = `${w}x${h} cell=${JSON.stringify(c)}`; break; }
  }
  check('layout stays sane from 320x240 to 2400x700', geomOK, geomWhy);

  // the render path itself must not throw at any size, and must measure the clue list
  const w0 = game.w, h0 = game.h;
  let drewOK = true, drewWhy = '', sawBoxes = false;
  for (const [w, h] of SIZES) {
    game.w = w; game.h = h;
    for (const view of [0, 1]) {
      s2.view = view;
      s2.picker = { attr: s2.attrs[0], berth: 4 };
      s2.focus = view ? 2 : -1;
      try { game.draw(); } catch (e) { drewOK = false; drewWhy = `${w}x${h} view${view}: ${e && e.message}`; }
      if (s2._boxes && s2._boxes.length) sawBoxes = true;
    }
  }
  game.w = w0; game.h = h0;
  s2.picker = null; s2.focus = -1; s2.view = 0;
  try { s2.phase = 'intro'; game.draw(); s2.phase = 'solved'; game.draw(); s2.phase = 'play'; } catch (e) { drewOK = false; drewWhy = 'overlay: ' + (e && e.message); }
  check('render (roster, papers, picker, intro and solved overlays) never throws',
    drewOK && sawBoxes, drewWhy || `boxes=${sawBoxes}`);
  check('clue list measures out to a scrollable extent', s2.scrollMax >= 0 && Number.isFinite(s2.scrollMax), `scrollMax=${s2.scrollMax}`);

  game.puzzleSeed = null;
  game.restart();
  const ms = ((globalThis.performance && performance.now()) || 0) - t0;
  log(`puzzles generated+verified=${puzzles.length} clues=${Math.min(...clueCounts)}..${Math.max(...clueCounts)} in ${Math.round(ms)}ms`);
});

// dev console handles
globalThis.__theNine = { generate, countSolutions, solveFirst, layout, doConfirm, assign, newPuzzle, newPuzzleCase, TIERS, CASES, generateCaseN };

export default game;
