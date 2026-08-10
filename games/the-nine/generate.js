// The Nine — puzzle generator + constraint solver.
//
// PURE and DOM-free. No Math.random(), no Date.now(), no globals touched.
//   generate(seedString, difficulty) -> puzzle      (same inputs => byte-identical puzzle)
//   countSolutions(puzzle, limit)    -> number      (capped at `limit`)
//   solveFirst(puzzle)               -> solution | null
//
// The model
// ---------
// Nine berths in a corridor, indexed 0..8 (displayed 1..9, bow to stern). Each active
// attribute (name / role / fate) is a BIJECTION berth <-> value, so every attribute is a
// permutation of 0..8. A clue constrains the *positions* of one, two, or three
// (attribute, value) terms.
//
// Domains are 9-bit masks: dom[attr*9 + value] = set of berths that (attr,value) may occupy.
// propagate() runs each clue's exact bitmask pruner plus all-different propagation to a
// fixpoint; searchCount() branches on the smallest live domain. Everything is integers, so
// a full uniqueness proof costs microseconds — which is what makes generate-then-verify
// (add clues until unique, then strip every clue that isn't load-bearing) affordable.

import { RNG } from '../../shared/kit.js';

export const BERTHS = 9;
const FULL = 0x1ff;

// ---------------------------------------------------------------- fiction

export const SHIP = {
  name: 'FERRAND WAKE',
  line: 'Survey barque. Nine signed on at Pell Harbour. None came back.',
};

export const NAMES = ['Anselby', 'Corrow', 'Dunmar', 'Fenlisk', 'Garrow', 'Halvex', 'Ibbet', 'Jorrun', 'Kestren'];
export const ROLES = ['Master', 'Mate', 'Surgeon', 'Cook', 'Rigger', 'Joiner', 'Sounder', 'Purser', 'Stoker'];
export const FATES = ['Overside', 'Fever', 'The Ice', 'The Hold', 'The Fall', 'The Boat', 'The Rope', 'The Hull', 'Unfound'];

const FATE_REF = [
  'the one lost overside',
  'the one taken by fever',
  'the one who walked out onto the ice',
  'the one sealed in the hold',
  'the one who fell from the rigging',
  'the one put off in the boat',
  'the one who went to the rope',
  'the one found in the hull',
  'the one never found',
];

export const ATTRS = {
  name: { key: 'name', label: 'NAME', values: NAMES },
  role: { key: 'role', label: 'ROLE', values: ROLES },
  fate: { key: 'fate', label: 'FATE', values: FATES },
};

/** Short all-caps token for the roster grid. */
export function valueLabel(attr, v) {
  return ATTRS[attr].values[v].toUpperCase();
}

/** Noun phrase used inside clue prose. */
function refText(attr, v) {
  if (attr === 'name') return NAMES[v];
  if (attr === 'role') return 'the ' + ROLES[v];
  return FATE_REF[v];
}

const SOURCES = [
  'SHIP LEDGER', 'BUNK ROSTER', 'A LETTER HOME', 'SALVAGE NOTE', 'THE INQUEST',
  'TORN PAGE', 'DEPOSITION', 'CARGO MANIFEST', 'MARGIN NOTE', 'HARBOUR RECORD',
];

// ---------------------------------------------------------------- tiers

export const TIERS = [
  {
    id: 'cadet',
    label: 'CADET',
    labelZh: '见习',
    blurb: 'Two ledgers — names and roles. The papers speak plainly.',
    blurbZh: '两本记录——姓名与职务。文书说得很直白。',
    attrs: ['name', 'role'],
    pool: 240, start: 8, stepAdd: 3,
    weights: [['AT', 26], ['SAME', 22], ['ADJ', 14], ['BEFORE', 12], ['DIST', 8], ['NOTSAME', 8], ['BETWEEN', 4], ['NADJ', 3], ['DISTMIN', 3]],
    atKinds: [['pin', 26], ['half', 22], ['parity', 20], ['end', 14], ['amid', 8], ['inner', 10]],
    removeOrder: 'weakFirst',
    min: 5, max: 17,
  },
  {
    id: 'officer',
    label: 'OFFICER',
    labelZh: '军官',
    blurb: 'Three ledgers — names, roles, and how each one ended.',
    blurbZh: '三本记录——姓名、职务,以及各自的结局。',
    attrs: ['name', 'role', 'fate'],
    pool: 340, start: 14, stepAdd: 2,
    weights: [['AT', 16], ['SAME', 16], ['ADJ', 13], ['BEFORE', 13], ['DIST', 10], ['NOTSAME', 12], ['BETWEEN', 8], ['NADJ', 6], ['DISTMIN', 6]],
    atKinds: [['pin', 12], ['half', 24], ['parity', 24], ['end', 18], ['amid', 6], ['inner', 16]],
    removeOrder: 'shuffle',
    min: 11, max: 26,
  },
  {
    id: 'archivist',
    label: 'ARCHIVIST',
    labelZh: '档案员',
    blurb: 'Three ledgers, and nothing stated outright.',
    blurbZh: '三本记录,却无一直言。',
    attrs: ['name', 'role', 'fate'],
    pool: 360, start: 16, stepAdd: 2,
    weights: [['AT', 14], ['SAME', 13], ['ADJ', 14], ['BEFORE', 15], ['DIST', 12], ['NOTSAME', 12], ['BETWEEN', 9], ['NADJ', 6], ['DISTMIN', 5]],
    atKinds: [['half', 28], ['parity', 28], ['end', 22], ['inner', 22]],
    removeOrder: 'strongFirst',
    min: 12, max: 29,
  },
];

export function resolveTier(difficulty) {
  if (typeof difficulty === 'number') return TIERS[Math.max(0, Math.min(TIERS.length - 1, difficulty | 0))];
  const found = TIERS.find((t) => t.id === String(difficulty).toLowerCase());
  return found || TIERS[1];
}

// ---------------------------------------------------------------- bit helpers

const NBR = new Int32Array(9);
const BELOW = new Int32Array(10);   // BELOW[i] = every berth strictly below i
const ABOVE = new Int32Array(10);   // ABOVE[i] = every berth strictly above i
for (let p = 0; p < 9; p++) NBR[p] = ((p > 0 ? 1 << (p - 1) : 0) | (p < 8 ? 1 << (p + 1) : 0));
for (let i = 0; i <= 9; i++) {
  BELOW[i] = ((1 << i) - 1) & FULL;
  ABOVE[i] = FULL & ~(((1 << (i + 1)) - 1));
}

const MASK_ODD = 0b101010101;   // displayed berths 1,3,5,7,9
const MASK_EVEN = 0b010101010;  // displayed berths 2,4,6,8
const MASK_FWD = 0b000001111;   // berths 1-4
const MASK_AFT = 0b111100000;   // berths 6-9
const MASK_AMID = 1 << 4;       // berth 5
const MASK_ENDS = (1 << 0) | (1 << 8);
const MASK_INNER = FULL & ~MASK_ENDS;

function popcnt(m) {
  m = m - ((m >> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >> 2) & 0x33333333);
  m = (m + (m >> 4)) & 0x0f0f0f0f;
  return (Math.imul(m, 0x01010101) >> 24) & 0x3f;
}
function lowIdx(m) { return 31 - Math.clz32(m & -m); }
function highIdx(m) { return 31 - Math.clz32(m); }
function spread(m) { return ((m << 1) | (m >>> 1)) & FULL; }
function rangeMask(a, b) {
  if (a < 0) a = 0;
  if (b > 8) b = 8;
  if (a > b) return 0;
  return BELOW[b + 1] & ~BELOW[a];
}
/** Every berth that is at least k away from SOME berth in db. */
function minDistMask(db, k) {
  const lo = lowIdx(db), hi = highIdx(db);
  let m = 0;
  for (let p = 0; p < 9; p++) if (p - lo >= k || lo - p >= k || p - hi >= k || hi - p >= k) m |= 1 << p;
  return m;
}

// ---------------------------------------------------------------- clue kinds

const T_AT = 0, T_SAME = 1, T_NOTSAME = 2, T_ADJ = 3, T_NADJ = 4,
  T_BEFORE = 5, T_DIST = 6, T_DISTMIN = 7, T_BETWEEN = 8;

const TYPE_ID = { AT: T_AT, SAME: T_SAME, NOTSAME: T_NOTSAME, ADJ: T_ADJ, NADJ: T_NADJ, BEFORE: T_BEFORE, DIST: T_DIST, DISTMIN: T_DISTMIN, BETWEEN: T_BETWEEN };

const TYPE_COST = { SAME: 20, ADJ: 18, DIST: 16, BEFORE: 14, BETWEEN: 14, DISTMIN: 12, NADJ: 10, NOTSAME: 8 };
const AT_COST = { pin: 100, amid: 80, end: 40, half: 30, parity: 30, inner: 24 };

function atKindValid(kind, b) {
  if (kind === 'half') return b !== 4;
  if (kind === 'amid') return b === 4;
  if (kind === 'end') return b === 0 || b === 8;
  if (kind === 'inner') return b !== 0 && b !== 8;
  return true; // pin, parity
}
function atKindMask(kind, b) {
  switch (kind) {
    case 'pin': return 1 << b;
    case 'parity': return (b % 2 === 0) ? MASK_ODD : MASK_EVEN;
    case 'half': return b <= 3 ? MASK_FWD : MASK_AFT;
    case 'amid': return MASK_AMID;
    case 'end': return MASK_ENDS;
    case 'inner': return MASK_INNER;
    default: return FULL;
  }
}

// ---------------------------------------------------------------- solver

// Cheapest / strongest pruners first, so a contradiction is usually found before the
// weak negative constraints are even touched.
const TYPE_STRENGTH = [0, 1, 8, 2, 7, 5, 3, 6, 4];

/** Turn public clue objects into flat integer records keyed to this puzzle's attribute order. */
export function compile(clues, attrs) {
  const ai = {};
  for (let i = 0; i < attrs.length; i++) ai[attrs[i]] = i;
  const out = [];
  for (const c of clues) {
    const t = c.terms;
    const idx = (n) => ai[t[n].a] * 9 + t[n].v;
    out.push({
      type: TYPE_ID[c.type],
      ia: idx(0),
      ib: t.length > 1 ? idx(1) : -1,
      ic: t.length > 2 ? idx(2) : -1,
      mask: c.mask === undefined ? FULL : c.mask,
      k: c.k === undefined ? 0 : c.k,
    });
  }
  out.sort((a, b) => TYPE_STRENGTH[a.type] - TYPE_STRENGTH[b.type]);
  return out;
}

/** Returns -1 on contradiction, 1 if a domain shrank, 0 otherwise. */
function applyClue(dom, c) {
  let ch = 0;
  const A = c.ia, B = c.ib;
  switch (c.type) {
    case T_AT: {
      const nv = dom[A] & c.mask;
      if (nv === 0) return -1;
      if (nv !== dom[A]) { dom[A] = nv; ch = 1; }
      break;
    }
    case T_SAME: {
      const m = dom[A] & dom[B];
      if (m === 0) return -1;
      if (m !== dom[A]) { dom[A] = m; ch = 1; }
      if (m !== dom[B]) { dom[B] = m; ch = 1; }
      break;
    }
    case T_NOTSAME: {
      if (popcnt(dom[B]) === 1) {
        const nv = dom[A] & ~dom[B];
        if (nv === 0) return -1;
        if (nv !== dom[A]) { dom[A] = nv; ch = 1; }
      }
      if (popcnt(dom[A]) === 1) {
        const nv = dom[B] & ~dom[A];
        if (nv === 0) return -1;
        if (nv !== dom[B]) { dom[B] = nv; ch = 1; }
      }
      break;
    }
    case T_ADJ: {
      const na = dom[A] & spread(dom[B]);
      if (na === 0) return -1;
      if (na !== dom[A]) { dom[A] = na; ch = 1; }
      const nb = dom[B] & spread(dom[A]);
      if (nb === 0) return -1;
      if (nb !== dom[B]) { dom[B] = nb; ch = 1; }
      break;
    }
    case T_NADJ: {
      // p survives only if some q in the other domain is NOT adjacent to p.
      let na = 0, m = dom[A];
      for (let p = 0; p < 9; p++) if ((m >> p) & 1) { if (dom[B] & ~NBR[p] & FULL) na |= 1 << p; }
      if (na === 0) return -1;
      if (na !== dom[A]) { dom[A] = na; ch = 1; }
      let nb = 0; m = dom[B];
      for (let p = 0; p < 9; p++) if ((m >> p) & 1) { if (dom[A] & ~NBR[p] & FULL) nb |= 1 << p; }
      if (nb === 0) return -1;
      if (nb !== dom[B]) { dom[B] = nb; ch = 1; }
      break;
    }
    case T_BEFORE: {
      const na = dom[A] & BELOW[highIdx(dom[B])];
      if (na === 0) return -1;
      if (na !== dom[A]) { dom[A] = na; ch = 1; }
      const nb = dom[B] & ABOVE[lowIdx(dom[A])];
      if (nb === 0) return -1;
      if (nb !== dom[B]) { dom[B] = nb; ch = 1; }
      break;
    }
    case T_DIST: {
      const k = c.k;
      const na = dom[A] & (((dom[B] << k) | (dom[B] >>> k)) & FULL);
      if (na === 0) return -1;
      if (na !== dom[A]) { dom[A] = na; ch = 1; }
      const nb = dom[B] & (((dom[A] << k) | (dom[A] >>> k)) & FULL);
      if (nb === 0) return -1;
      if (nb !== dom[B]) { dom[B] = nb; ch = 1; }
      break;
    }
    case T_DISTMIN: {
      const na = dom[A] & minDistMask(dom[B], c.k);
      if (na === 0) return -1;
      if (na !== dom[A]) { dom[A] = na; ch = 1; }
      const nb = dom[B] & minDistMask(dom[A], c.k);
      if (nb === 0) return -1;
      if (nb !== dom[B]) { dom[B] = nb; ch = 1; }
      break;
    }
    case T_BETWEEN: {
      // A is strictly between B and C (in either order).
      const C = c.ic;
      let lb = lowIdx(dom[B]), hb = highIdx(dom[B]);
      let lc = lowIdx(dom[C]), hc = highIdx(dom[C]);
      let nm = 0;
      for (let p = 0; p < 9; p++) {
        if (!((dom[A] >> p) & 1)) continue;
        if ((lb < p && hc > p) || (lc < p && hb > p)) nm |= 1 << p;
      }
      if (nm === 0) return -1;
      if (nm !== dom[A]) { dom[A] = nm; ch = 1; }

      let nb = 0;
      for (let p = 0; p < 9; p++) {
        if (!((dom[B] >> p) & 1)) continue;
        if ((dom[A] & rangeMask(p + 1, hc - 1)) || (dom[A] & rangeMask(lc + 1, p - 1))) nb |= 1 << p;
      }
      if (nb === 0) return -1;
      if (nb !== dom[B]) { dom[B] = nb; ch = 1; }

      lb = lowIdx(dom[B]); hb = highIdx(dom[B]);
      let nc = 0;
      for (let p = 0; p < 9; p++) {
        if (!((dom[C] >> p) & 1)) continue;
        if ((dom[A] & rangeMask(p + 1, hb - 1)) || (dom[A] & rangeMask(lb + 1, p - 1))) nc |= 1 << p;
      }
      if (nc === 0) return -1;
      if (nc !== dom[C]) { dom[C] = nc; ch = 1; }
      break;
    }
    default: break;
  }
  return ch;
}

/**
 * Clue pruning + all-different, to a fixpoint. false => contradiction.
 * All-different runs on both axes: a value pinned to a berth clears that berth from every
 * other value, and a berth with a single candidate value pins it. (Naked-set propagation
 * up to size 4 was tried here and measured *slower* — the search is propagation-bound,
 * not node-bound, so the extra per-node work cost more than the branches it saved.)
 */
function propagate(dom, cls, A) {
  for (let round = 0; round < 40; round++) {
    let ch = 0;
    for (let i = 0; i < cls.length; i++) {
      const r = applyClue(dom, cls[i]);
      if (r < 0) return false;
      ch |= r;
    }
    for (let a = 0; a < A; a++) {
      const base = a * 9;
      for (let v = 0; v < 9; v++) {
        const d = dom[base + v];
        if (d === 0) return false;
        if ((d & (d - 1)) === 0) {
          for (let u = 0; u < 9; u++) {
            if (u !== v && (dom[base + u] & d)) {
              dom[base + u] &= ~d;
              if (dom[base + u] === 0) return false;
              ch = 1;
            }
          }
        }
      }
      for (let p = 0; p < 9; p++) {
        const bit = 1 << p;
        let cnt = 0, only = -1;
        for (let v = 0; v < 9; v++) if (dom[base + v] & bit) { cnt++; only = v; }
        if (cnt === 0) return false;
        if (cnt === 1 && dom[base + only] !== bit) { dom[base + only] = bit; ch = 1; }
      }
    }
    if (!ch) return true;
  }
  return true;
}

function readSolution(dom, A) {
  const out = [];
  for (let a = 0; a < A; a++) {
    const row = new Array(9).fill(-1);
    for (let v = 0; v < 9; v++) row[lowIdx(dom[a * 9 + v])] = v;
    out.push(row);
  }
  return out;
}

// Reused frame stack — branching allocated a fresh Int32Array per node, and that GC churn
// was a measurable slice of generation time.
let STACK = null, STACK_A = 0;
function ensureStack(A) {
  if (STACK_A === A) return;
  STACK_A = A;
  STACK = [];
  for (let i = 0; i < A * 9 + 2; i++) STACK.push(new Int32Array(A * 9));
}

function searchCount(dom, cls, A, limit, res, depth) {
  res.nodes++;
  if (!propagate(dom, cls, A)) return;
  let bi = -1, best = 10;
  for (let i = 0, n = A * 9; i < n; i++) {
    const c = popcnt(dom[i]);
    if (c > 1 && c < best) { best = c; bi = i; if (c === 2) break; }
  }
  if (bi < 0) {
    res.count++;
    if (!res.first) res.first = readSolution(dom, A);
    return;
  }
  const d2 = STACK[depth];
  let m = dom[bi];
  while (m) {
    const b = m & -m;
    m ^= b;
    d2.set(dom);
    d2[bi] = b;
    searchCount(d2, cls, A, limit, res, depth + 1);
    if (res.count >= limit) return;
  }
}

function runSolver(cls, A, limit) {
  ensureStack(A);
  const dom = new Int32Array(A * 9).fill(FULL);
  const res = { count: 0, first: null, nodes: 0 };
  searchCount(dom, cls, A, limit, res, 0);
  return res;
}

/** Public: how many complete assignments satisfy the puzzle's clues (capped at `limit`). */
export function countSolutions(puzzle, limit = 2) {
  return runSolver(compile(puzzle.clues, puzzle.attrs), puzzle.attrs.length, Math.max(1, limit)).count;
}

/** Public: the first solution found, as { name:[berth->value], role:[...], ... } or null. */
export function solveFirst(puzzle) {
  const res = runSolver(compile(puzzle.clues, puzzle.attrs), puzzle.attrs.length, 1);
  if (!res.first) return null;
  const out = {};
  puzzle.attrs.forEach((k, i) => { out[k] = res.first[i]; });
  return out;
}

// ---------------------------------------------------------------- clue truth + prose

/** posOf[attr][value] = berth. */
export function positionsOf(puzzle) {
  const out = {};
  for (const a of puzzle.attrs) {
    const pos = new Array(9).fill(-1);
    for (let b = 0; b < 9; b++) pos[puzzle.truth[a][b]] = b;
    out[a] = pos;
  }
  return out;
}

/** Does this clue hold under the given positions? Used to prove clues never lie. */
export function clueHolds(clue, posOf) {
  const p = clue.terms.map((t) => posOf[t.a][t.v]);
  switch (clue.type) {
    case 'AT': return !!(clue.mask & (1 << p[0]));
    case 'SAME': return p[0] === p[1];
    case 'NOTSAME': return p[0] !== p[1];
    case 'ADJ': return Math.abs(p[0] - p[1]) === 1;
    case 'NADJ': return Math.abs(p[0] - p[1]) !== 1;
    case 'BEFORE': return p[0] < p[1];
    case 'DIST': return Math.abs(p[0] - p[1]) === clue.k;
    case 'DISTMIN': return Math.abs(p[0] - p[1]) >= clue.k;
    case 'BETWEEN': return (p[1] < p[0] && p[0] < p[2]) || (p[2] < p[0] && p[0] < p[1]);
    default: return false;
  }
}

export function clueMentions(clue, attr, val) {
  for (const t of clue.terms) if (t.a === attr && t.v === val) return true;
  return false;
}

// -- prose ---------------------------------------------------------

function S(t) { return { t, a: null, v: -1 }; }
function T(attr, v, override) { return { t: override === undefined ? refText(attr, v) : override, a: attr, v }; }

function capTokens(tokens) {
  for (const tk of tokens) {
    if (tk.t && /[A-Za-z]/.test(tk.t[0])) { tk.t = tk.t[0].toUpperCase() + tk.t.slice(1); return tokens; }
  }
  return tokens;
}

const AT_PROSE = {
  pin: (t, b) => [t, S(' is set down at berth ' + (b + 1) + '.')],
  parity: (t, b) => [t, S(b % 2 === 0 ? ' kept an odd-numbered berth.' : ' kept an even-numbered berth.')],
  half: (t, b) => [t, S(b <= 3 ? ' berthed forward of the mainmast — berths 1 to 4.' : ' berthed aft of the mainmast — berths 6 to 9.')],
  amid: (t) => [t, S(' had the companionway berth, amidships.')],
  end: (t) => [t, S(' slept at one end of the corridor.')],
  inner: (t) => [t, S(' slept at neither end of the corridor.')],
};

function sameProse(t0, t1) {
  // Order the pair so the phrasing reads naturally: name < role < fate.
  const rank = { name: 0, role: 1, fate: 2 };
  const [a, b] = rank[t0.a] <= rank[t1.a] ? [t0, t1] : [t1, t0];
  if (a.a === 'name' && b.a === 'role') return [T('name', a.v), S(' signed the articles as '), T('role', b.v, ROLES[b.v]), S('.')];
  if (a.a === 'name' && b.a === 'fate') return [T('name', a.v), S(' was '), T('fate', b.v), S('.')];
  if (a.a === 'role' && b.a === 'fate') return [T('role', a.v), S(' was '), T('fate', b.v), S('.')];
  return [T(a.a, a.v), S(' and '), T(b.a, b.v), S(' were one hand.')];
}

function proseFor(clue) {
  const t = clue.terms;
  const A = () => T(t[0].a, t[0].v);
  const B = () => T(t[1].a, t[1].v);
  switch (clue.type) {
    case 'AT': return AT_PROSE[clue.kind](A(), clue.berth);
    case 'SAME': return sameProse(t[0], t[1]);
    case 'NOTSAME': return [A(), S(' was not '), B(), S('.')];
    case 'ADJ': return [A(), S(' and '), B(), S(' bunked side by side.')];
    case 'NADJ': return [A(), S(' and '), B(), S(' did not bunk side by side.')];
    case 'BEFORE': return [A(), S(' berthed forward of '), B(), S('.')];
    case 'DIST': return [A(), S(' and '), B(), S(' berthed exactly ' + clue.k + ' places apart.')];
    case 'DISTMIN': return [A(), S(' and '), B(), S(' berthed at least ' + clue.k + ' places apart.')];
    case 'BETWEEN': return [A(), S(' berthed somewhere between '), B(), S(' and '), T(t[2].a, t[2].v), S('.')];
    default: return [S('...')];
  }
}

// ---------------------------------------------------------------- clue pool

function pickWeighted(rng, entries) {
  let total = 0;
  for (const e of entries) total += e[1];
  let r = rng.next() * total;
  for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
  return entries[entries.length - 1][0];
}

function pickTwoAttrs(rng, attrs) {
  const i = rng.int(attrs.length);
  let j = rng.int(attrs.length - 1);
  if (j >= i) j++;
  return [attrs[i], attrs[j]];
}

function costOf(c) {
  return c.type === 'AT' ? AT_COST[c.kind] : TYPE_COST[c.type];
}

function signature(c) {
  const key = (t) => t.a + t.v;
  const ks = c.terms.map(key);
  const sym = (c.type === 'SAME' || c.type === 'NOTSAME' || c.type === 'ADJ' || c.type === 'NADJ' || c.type === 'DIST' || c.type === 'DISTMIN');
  const body = sym ? ks.slice().sort().join('~') : ks.join('~');
  return `${c.type}|${c.kind || ''}|${body}|${c.k || 0}|${c.mask || 0}`;
}

function distinctTerms(c) {
  for (let i = 0; i < c.terms.length; i++) {
    for (let j = i + 1; j < c.terms.length; j++) {
      if (c.terms[i].a === c.terms[j].a && c.terms[i].v === c.terms[j].v) return false;
    }
  }
  return true;
}

/** Build one clue that is TRUE under the ground truth, or null if this roll is degenerate. */
function makeClue(rng, typeName, tier, truth) {
  const attrs = tier.attrs;
  const pickAttr = () => attrs[rng.int(attrs.length)];
  const at = (a, b) => ({ a, v: truth[a][b] });

  switch (typeName) {
    case 'AT': {
      const b = rng.int(9);
      const kinds = tier.atKinds.filter((e) => atKindValid(e[0], b));
      if (!kinds.length) return null;
      const kind = pickWeighted(rng, kinds);
      return { type: 'AT', kind, berth: b, mask: atKindMask(kind, b), terms: [at(pickAttr(), b)] };
    }
    case 'SAME': {
      if (attrs.length < 2) return null;
      const b = rng.int(9);
      const [a1, a2] = pickTwoAttrs(rng, attrs);
      return { type: 'SAME', terms: [at(a1, b), at(a2, b)] };
    }
    case 'NOTSAME': {
      if (attrs.length < 2) return null;
      const [a1, a2] = pickTwoAttrs(rng, attrs);
      const b1 = rng.int(9), b2 = rng.int(9);
      if (b1 === b2) return null;
      return { type: 'NOTSAME', terms: [at(a1, b1), at(a2, b2)] };
    }
    case 'ADJ': {
      const b1 = rng.int(8), b2 = b1 + 1;
      return { type: 'ADJ', terms: [at(pickAttr(), b1), at(pickAttr(), b2)] };
    }
    case 'NADJ': {
      const b1 = rng.int(9), b2 = rng.int(9);
      if (Math.abs(b1 - b2) < 2) return null;
      return { type: 'NADJ', terms: [at(pickAttr(), b1), at(pickAttr(), b2)] };
    }
    case 'BEFORE': {
      const b1 = rng.int(9), b2 = rng.int(9);
      if (b1 >= b2) return null;
      return { type: 'BEFORE', terms: [at(pickAttr(), b1), at(pickAttr(), b2)] };
    }
    case 'DIST': {
      const b1 = rng.int(9), b2 = rng.int(9), d = Math.abs(b1 - b2);
      if (d < 2) return null;
      return { type: 'DIST', k: d, terms: [at(pickAttr(), b1), at(pickAttr(), b2)] };
    }
    case 'DISTMIN': {
      const b1 = rng.int(9), b2 = rng.int(9), d = Math.abs(b1 - b2);
      if (d < 2) return null;
      return { type: 'DISTMIN', k: rng.intRange(2, d), terms: [at(pickAttr(), b1), at(pickAttr(), b2)] };
    }
    case 'BETWEEN': {
      const b1 = rng.int(9), b2 = rng.int(9);
      const lo = Math.min(b1, b2), hi = Math.max(b1, b2);
      if (hi - lo < 2) return null;
      const bm = rng.intRange(lo + 1, hi - 1);
      return { type: 'BETWEEN', terms: [at(pickAttr(), bm), at(pickAttr(), lo), at(pickAttr(), hi)] };
    }
    default: return null;
  }
}

function buildPool(rng, tier, truth) {
  const seen = new Set();
  const out = [];
  let guard = 0;
  while (out.length < tier.pool && guard++ < tier.pool * 14) {
    const c = makeClue(rng, pickWeighted(rng, tier.weights), tier, truth);
    if (!c || !distinctTerms(c)) continue;
    const sig = signature(c);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  return rng.shuffle(out);
}

/** Direct pins for every term — the guaranteed-sufficient tail so generation can never fail. */
function pinTail(rng, tier, truth) {
  const out = [];
  for (const a of tier.attrs) {
    for (let b = 0; b < 9; b++) {
      out.push({ type: 'AT', kind: 'pin', berth: b, mask: 1 << b, terms: [{ a, v: truth[a][b] }], fallback: true });
    }
  }
  return rng.shuffle(out);
}

// ---------------------------------------------------------------- generation

function attemptGenerate(rng, tier, seedString, attempt, lenient) {
  const A = tier.attrs.length;
  const truth = {};
  for (const key of tier.attrs) truth[key] = rng.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]);

  const unique = (list) => runSolver(compile(list, tier.attrs), A, 2).count === 1;

  // --- 1. add clues until exactly one solution survives
  const feed = buildPool(rng, tier, truth).concat(pinTail(rng, tier, truth));
  const chosen = [];
  let i = 0, solved = false;
  while (i < feed.length) {
    const take = chosen.length === 0 ? tier.start : tier.stepAdd;
    for (let k = 0; k < take && i < feed.length; k++) chosen.push(feed[i++]);
    if (unique(chosen)) { solved = true; break; }
  }
  if (!solved) return null; // unreachable: pinTail forces uniqueness

  // --- 2. strip every clue that isn't load-bearing (one pass gives a minimal set:
  //        removing a clue that failed the test earlier can only add solutions later)
  const order = chosen.map((c, idx) => idx);
  const cost = chosen.map(costOf);
  const jitter = chosen.map(() => rng.next());
  const fallbackFirst = (a, b) => (chosen[b].fallback ? 1 : 0) - (chosen[a].fallback ? 1 : 0);
  if (tier.removeOrder === 'strongFirst') order.sort((a, b) => fallbackFirst(a, b) || cost[b] - cost[a] || jitter[a] - jitter[b]);
  else if (tier.removeOrder === 'weakFirst') order.sort((a, b) => fallbackFirst(a, b) || cost[a] - cost[b] || jitter[a] - jitter[b]);
  else order.sort((a, b) => fallbackFirst(a, b) || jitter[a] - jitter[b]);

  const alive = chosen.map(() => true);
  for (const idx of order) {
    alive[idx] = false;
    const sub = chosen.filter((_, j) => alive[j]);
    if (!unique(sub)) alive[idx] = true;
  }
  const kept = chosen.filter((_, j) => alive[j]);

  if (!lenient && (kept.length < tier.min || kept.length > tier.max)) return null;

  // --- 3. present: firm evidence first, inference last, but shuffled inside each band so
  //        the list doesn't read as five identical sentences in a row
  const band = (c) => { const k = costOf(c); return k >= 24 ? 0 : k >= 13 ? 1 : 2; };
  const shuf = new Map();
  for (const c of kept) shuf.set(c, rng.next());
  kept.sort((a, b) => band(a) - band(b) || shuf.get(a) - shuf.get(b));
  const clues = kept.map((c, idx) => {
    const tokens = capTokens(proseFor(c));
    return {
      id: idx,
      type: c.type,
      kind: c.kind || null,
      berth: c.berth === undefined ? -1 : c.berth,
      mask: c.mask === undefined ? FULL : c.mask,
      k: c.k === undefined ? 0 : c.k,
      terms: c.terms.map((t) => ({ a: t.a, v: t.v })),
      source: SOURCES[rng.int(SOURCES.length)],
      tokens,
      text: tokens.map((t) => t.t).join(''),
    };
  });

  return {
    seed: String(seedString),
    difficulty: tier.id,
    tierIndex: TIERS.indexOf(tier),
    attrs: tier.attrs.slice(),
    n: BERTHS,
    truth,
    clues,
    cells: tier.attrs.length * BERTHS,
    attempt,
    pins: clues.filter((c) => c.type === 'AT' && c.kind === 'pin').length,
  };
}

/**
 * generate(seedString, difficulty) -> puzzle with exactly one solution and no redundant clue.
 * Deterministic: identical (seed, difficulty) always yields an identical object.
 */
export function generate(seedString, difficulty = 'officer') {
  const tier = resolveTier(difficulty);
  const key = String(seedString) + '|' + tier.id;
  const MAX = 8;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const rng = new RNG(RNG.hash(key + '|' + attempt));
    const p = attemptGenerate(rng, tier, seedString, attempt, attempt === MAX - 1);
    if (p) return p;
  }
  // Unreachable — the final attempt is lenient — but never return nothing.
  return attemptGenerate(new RNG(RNG.hash(key + '|last')), tier, seedString, MAX, true);
}

// ---------------------------------------------------------------- campaign cases (ADDITION)
//
// A fixed, numbered 50-case Campaign. This section only ADDS exports — it does not
// touch the clue grammar, TIERS/ATTRS/SHIP vocabulary, or solver logic above.
//
// Each case is a plain (seed, tierIndex) pair. generate() is already deterministic and
// already strips every puzzle down to a minimal (no-redundant-clue) set, so a case
// needs nothing stored beyond its seed — replaying generate(seed, tier.id) always
// reproduces the exact same clue list. The seeds below were chosen OFFLINE by
// searching many seed variants per case number for the one whose natural minimal
// clue count best matches an escalating target: cases 1-15 use tier 0 (cadet) with a
// generous clue count tapering down; 16-35 use tier 1 (officer); 36-50 use tier 2
// (archivist) tapering down toward that tier's uniqueness-boundary minimum. Every
// case is verified unique (exactly one solution) at generation time — see
// registerSelftest in game.js and the throwaway verification script used to build
// this table.
export const CASES = [
  { n: 1, seed: 'CASE01X1', tierIndex: 0 },
  { n: 2, seed: 'CASE02X0', tierIndex: 0 },
  { n: 3, seed: 'CASE03X4', tierIndex: 0 },
  { n: 4, seed: 'CASE04X3', tierIndex: 0 },
  { n: 5, seed: 'CASE05X21', tierIndex: 0 },
  { n: 6, seed: 'CASE06X205', tierIndex: 0 },
  { n: 7, seed: 'CASE07X72', tierIndex: 0 },
  { n: 8, seed: 'CASE08X239', tierIndex: 0 },
  { n: 9, seed: 'CASE09X2', tierIndex: 0 },
  { n: 10, seed: 'CASE10X26', tierIndex: 0 },
  { n: 11, seed: 'CASE11X214', tierIndex: 0 },
  { n: 12, seed: 'CASE12X82', tierIndex: 0 },
  { n: 13, seed: 'CASE13X93', tierIndex: 0 },
  { n: 14, seed: 'CASE14X19', tierIndex: 0 },
  { n: 15, seed: 'CASE15X22', tierIndex: 0 },
  { n: 16, seed: 'CASE16X0', tierIndex: 1 },
  { n: 17, seed: 'CASE17X13', tierIndex: 1 },
  { n: 18, seed: 'CASE18X2', tierIndex: 1 },
  { n: 19, seed: 'CASE19X2', tierIndex: 1 },
  { n: 20, seed: 'CASE20X5', tierIndex: 1 },
  { n: 21, seed: 'CASE21X7', tierIndex: 1 },
  { n: 22, seed: 'CASE22X2', tierIndex: 1 },
  { n: 23, seed: 'CASE23X4', tierIndex: 1 },
  { n: 24, seed: 'CASE24X12', tierIndex: 1 },
  { n: 25, seed: 'CASE25X14', tierIndex: 1 },
  { n: 26, seed: 'CASE26X72', tierIndex: 1 },
  { n: 27, seed: 'CASE27X29', tierIndex: 1 },
  { n: 28, seed: 'CASE28X22', tierIndex: 1 },
  { n: 29, seed: 'CASE29X90', tierIndex: 1 },
  { n: 30, seed: 'CASE30X223', tierIndex: 1 },
  { n: 31, seed: 'CASE31X21', tierIndex: 1 },
  { n: 32, seed: 'CASE32X16', tierIndex: 1 },
  { n: 33, seed: 'CASE33X106', tierIndex: 1 },
  { n: 34, seed: 'CASE34X3', tierIndex: 1 },
  { n: 35, seed: 'CASE35X57', tierIndex: 1 },
  { n: 36, seed: 'CASE36X3', tierIndex: 2 },
  { n: 37, seed: 'CASE37X6', tierIndex: 2 },
  { n: 38, seed: 'CASE38X17', tierIndex: 2 },
  { n: 39, seed: 'CASE39X2', tierIndex: 2 },
  { n: 40, seed: 'CASE40X5', tierIndex: 2 },
  { n: 41, seed: 'CASE41X12', tierIndex: 2 },
  { n: 42, seed: 'CASE42X2', tierIndex: 2 },
  { n: 43, seed: 'CASE43X30', tierIndex: 2 },
  { n: 44, seed: 'CASE44X95', tierIndex: 2 },
  { n: 45, seed: 'CASE45X1', tierIndex: 2 },
  { n: 46, seed: 'CASE46X296', tierIndex: 2 },
  { n: 47, seed: 'CASE47X212', tierIndex: 2 },
  { n: 48, seed: 'CASE48X188', tierIndex: 2 },
  { n: 49, seed: 'CASE49X158', tierIndex: 2 },
  { n: 50, seed: 'CASE50X34', tierIndex: 2 },
];

/** Public: case N (1-based) -> its puzzle, regenerated fresh via the existing generate(). */
export function generateCaseN(n) {
  const c = CASES[Math.max(0, Math.min(CASES.length - 1, (n | 0) - 1))];
  return generate(c.seed, TIERS[c.tierIndex].id);
}
