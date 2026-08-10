// Orbital — procedural hole generator for the scaled-up back end of the course
// (holes 23-75). Holes 1-22 stay hand-authored in holes.js; this module only
// ever produces NEW hole defs for the generate/verify/reject pipeline run by
// tools-generate.mjs. It touches nothing at runtime — game.js never imports it.
//
// Design: difficulty is driven by a single 0..1 "f" (index/74). As f climbs:
//   - body count grows (1 -> 8)
//   - exotic types (blackhole, repulsor, wormhole pair, orbiting moon) become
//     more likely, but never before f ~ 0.12 (roughly hole 9), matching the
//     hand-authored front nine's "plain planets/moons first" pacing
//   - par target climbs from 2 to 8
//   - the field gets busier (bodies closer to the direct start->goal line)
//
// A candidate is just geometry — no solution. tools-generate.mjs is the only
// thing that calls solve() and decides accept/reject.

const W = 1440, H = 900;
const MARGIN = 120;

// ---------------------------------------------------------------- seeded RNG

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rand(rng, lo, hi) { return lo + rng() * (hi - lo); }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

// ---------------------------------------------------------------- flavor text

const NAME_POOL = [
  ['Drift', '漂移'], ['Perihelion', '近日点'], ['Slingway', '弹射道'], ['Halo Run', '光环之路'],
  ['Rubble Field', '碎石带'], ['Dark Marker', '暗标'], ['Loose Orbit', '松散轨道'], ['Tight Corner', '死角'],
  ['Split Pull', '分引力'], ['Signal Loss', '信号中断'], ['Crossfire', '交叉引力'], ['Long Fall', '长坠落'],
  ['Quiet Well', '静默引力井'], ['Twin Wells', '双井'], ['Overshoot', '过冲'], ['Undertow', '暗流'],
  ['Narrow Gate', '窄门'], ['Loop Back', '回环'], ['Static Field', '静止场'], ['Chain Reaction', '连锁反应'],
  ['Blind Corner', '盲角'], ['Steep Well', '陡井'], ['Far Side', '背面'], ['Debris Run', '残骸道'],
  ['Old Route', '旧航线'], ['Wide Berth', '宽绕行'], ['Close Pass', '贴身掠过'], ['Cold Trap', '冷阱'],
  ['Last Gasp', '最后一口气'], ['Second Guess', '再三权衡'], ['Trip Wire', '绊线'], ['Dead Reckoning', '航位推算'],
  ['Shear Line', '剪切线'], ['Split Field', '裂场'], ['Doubled Back', '折返'], ['Threefold', '三重'],
  ['Spiral Down', '螺旋下坠'], ['Spiral Out', '螺旋外扬'], ['Cross Current', '横流'], ['Final Approach', '最终进场'],
  ['Precision Run', '精准航线'], ['Margin Call', '临界'], ['Chicane', '之字弯'], ['Grazing Pass', '擦身而过'],
  ['Point Blank', '近距离'], ['Overhang', '悬垂'], ['Split Second', '一瞬之间'], ['Web of Wells', '引力网'],
  ['Furthest Reach', '极远之地'], ['Last Corridor', '最后走廊'], ['End of the Line', '终点线'],
  ['Vanishing Point', '消失点'], ['Coriolis', '科里奥利'], ['Retrograde', '逆行'], ['Aphelion', '远日点'],
  ['Bottleneck', '瓶颈'], ['Knife Edge', '刀锋边缘'],
];

const HINT_POOL = [
  ['Small correction now saves a big miss later.', '现在的小修正,能省下后面的大失误。'],
  ['Two pulls at once. Neither one waits for you.', '两股引力同时作用,谁都不会等你。'],
  ['The straight line is a trap.', '直线航道是个陷阱。'],
  ['Let it fall further before you decide.', '再让它多坠落一会儿,再做决定。'],
  ['Speed you do not need becomes speed you cannot control.', '用不上的速度,最后会变成你控不住的速度。'],
  ['The gap is real. It is just not where you think.', '缝隙确实存在,只是不在你以为的地方。'],
  ['Everything here pulls. Nothing here forgives.', '这里的一切都在拉扯,没有一样会宽容你。'],
  ['Aim for where it will be, not where it is.', '瞄准它将到的地方,而不是它现在的位置。'],
  ['One clean pass beats three panicked ones.', '一次干净的通过,胜过三次慌乱的尝试。'],
  ['You have flown this shape before. Trust it.', '这条曲线你飞过,相信它。'],
];

export function nameFor(rng) {
  const [en, zh] = pick(rng, NAME_POOL);
  const n = 1 + Math.floor(rng() * 900);
  return { name: `${en} ${n}`, nameZh: `${zh} ${n}` };
}

export function hintFor(rng) {
  const [en, zh] = pick(rng, HINT_POOL);
  return { hint: en, hintZh: zh };
}

// ---------------------------------------------------------------- geometry helpers

function dist(x0, y0, x1, y1) { return Math.hypot(x1 - x0, y1 - y0); }

function overlapsAny(x, y, r, placed, gap) {
  for (const p of placed) {
    if (dist(x, y, p.x, p.y) < r + p.r + gap) return true;
  }
  return false;
}

// ---------------------------------------------------------------- body factory

function randPos(rng) {
  return { x: rand(rng, MARGIN, W - MARGIN), y: rand(rng, MARGIN, H - MARGIN) };
}

/**
 * Generate one candidate hole definition (no `solution`) for difficulty index
 * idx in [22, 74] out of a course of `total` holes (75). Deterministic given
 * (idx, seed).
 */
export function genHole(idx, total, seed) {
  const rng = mulberry32((idx + 1) * 104729 + seed * 2654435761);
  const f = idx / (total - 1); // 0..1 difficulty fraction across the WHOLE course

  // start / goal on opposite sides, some vertical variety
  const leftX = rand(rng, 120, 200);
  const rightX = rand(rng, W - 200, W - 120);
  const startY = rand(rng, 140, H - 140);
  const goalY = rand(rng, 140, H - 140);
  const flip = rng() < 0.5;
  const start = { x: flip ? leftX : rightX, y: startY };
  const goal = { x: flip ? rightX : leftX, y: goalY, r: rand(rng, 28, 36) };

  // body count climbs with difficulty
  const nBodies = Math.min(8, 2 + Math.round(f * 7));

  // exotic unlock gates — mirrors the hand-authored front nine's pacing
  const allowBlackhole = f > 0.10;
  const allowRepulsor = f > 0.14;
  const allowWormhole = f > 0.22;
  const allowOrbit = f > 0.30;
  const allowDoubleExotic = f > 0.55;

  const placed = [{ x: start.x, y: start.y, r: 30 }, { x: goal.x, y: goal.y, r: goal.r + 20 }];
  const bodies = [];
  let exoticUsed = 0;
  let wormholeCount = 0;

  for (let i = 0; i < nBodies; i++) {
    let type = 'planet';
    const roll = rng();
    if (allowWormhole && roll < 0.14 + f * 0.10 && wormholeCount === 0 && (allowDoubleExotic || exoticUsed === 0)) {
      type = 'wormhole';
    } else if (allowBlackhole && roll < 0.30 + f * 0.15 && (allowDoubleExotic || exoticUsed === 0)) {
      type = 'blackhole';
    } else if (allowRepulsor && roll < 0.48 + f * 0.15 && (allowDoubleExotic || exoticUsed === 0)) {
      type = 'repulsor';
    } else if (rng() < 0.45) {
      type = 'moon';
    } else {
      type = 'planet';
    }

    let r;
    if (type === 'blackhole') r = rand(rng, 18, 26);
    else if (type === 'wormhole') r = rand(rng, 26, 32);
    else if (type === 'moon') r = rand(rng, 24, 32);
    else if (type === 'repulsor') r = rand(rng, 36, 58);
    else r = rand(rng, 44, 80 - f * 20); // planets shrink slightly at high difficulty (tighter gaps)

    if (type !== 'planet' && type !== 'moon') exoticUsed++;

    // placement: try a bunch of times to find a legal spot
    let pos = null;
    for (let t = 0; t < 40; t++) {
      const cand = randPos(rng);
      const gap = type === 'blackhole' ? 30 : 24;
      if (!overlapsAny(cand.x, cand.y, r, placed, gap)) { pos = cand; break; }
    }
    if (!pos) continue; // skip this body if the field is too crowded

    const def = { type, x: pos.x, y: pos.y, r };

    if (type === 'wormhole') {
      wormholeCount++;
      // place its mate too, so wormholes always arrive in a linked pair
      let matePos = null;
      for (let t = 0; t < 40; t++) {
        const cand = randPos(rng);
        if (!overlapsAny(cand.x, cand.y, r, placed, 24) && dist(cand.x, cand.y, pos.x, pos.y) > 180) { matePos = cand; break; }
      }
      if (!matePos) continue;
      const mateIdx = bodies.length + 1;
      def.link = mateIdx;
      const mate = { type: 'wormhole', x: matePos.x, y: matePos.y, r, link: bodies.length };
      placed.push({ x: pos.x, y: pos.y, r }, { x: matePos.x, y: matePos.y, r });
      bodies.push(def, mate);
      continue;
    }

    if (allowOrbit && type === 'moon' && rng() < 0.25 + f * 0.2) {
      // orbiting moon: anchor its circle near this body's position, drop the static x/y
      const orbR = rand(rng, 140, 260);
      const w = (rng() < 0.5 ? -1 : 1) * rand(rng, 0.7, 1.7);
      delete def.x; delete def.y;
      def.orbit = { cx: pos.x, cy: pos.y, r: orbR, w, phase: rand(rng, 0, Math.PI * 2) };
      // reserve clearance for the whole orbit ring's worst case near the tee/goal
      placed.push({ x: pos.x, y: pos.y, r: orbR + r });
      bodies.push(def);
      continue;
    }

    placed.push({ x: pos.x, y: pos.y, r });
    bodies.push(def);
  }

  const par = Math.min(8, 2 + Math.round(f * 6));
  const { name, nameZh } = nameFor(rng);
  const { hint, hintZh } = hintFor(rng);

  return {
    name, nameZh, par, hint, hintZh,
    bounds: { x: 0, y: 0, w: W, h: H },
    start, goal, bodies,
  };
}
