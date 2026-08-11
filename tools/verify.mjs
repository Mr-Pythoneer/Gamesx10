// Gate 1 — static verification. Zero dependencies, fully offline.
//
//   node tools/verify.mjs
//
// Proves, without a browser:
//   - every game exists, is linked from the hub, and has the right shape
//   - every local src/href/import actually resolves on disk
//   - every JS file and every inline <script> parses
//   - every game registers a self-test
//   - NO file references an external URL, which is what mechanically guarantees the
//     whole arcade is self-contained and downloads nothing
//
// Note: `node --check` is NOT used. On Node 25 it silently exits 0 on files with real
// syntax errors, which would make this gate worthless. vm.SourceTextModule parses
// without evaluating and reports errors correctly.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

// vm.SourceTextModule needs a flag — re-exec ourselves with it rather than making
// the caller remember.
if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath,
    ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const GAMES = [
  { slug: 'afterimage', name: 'Afterimage' },
  { slug: 'orbital', name: 'Orbital' },
  { slug: 'swarm', name: 'Swarm' },
  { slug: 'petri', name: 'Petri' },
  { slug: 'blindsight', name: 'Blindsight' },
  { slug: 'lexicon', name: 'Lexicon' },
  { slug: 'pulse', name: 'Pulse' },
  { slug: 'the-nine', name: 'The Nine' },
  { slug: 'scribble', name: 'Scribble' },
  { slug: 'mirrorbind', name: 'Mirrorbind' },
];

// XML namespace URIs are identifiers, not network requests. The GitHub link in the
// hub's colophon is a plain outbound <a href> — the user clicks it, the page never
// fetches it — which doesn't touch the "the arcade downloads nothing" guarantee this
// check exists to enforce, unlike a CDN <script src> or a remote image would.
const URL_ALLOWLIST = [
  /^https?:\/\/www\.w3\.org\//,
  /^https?:\/\/github\.com\/Mr-Pythoneer\/?$/,
];

const fails = [];
const warns = [];
let checks = 0;

const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); return !!cond; };
const warn = (cond, msg) => { checks++; if (!cond) warns.push(msg); return !!cond; };
const rel = (p) => relative(ROOT, p);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk(ROOT);
const jsFiles = allFiles.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));
const cssFiles = allFiles.filter((f) => f.endsWith('.css'));

// ---------------------------------------------------------------- A. structure

ok(existsSync(join(ROOT, 'index.html')), 'missing root index.html (the arcade hub)');
ok(existsSync(join(ROOT, 'shared', 'kit.js')), 'missing shared/kit.js');
ok(existsSync(join(ROOT, 'shared', 'arcade.css')), 'missing shared/arcade.css');
ok(existsSync(join(ROOT, '.nojekyll')), 'missing .nojekyll (GitHub Pages would skip files starting with _)');

for (const g of GAMES) {
  const dir = join(ROOT, 'games', g.slug);
  const idx = join(dir, 'index.html');
  if (!ok(existsSync(idx), `${g.slug}: missing games/${g.slug}/index.html`)) continue;

  const html = readFileSync(idx, 'utf8');
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  ok(/Gamesx10/.test(title), `${g.slug}: <title> should end with "— Gamesx10", got "${title.trim()}"`);
  ok(/\.\.\/\.\.\/index\.html/.test(html), `${g.slug}: no back-link to ../../index.html in the topbar`);
  ok(/<canvas[^>]+id=["']game["']/.test(html), `${g.slug}: no <canvas id="game"> in index.html`);
  ok(/type=["']module["']/.test(html), `${g.slug}: entry script is not type="module"`);

  // self-test registration, anywhere in the game's own folder
  const own = walk(dir).filter((f) => f.endsWith('.js'));
  const registers = own.some((f) => /registerSelftest\s*\(/.test(readFileSync(f, 'utf8')));
  ok(registers, `${g.slug}: no registerSelftest(...) call — the runtime gate cannot test it`);

  const usesKit = own.some((f) => /from\s+['"]\.\.\/\.\.\/shared\/kit\.js['"]/.test(readFileSync(f, 'utf8')));
  ok(usesKit, `${g.slug}: does not import ../../shared/kit.js`);
}

// ---------------------------------------------------------------- B. hub links every game

// The hub builds its hrefs from a slug table, so the literal path never appears in
// the source — look for the slug itself, however it is referenced.
if (existsSync(join(ROOT, 'index.html'))) {
  const hub = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const g of GAMES) {
    const referenced = hub.includes(`games/${g.slug}/`)
      || hub.includes(`'${g.slug}'`)
      || hub.includes(`"${g.slug}"`);
    ok(referenced, `hub index.html never references the "${g.slug}" game`);
  }
}

// ---------------------------------------------------------------- C. local links resolve

function checkLocalRef(fromFile, ref, kind) {
  if (!ref) return;
  const r = ref.trim();
  if (!r || r.startsWith('data:') || r.startsWith('#') || r.startsWith('mailto:')) return;
  if (/^[a-z]+:/i.test(r) || r.startsWith('//')) return; // absolute — handled by the URL check
  const clean = r.split('?')[0].split('#')[0];
  const target = clean.startsWith('/')
    ? join(ROOT, clean)
    : resolve(dirname(fromFile), clean);
  const candidates = [target];
  if (!/\.\w+$/.test(clean) || clean.endsWith('/')) candidates.push(join(target, 'index.html'));
  ok(candidates.some((c) => existsSync(c)),
    `${rel(fromFile)}: ${kind} "${r}" does not resolve on disk`);
}

for (const f of htmlFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) checkLocalRef(f, m[1], 'link');
}

for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  const specs = [
    ...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ];
  for (const m of specs) {
    const s = m[1];
    if (s.startsWith('node:') || (!s.startsWith('.') && !s.startsWith('/'))) continue; // bare = node builtin in tools/
    checkLocalRef(f, s, 'import');
  }
}

// ---------------------------------------------------------------- D. everything parses

function parseModule(src, label) {
  try { new vm.SourceTextModule(src, { identifier: label }); return null; }
  catch (e) { return `${e.name}: ${e.message.split('\n')[0]}`; }
}
function parseScript(src, label) {
  try { new vm.Script(src, { filename: label }); return null; }
  catch (e) { return `${e.name}: ${e.message.split('\n')[0]}`; }
}

for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  const err = parseModule(src, rel(f));
  ok(!err, `${rel(f)}: does not parse — ${err}`);
}

for (const f of htmlFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/.test(attrs) || !body.trim()) continue;
    const isModule = /type\s*=\s*["']module["']/.test(attrs);
    const err = isModule ? parseModule(body, rel(f)) : parseScript(body, rel(f));
    ok(!err, `${rel(f)}: inline <script> does not parse — ${err}`);
  }
}

// ---------------------------------------------------------------- E. no external URLs

const URL_RE = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)>\]]*/gi;
for (const f of [...htmlFiles, ...jsFiles, ...cssFiles]) {
  if (rel(f).startsWith('tools/')) continue;           // dev tooling, never shipped to the browser
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(URL_RE)) {
    const url = m[0];
    if (URL_ALLOWLIST.some((re) => re.test(url))) continue;
    // ignore matches inside line comments — they're prose, not requests
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (/(^|\s)(\/\/|\*|#)/.test(before)) continue;
    ok(false, `${rel(f)}: external URL "${url}" — the arcade must be fully self-contained`);
  }
}

// ---------------------------------------------------------------- F. hygiene warnings

for (const f of jsFiles) {
  if (rel(f).startsWith('tools/')) continue;
  const src = readFileSync(f, 'utf8');
  const gameFile = rel(f).startsWith('games/');
  if (gameFile) {
    warn(!/\bdebugger\b/.test(src), `${rel(f)}: contains a debugger statement`);
    const c = (src.match(/console\.(log|debug)\(/g) || []).length;
    warn(c < 6, `${rel(f)}: ${c} console.log/debug calls left in`);
  }
}

// ---------------------------------------------------------------- report

const totalKB = allFiles.reduce((a, f) => a + statSync(f).size, 0) / 1024;
console.log('');
console.log('  Gamesx10 — Gate 1 (static)');
console.log('  ' + '-'.repeat(52));
console.log(`  files      ${allFiles.length}  (${jsFiles.length} js, ${htmlFiles.length} html)`);
console.log(`  repo size  ${totalKB.toFixed(0)} KB`);
console.log(`  checks     ${checks}`);

for (const g of GAMES) {
  const dir = join(ROOT, 'games', g.slug);
  const present = existsSync(join(dir, 'index.html'));
  const own = present ? walk(dir) : [];
  const kb = own.reduce((a, f) => a + statSync(f).size, 0) / 1024;
  const bad = fails.filter((m) => m.startsWith(g.slug + ':')).length;
  const mark = !present ? '·· missing' : bad ? `!! ${bad} problem${bad > 1 ? 's' : ''}` : 'ok';
  console.log(`  ${g.slug.padEnd(12)} ${String(own.length).padStart(2)} files ${kb.toFixed(0).padStart(5)} KB   ${mark}`);
}

if (warns.length) {
  console.log('\n  warnings');
  for (const w of warns) console.log('    ~ ' + w);
}

if (fails.length) {
  console.log(`\n  FAILED — ${fails.length} problem${fails.length > 1 ? 's' : ''}`);
  for (const f of fails) console.log('    x ' + f);
  console.log('');
  process.exit(1);
}

console.log(`\n  PASSED — ${checks} checks, no external URLs, everything parses and resolves.\n`);
