// DEV TOOL — not shipped to the browser, not imported by the game.
//
// Headless hole verifier. Imports the SAME pure sim the game runs (sim.js has no DOM
// access precisely so this can exist) and grid-searches launch angle x power for every
// hole, forward-simulating each candidate to a time limit.
//
//   node games/orbital/tools-solve.mjs            # report only
//   node games/orbital/tools-solve.mjs --write    # also rewrite the solution: lines in holes.js
//   node games/orbital/tools-solve.mjs --hole 7   # one hole
//   node games/orbital/tools-solve.mjs --angles 240 --powers 40
//
// Node >= 22 detects ES module syntax in .js files, so importing ./sim.js works with no
// package.json and no build step.

import { readFile, writeFile } from 'node:fs/promises';
import { solve, replaySolution, HOLE_COUNT, MAX_POWER } from './sim.js';
import { HOLES } from './holes.js';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : def;
};
const has = (name) => argv.includes('--' + name);

const angles = flag('angles', 180);
const powers = flag('powers', 30);
const only = has('hole') ? flag('hole', 0) : -1;
const holesURL = new URL('./holes.js', import.meta.url);

const results = [];
const t0 = Date.now();

for (let i = 0; i < HOLE_COUNT; i++) {
  if (only >= 0 && i !== only) { results.push(null); continue; }
  const st = Date.now();
  const r = solve(i, { angles, powers });
  const ms = Date.now() - st;
  results.push(r);
  const h = HOLES[i];
  if (r.ok) {
    const deg = ((r.solution.a * 180) / Math.PI + 360) % 360;
    console.log(
      `hole ${String(i + 1).padStart(2, '0')} ${h.name.padEnd(20)} par ${h.par}  ` +
      `SINKABLE  basins ${String(r.hits).padStart(4)}/${r.tried}  ` +
      `robust ${String(r.robustness).padStart(2)}/25  ` +
      `shot ${deg.toFixed(1).padStart(6)}deg @ ${(100 * r.solution.p / MAX_POWER).toFixed(0).padStart(3)}% ` +
      `lands in ${(r.frames / 60).toFixed(2)}s  (${ms}ms)`
    );
  } else {
    console.log(
      `hole ${String(i + 1).padStart(2, '0')} ${h.name.padEnd(20)} par ${h.par}  ` +
      `*** NO SOLUTION *** searched ${r.tried} launches  (${ms}ms)`
    );
  }
}

const solved = results.filter((r) => r && r.ok).length;
const attempted = results.filter(Boolean).length;
console.log(`\n${solved}/${attempted} holes machine-verified sinkable in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (has('write')) {
  let src = await readFile(holesURL, 'utf8');
  let n = 0;
  src = src.replace(/solution: \{[^}]*\}/g, (m) => {
    const r = results[n++];
    if (!r || !r.ok) return m;
    return `solution: { a: ${r.solution.a}, p: ${r.solution.p} }`;
  });
  await writeFile(holesURL, src);
  console.log(`wrote ${solved} solutions into holes.js (${n} slots seen)`);
}

// Independent replay check against the file as it now stands.
if (has('verify')) {
  const fresh = (await import('./holes.js?' + Date.now())).HOLES;
  let ok = 0;
  for (let i = 0; i < fresh.length; i++) {
    const r = replaySolution(i, fresh[i].solution);
    if (r.status === 'sunk') ok++;
    else console.log(`  replay FAILED hole ${i + 1}: ${r.status}`);
  }
  console.log(`replay of stored solutions: ${ok}/${fresh.length} sink`);
}
