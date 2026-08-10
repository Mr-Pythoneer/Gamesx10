// Scribble — automated stroke-script solver.
//
// Turns a generator.js level draft plus a rough "bridge these gaps" guess into a
// VERIFIED winning stroke script, by replaying candidates through the real physics
// (the same makeSim/stepSim the game and registerSelftest use — see physics.js) and
// hill-climbing the stroke endpoints against how close the ball actually gets.
//
// This is the same style of search that originally produced the 12 hand-authored
// levels' solutions (per levels.js's header comment): search over stroke point
// sequences, scored by proximity to the goal in a real simulated run, refined by local
// perturbation — just automated here so it can run 38+ times unattended.
//
// Nothing in here touches physics.js's solver constants. It only ever supplies level
// geometry + stroke points; physics.js decides what happens to them.

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

/** Straight-line initial guess: one stroke per gap, nudged slightly into each landing
 *  platform so the ramp actually rests on solid ground rather than just kissing the edge. */
export function heuristicStrokes(gaps) {
  return gaps.map((g) => {
    const dx = g.to.x - g.from.x, dy = g.to.y - g.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const a = { x: g.from.x + ux * 8, y: g.from.y + uy * 8 };
    const b = { x: g.to.x - ux * 8 + 30, y: g.to.y - uy * 8 + 14 };
    return { tool: 'static', points: [[a.x, a.y], [b.x, b.y]] };
  });
}

/**
 * solveLevel(physics, LEVELS, idx, level, gaps, opts) -> { ok, strokes, ink, best, reason }
 *
 * Mutates LEVELS[idx] = level for the duration of the search (physics.js's makeSim/
 * stepSim/replaySolution all key off LEVELS[levelIndex]), with a large placeholder ink
 * budget so the search itself is never blocked by the very budget it is trying to hit.
 * The caller is responsible for setting the level's real `ink` budget afterward from
 * the returned `ink` figure.
 */
export function solveLevel(physics, LEVELS, idx, level, gaps, opts = {}) {
  const iterations = opts.iterations ?? 220;
  const restarts = opts.restarts ?? 3;

  const draft = { ...level, ink: 1e9 };
  LEVELS[idx] = draft;
  physics.invalidateGrid(idx);

  let strokes = heuristicStrokes(gaps);
  let bestStrokes = strokes;
  let bestScore = Infinity;
  let bestInk = Infinity;
  let bestWon = false;

  const evaluate = (strokeSet) => {
    const sol = { strokes: strokeSet, settle: 30, maxFrames: 900 };
    const r = physics.replaySolution(idx, sol);
    let score = r.best;
    if (r.dead) score += 400;
    if (!r.won) score += 200;
    return { score, ink: r.ink, won: r.won };
  };

  let cur = strokes;
  let curEval = evaluate(cur);
  if (curEval.score < bestScore) { bestScore = curEval.score; bestStrokes = cur; bestInk = curEval.ink; bestWon = curEval.won; }

  for (let restart = 0; restart < restarts && !(bestWon && bestInk <= level.ink); restart++) {
    let temp = 26;
    for (let it = 0; it < iterations; it++) {
      temp = Math.max(1.5, 26 * (1 - it / iterations));
      const cand = cur.map((s) => ({ tool: s.tool, points: s.points.map((p) => p.slice()) }));
      // perturb one random endpoint of one random stroke
      const si = Math.floor(Math.random() * cand.length);
      const pi = Math.floor(Math.random() * cand[si].points.length);
      cand[si].points[pi][0] += (Math.random() - 0.5) * temp * 2;
      cand[si].points[pi][1] += (Math.random() - 0.5) * temp * 2;

      const ev = evaluate(cand);
      if (ev.score < curEval.score) {
        cur = cand; curEval = ev;
        if (ev.score < bestScore) { bestScore = ev.score; bestStrokes = cand; bestInk = ev.ink; bestWon = ev.won; }
      }
      // Stop only once we have a clearly robust win (ball settles well inside the goal,
      // not just barely grazing its edge) — a razor-thin margin here is exactly the kind
      // of "solved" that a later float-formatting pass could silently un-solve.
      const margin = level.goal.r * 0.55;
      if (bestWon && bestInk <= level.ink && bestScore < margin) break;
    }
    if (!(bestWon && bestInk <= level.ink && bestScore < level.goal.r * 0.55)) {
      // restart from the heuristic guess with a fresh perturbation budget
      cur = heuristicStrokes(gaps);
      curEval = evaluate(cur);
    }
  }

  return {
    ok: bestWon && bestInk <= level.ink,
    strokes: bestStrokes,
    ink: bestInk,
    best: bestScore,
    won: bestWon,
  };
}
