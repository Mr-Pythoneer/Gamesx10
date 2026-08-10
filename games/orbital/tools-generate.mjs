// DEV TOOL — not shipped to the browser, not imported by the game or generator.js.
//
// Generate-verify-reject loop that scales holes.js from 22 to 75 holes. Keeps the
// existing 22 hand-authored holes untouched as difficulty slots 0-21, then procedurally
// generates slots 22-74 with generator.js, verifies each candidate with the REAL solver
// (solve() in sim.js, forward-simulated against the REAL stepSim via buildSim/flightResult
// — the exact same code path the live game uses), and only accepts holes that are
// provably sinkable and not degenerate for their difficulty tier.
//
//   node games/orbital/tools-generate.mjs
//
import { readFile, writeFile } from 'node:fs/promises';
import { solve } from './sim.js';
import { genHole } from './generator.js';

const TOTAL = 75;
const EXISTING = 22;
const holesURL = new URL('./holes.js', import.meta.url);

const src = await readFile(holesURL, 'utf8');

// Difficulty tiers -> search cost + acceptance bar. Coarser search early (easy holes
// are easy to find), finer later where basins are small. Reject candidates that are
// "too easy" for their tier (huge basin = a trivial straight shot) once we are well
// past the intro holes, and reject anything the solver can't crack after a few retries.
function tierFor(idx) {
  const f = idx / (TOTAL - 1);
  if (f < 0.35) return { angles: 90, powers: 20, maxHits: Infinity };
  if (f < 0.60) return { angles: 120, powers: 24, maxHits: 900 };
  if (f < 0.80) return { angles: 150, powers: 28, maxHits: 500 };
  return { angles: 180, powers: 32, maxHits: 260 };
}

const accepted = [];
const t0 = Date.now();

for (let idx = EXISTING; idx < TOTAL; idx++) {
  const tier = tierFor(idx);
  let done = false;
  for (let attempt = 0; attempt < 60 && !done; attempt++) {
    const seed = idx * 97 + attempt * 733 + 13;
    const def = roundDef(genHole(idx, TOTAL, seed));
    if (def.bodies.length < 1) continue; // degenerate: field too crowded, nothing placed

    // Solve against the ROUNDED geometry — the exact numbers that will land in
    // holes.js — so a knife-edge solution can never be invalidated by the rounding
    // that happens at source-emission time (bit for bit the same sim either way).
    const r = solve(def, { angles: tier.angles, powers: tier.powers });
    if (!r.ok) continue;
    if (r.hits > tier.maxHits) continue; // too easy for this tier — reject and retry
    if (r.hits < 5) continue; // too knife-edge — a shot a human could never reliably repeat

    accepted.push({ ...def, solution: r.solution });
    console.log(`hole ${idx + 1} accepted after ${attempt + 1} attempt(s): "${def.name}" ` +
      `par ${def.par} bodies ${def.bodies.length} hits ${r.hits}/${r.tried}`);
    done = true;
  }
  if (!done) {
    console.log(`hole ${idx + 1}: FAILED to find a sinkable, appropriately-hard candidate after 60 attempts`);
  }
}

console.log(`\n${accepted.length}/${TOTAL - EXISTING} new holes generated+verified in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (accepted.length === TOTAL - EXISTING) {
  const block = accepted.map(holeToSource).join('\n\n');
  const insertion = `\n${block}\n];`;
  const newSrc = src.replace(/\n\];\s*$/m, insertion);
  await writeFile(holesURL, newSrc);
  console.log(`wrote ${accepted.length} new holes into holes.js`);
} else {
  console.log('NOT writing holes.js — did not reach the full 75.');
  process.exitCode = 1;
}

// ---------------------------------------------------------------- source emission

function esc(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function round(n, d = 2) { const k = 10 ** d; return Math.round(n * k) / k; }

function roundDef(h) {
  return {
    ...h,
    start: { x: round(h.start.x), y: round(h.start.y) },
    goal: { x: round(h.goal.x), y: round(h.goal.y), r: round(h.goal.r) },
    bodies: h.bodies.map((b) => {
      const nb = { ...b, r: round(b.r) };
      if (nb.x !== undefined) { nb.x = round(nb.x); nb.y = round(nb.y); }
      if (nb.orbit) nb.orbit = { cx: round(nb.orbit.cx), cy: round(nb.orbit.cy), r: round(nb.orbit.r), w: round(nb.orbit.w, 4), phase: round(nb.orbit.phase, 4) };
      return nb;
    }),
  };
}

function bodyToSource(b) {
  const parts = [`type: '${b.type}'`];
  if (b.x !== undefined) parts.push(`x: ${round(b.x)}`, `y: ${round(b.y)}`);
  parts.push(`r: ${round(b.r)}`);
  if (b.link !== undefined) parts.push(`link: ${b.link}`);
  if (b.orbit) {
    parts.push(`orbit: { cx: ${round(b.orbit.cx)}, cy: ${round(b.orbit.cy)}, r: ${round(b.orbit.r)}, w: ${round(b.orbit.w, 4)}, phase: ${round(b.orbit.phase, 4)} }`);
  }
  return `      { ${parts.join(', ')} },`;
}

function holeToSource(h) {
  const bodiesSrc = h.bodies.map(bodyToSource).join('\n');
  return [
    '  {',
    `    name: '${esc(h.name)}',`,
    `    nameZh: '${esc(h.nameZh)}',`,
    `    par: ${h.par},`,
    `    hint: '${esc(h.hint)}',`,
    `    hintZh: '${esc(h.hintZh)}',`,
    `    bounds: { x: ${h.bounds.x}, y: ${h.bounds.y}, w: ${h.bounds.w}, h: ${h.bounds.h} },`,
    `    start: { x: ${round(h.start.x)}, y: ${round(h.start.y)} },`,
    `    goal: { x: ${round(h.goal.x)}, y: ${round(h.goal.y)}, r: ${round(h.goal.r)} },`,
    '    bodies: [',
    bodiesSrc,
    '    ],',
    `    solution: { a: ${h.solution.a}, p: ${h.solution.p} },`,
    '  },',
  ].join('\n');
}
