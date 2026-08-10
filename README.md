# Games×10

**[▶ Play at mr-pythoneer.github.io/Gamesx10](https://mr-pythoneer.github.io/Gamesx10/)**

Ten browser games, ten different genres, **zero dependencies**.

No npm, no CDN, no build step, and not a single image, audio, or font file. Every pixel is
drawn to a canvas and every sound is synthesized at runtime with WebAudio. The whole arcade is
plain ES modules over one small shared kit — clone it and open `index.html` on a static server
and it runs.

Each game also ships a **self-test**: a scripted, headless session that plays the game and
asserts it works. Open any game and run `await window.__selftest()` in the console.

---

## The games

| | Game | Genre | The idea |
|---|---|---|---|
| ★ | **[Afterimage](games/afterimage/)** | action-puzzle | Every death leaves a ghost of your last run. The levels are unsolvable until enough of your past selves are helping. |
| ★ | **[Orbital](games/orbital/)** | physics golf | Golf through real n-body gravity. Slingshot around planets, dodge black holes, sink it under par. |
| ★ | **[Swarm](games/swarm/)** | roguelite | Ten minutes. You only move — the weapons fire themselves. Draft upgrades, evolve them, survive the boss. |
| | **[Petri](games/petri/)** | strategy | A war fought with Conway patterns. You never move a unit; you only plant seeds and let the automaton fight. |
| | **[Blindsight](games/blindsight/)** | stealth | The screen is black. Ping to see — but the thing hunting you hears every ping you send. |
| | **[Lexicon](games/lexicon/)** | word game | Letters rain down and pile up with real physics. Trace a word through the pile and watch the collapse chain. |
| | **[Pulse](games/pulse/)** | rhythm | One button. The song is synthesized from a seed and the obstacles come from that same song, so they can never desync. |
| | **[The Nine](games/the-nine/)** | deduction | Nine strangers, contradictory testimony, one consistent answer. Correct guesses only lock in three at a time. |
| | **[Scribble](games/scribble/)** | sandbox physics | Draw anything and it becomes real. Ramps, pendulums, catapults — solve it however you can, on a limited ink budget. |
| | **[Mirrorbind](games/mirrorbind/)** | coordination | One set of keys drives two of you at once, in mirrored worlds. Both have to get home. |

★ = flagship, with level progression / unlocks / a boss.

---

## Running it

Anything that serves static files works. There is nothing to install.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. ES modules will not load over `file://` — every page
detects that and says so rather than failing silently.

---

## How it is built

```
index.html              arcade hub — a live procedural canvas tile per game
shared/kit.js           the contract: fixed-timestep loop, seeded RNG, injectable input,
                        WebAudio, namespaced storage, FX, self-test registration
shared/arcade.css       shared visual language
games/<slug>/           one self-contained folder per game
tools/verify.mjs        static gate — run with `node tools/verify.mjs`
tools/testbed.html      runtime gate — loads every game and runs its self-test
tools/gen-words.mjs     builds Lexicon's dictionary from /usr/share/dict/words
```

Two rules hold the whole thing together:

**1. The simulation is pure.** Each game keeps its state in a plain, cloneable object and
advances it through a single `stepSim(state, input, dt)`. The live game, the self-test, and
(where one exists) the level solver all call that same function, so they can never disagree
about how the game behaves.

**2. The simulation is deterministic.** No game calls `Math.random()` or `Date.now()` inside
its simulation — randomness comes from a seeded RNG and time from a fixed timestep. Same seed
plus same inputs produces an identical run, every time. That is the property that makes a
self-test meaningful instead of decorative.

That combination pays off in a way that is easy to miss: several games can *prove* their
content is playable. Mirrorbind runs a best-first search over its own physics to confirm every
level is beatable and embeds the winning input script; the self-test replays all ten. During
development that search rejected four levels as impossible — including one whose pit was a
single tile too wide to jump.

---

## Verification

Nothing here is marked "works" because it looked fine in a screenshot.

**Gate 1 — static, offline.** `node tools/verify.mjs` resolves every local link and import
against the filesystem, parses every JS file and every inline `<script>`, checks each game
registers a self-test, and **fails on any external URL** — which is what mechanically
guarantees the arcade downloads nothing.

> It deliberately does not use `node --check`: on Node 25 that silently exits 0 on files
> containing real syntax errors. `vm.SourceTextModule` parses without evaluating and reports
> them properly.

**Gate 2 — runtime.** `tools/testbed.html` loads each game in turn and runs its
`window.__selftest()`. Every game asserts, at minimum: the world initializes, input produces a
real state change, a scoring or progress event fires, the win condition is reachable, the lose
condition is reachable, no `NaN`/`Infinity` appears after 600+ simulated frames, and nothing
throws. Games with generated content assert more — Petri checks that a blinker oscillates and a
glider actually travels, The Nine checks that every generated puzzle has exactly one solution.

**Gate 3 — live.** The same runtime gate is re-run against the deployed GitHub Pages URL,
because passing locally is not evidence that a deployed page works.

**Results, live at `mr-pythoneer.github.io/Gamesx10`** — every game: zero console errors,
self-test passes in full, and confirmed with real input driven through the actual production
code path (not just the self-test grading its own homework — a dragged word in Lexicon, a
timed jump in Pulse, a real click that stamps a pattern in Petri, and so on).

| Game | Self-test | Console | Real-input check |
|---|---|---|---|
| Afterimage | 13/13 | clean | verified solution replayed through real `Input`; ghost archival, plate/door, level-clear all confirmed |
| Orbital | 12/12 | clean | real drag-launch flew the probe, advanced the stroke counter |
| Swarm | 14/14 | clean | real movement, 27 kills from auto-fire, gem pickup, level-up, and a number-key draft pick all confirmed |
| Petri | 15/15 | clean | real click stamped a glider (+5 cells, exact pattern size) |
| Blindsight | 24/24 | clean | real ping lit the reveal buffer; found & fixed a proximity-falloff bug |
| Lexicon | 24/24 | clean | a real dictionary word, dragged through touching tiles, scored correctly |
| Pulse | 16/16 | clean | a precisely-timed jump scored "perfect"; a no-input run correctly dies |
| The Nine | 17/17 | clean | — |
| Scribble | 21/21 | clean | verified ramp stroke, drawn via real pointer events, delivered the ball to the goal |
| Mirrorbind | 10/10 | clean | all 10 levels machine-solved and replayed to a win through real `Input` |

Five real bugs were caught and fixed during this pass — not in the games' actual mechanics, but
in test harnesses and one genuine gameplay bug:

- **Blindsight** — the danger-proximity falloff used a hardcoded radius instead of scaling with
  map size (a real gameplay fix).
- **Scribble** — its own self-test raced against the page's live update loop over a
  multi-hundred-frame physics outcome, and separately mutated real saved progress
  (`localStorage`) as a side effect of running.
- **Petri** — its self-test read a population counter one frame after stamping, before the CA's
  own throttled tick had run; and a throwaway `boot()` call used for live-input testing silently
  orphaned the page's debug handle.
- Several apparent failures during manual verification turned out to be test-methodology
  mistakes on the verifier's part (wrong coordinate transform, racing the live render loop,
  confusing a legitimate level-advance with a failure) — logged here for transparency, not
  claimed as game fixes.

<!-- VERIFICATION-RESULTS -->

---

## Notes for anyone reading the code

- **`requestAnimationFrame` is not guaranteed to be delivered.** Chrome withholds it from
  unfocused windows, and some embedded webviews report the document as hidden while still
  painting. The kit drives its loop from rAF with a `setInterval` watchdog, so a game never
  silently freezes. The loop integrates elapsed time rather than assuming a cadence, so
  neither clock can double-step it.
- **Audio cannot start before a user gesture.** `Sound` lazily initializes and every method
  no-ops until then, so no game's logic can depend on audio existing — and the self-tests,
  which never get a gesture, run fine without it.
- **Lexicon's dictionary is generated locally**, from the `/usr/share/dict/words` that already
  ships with macOS and most Unixes. 76,089 words, no download.

## Licence

MIT.
