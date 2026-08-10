// Orbital — 22 hand-authored holes.
//
// Coordinates are world units; every hole shares a 1440x900 field so the camera maths
// stays simple, but each declares its own bounds so the out-of-bounds rule is explicit.
//
// Body types
//   planet     solid, attracts. Crashing into one costs a stroke.
//   moon       solid, small, gentle pull — good for fine steering.
//   blackhole  solid, enormous pull, tiny lethal core.
//   repulsor   solid, NEGATIVE gravity: it shoves the probe away.
//   wormhole   not solid. `link` is the index of its partner in this hole's bodies
//              array. Entering one mouth exits the other with speed and heading intact.
//   orbit      any body may carry {cx, cy, r, w, phase} and sweep a circle. Orbit angle
//              is a function of FLIGHT time, so every attempt on a hole is identical.
//
// `solution` is a launch {a: angle-radians, p: speed} discovered by the grid solver in
// sim.js, run headlessly in node via tools-solve.mjs, and replayed by window.__selftest()
// to prove the hole is sinkable. Never hand-edit these — re-run the solver.

export const HOLES = [
  {
    name: 'First Light',
    nameZh: '初光',
    par: 2,
    hint: 'Drag back from the probe and let go. Straight lines do not survive gravity.',
    hintZh: '向后拖拽探测器然后松手。直线在引力面前撑不了多久。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 450 },
    goal: { x: 1290, y: 450, r: 34 },
    bodies: [
      { type: 'planet', x: 720, y: 450, r: 78 },
    ],
    solution: { a: 0.24434609527920614, p: 484.46666666666664 },
  },

  {
    name: 'Sling',
    nameZh: '弹弓',
    par: 2,
    hint: 'Falling toward a planet is free speed. Falling into one is not.',
    hintZh: '朝行星坠落是免费的加速,撞上行星可不是。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 170, y: 770 },
    goal: { x: 1290, y: 170, r: 32 },
    bodies: [
      { type: 'planet', x: 700, y: 470, r: 70 },
    ],
    solution: { a: 6.03883921190038, p: 420.5066666666667 },
  },

  {
    name: 'The Gate',
    nameZh: '门径',
    par: 2,
    hint: 'Two equal pulls cancel. Split the difference.',
    hintZh: '两股相等的引力会相互抵消,走中线。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 450 },
    goal: { x: 1300, y: 450, r: 30 },
    bodies: [
      { type: 'planet', x: 640, y: 180, r: 62 },
      { type: 'planet', x: 640, y: 720, r: 62 },
    ],
    solution: { a: 0, p: 477.36 },
  },

  {
    name: 'Moonshot',
    nameZh: '奔月',
    par: 2,
    hint: 'Moons nudge. Planets shove.',
    hintZh: '卫星轻推,行星猛推。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 160, y: 790 },
    goal: { x: 1290, y: 140, r: 34 },
    bodies: [
      { type: 'moon', x: 520, y: 560, r: 30 },
      { type: 'moon', x: 900, y: 340, r: 30 },
      { type: 'planet', x: 700, y: 830, r: 58 },
    ],
    solution: { a: 5.82939970166106, p: 477.36 },
  },

  {
    name: 'Behind the Curtain',
    nameZh: '幕后',
    par: 2,
    hint: 'You cannot go through it. Go around and let it reel you back.',
    hintZh: '你穿不过去。绕过它,让它把你甩回来。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 180 },
    goal: { x: 950, y: 700, r: 30 },
    bodies: [
      { type: 'planet', x: 640, y: 430, r: 88 },
      { type: 'moon', x: 1180, y: 300, r: 30 },
    ],
    solution: { a: 0.7853981633974482, p: 491.5733333333334 },
  },

  {
    name: 'Cradle',
    nameZh: '摇篮',
    par: 2,
    hint: 'Three wells, one lane. Read the whole curve before you let go.',
    hintZh: '三个引力井,一条通道。松手前先看清整条轨迹。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 450 },
    goal: { x: 1250, y: 640, r: 34 },
    bodies: [
      { type: 'planet', x: 560, y: 290, r: 60 },
      { type: 'planet', x: 560, y: 660, r: 48 },
      { type: 'moon', x: 960, y: 450, r: 28 },
    ],
    solution: { a: 0.17453292519943295, p: 491.5733333333333 },
  },

  {
    name: 'Event Horizon',
    nameZh: '事件视界',
    par: 3,
    hint: 'BLACK HOLE. All the pull of a sun packed into something you can barely see.',
    hintZh: '黑洞。恒星级的引力,压缩进一个你几乎看不见的点。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 450 },
    goal: { x: 1310, y: 450, r: 30 },
    bodies: [
      { type: 'blackhole', x: 700, y: 450, r: 26 },
      { type: 'moon', x: 700, y: 150, r: 28 },
      { type: 'moon', x: 700, y: 750, r: 28 },
    ],
    solution: { a: 0.47123889803846897, p: 413.4000000000001 },
  },

  {
    name: 'Push Off',
    nameZh: '借力一推',
    par: 3,
    hint: 'REPULSOR. Negative gravity. It will not catch you — it throws you.',
    hintZh: '斥力体。负引力,它不会吸住你,而是把你甩出去。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 450 },
    goal: { x: 1290, y: 760, r: 32 },
    bodies: [
      { type: 'repulsor', x: 640, y: 300, r: 52 },
      { type: 'planet', x: 1000, y: 380, r: 58 },
    ],
    solution: { a: 0.06981317007977317, p: 235.73333333333335 },
  },

  {
    name: 'Needle',
    nameZh: '穿针',
    par: 3,
    hint: 'The hole is small and the gap is smaller.',
    hintZh: '洞口很小,缝隙更小。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 450 },
    goal: { x: 1310, y: 470, r: 30 },
    bodies: [
      { type: 'planet', x: 500, y: 240, r: 58 },
      { type: 'blackhole', x: 860, y: 680, r: 22 },
      { type: 'moon', x: 1080, y: 240, r: 28 },
    ],
    solution: { a: -0.017453292519943295, p: 477.36 },
  },

  {
    name: 'Binary',
    nameZh: '双星',
    par: 3,
    hint: 'Dead centre is the only place their pull agrees to leave you alone.',
    hintZh: '只有正中央,两股引力才肯放你一马。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 450 },
    goal: { x: 1290, y: 450, r: 30 },
    bodies: [
      { type: 'blackhole', x: 640, y: 280, r: 22 },
      { type: 'blackhole', x: 640, y: 620, r: 22 },
    ],
    solution: { a: 0, p: 477.36 },
  },

  {
    name: 'Bank Shot',
    nameZh: '借壁反弹',
    par: 3,
    hint: 'Bounce off nothing at all. Fire past it and let it hand you back.',
    hintZh: '不撞任何东西也能反弹。从它身边飞过,让它把你送回来。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 200, y: 300 },
    goal: { x: 560, y: 800, r: 32 },
    bodies: [
      { type: 'repulsor', x: 900, y: 470, r: 58 },
      { type: 'moon', x: 780, y: 830, r: 26 },
    ],
    solution: { a: 0.8028514559173915, p: 193.09333333333333 },
  },

  {
    name: 'Carousel',
    nameZh: '旋转木马',
    par: 4,
    hint: 'That moon is moving. The clock starts when you let go.',
    hintZh: '那颗卫星在移动。你一松手,计时就开始了。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 450 },
    goal: { x: 1300, y: 450, r: 32 },
    bodies: [
      { type: 'planet', x: 720, y: 450, r: 54 },
      { type: 'moon', r: 30, orbit: { cx: 720, cy: 450, r: 250, w: 1.4, phase: -1.5707963267948966 } },
    ],
    solution: { a: 6.1086523819801535, p: 484.46666666666664 },
  },

  {
    name: 'Warp One',
    nameZh: '一号跃迁',
    par: 3,
    hint: 'WORMHOLE. In one mouth, out the other, same speed, same heading.',
    hintZh: '虫洞。从一端进,另一端出,速度和方向都不变。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 160, y: 790 },
    goal: { x: 1300, y: 150, r: 30 },
    bodies: [
      { type: 'wormhole', x: 470, y: 620, r: 32, link: 1 },
      { type: 'wormhole', x: 1010, y: 300, r: 32, link: 0 },
      { type: 'planet', x: 760, y: 810, r: 52 },
    ],
    solution: { a: 5.759586531581288, p: 477.36 },
  },

  {
    name: 'Fold',
    nameZh: '折叠',
    par: 4,
    hint: 'The short way across the field is through it.',
    hintZh: '穿过它,才是横跨全场的捷径。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 180 },
    goal: { x: 1290, y: 720, r: 30 },
    bodies: [
      { type: 'wormhole', x: 620, y: 180, r: 30, link: 1 },
      { type: 'wormhole', x: 620, y: 760, r: 30, link: 0 },
      { type: 'planet', x: 980, y: 450, r: 66 },
    ],
    solution: { a: -0.03490658503988659, p: 413.4000000000001 },
  },

  {
    name: 'Long Way Round',
    nameZh: '绕远路',
    par: 4,
    hint: 'Take the tunnel, then let the planet finish the job.',
    hintZh: '先钻隧道,再让行星帮你收尾。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 450 },
    goal: { x: 1250, y: 760, r: 30 },
    bodies: [
      { type: 'blackhole', x: 700, y: 300, r: 24 },
      { type: 'wormhole', x: 400, y: 780, r: 30, link: 2 },
      { type: 'wormhole', x: 1030, y: 170, r: 30, link: 1 },
      { type: 'planet', x: 900, y: 700, r: 50 },
    ],
    solution: { a: 1.0995574287564276, p: 249.9466666666667 },
  },

  {
    name: 'Gauntlet',
    nameZh: '试炼场',
    par: 5,
    hint: 'Everything at once, and the preview runs out early.',
    hintZh: '所有机关一起上阵,而且预测线早早就断了。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 450 },
    goal: { x: 1320, y: 450, r: 36 },
    bodies: [
      { type: 'planet', x: 430, y: 240, r: 52 },
      { type: 'repulsor', x: 700, y: 450, r: 40 },
      { type: 'blackhole', x: 990, y: 680, r: 22 },
      { type: 'moon', x: 1150, y: 230, r: 28 },
    ],
    solution: { a: 0.5585053606381855, p: 299.6933333333333 },
  },

  {
    name: 'Orrery',
    nameZh: '太阳仪',
    par: 4,
    hint: 'Two moons, two directions, one window.',
    hintZh: '两颗卫星,两个方向,只有一个时机。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 800 },
    goal: { x: 1300, y: 140, r: 36 },
    bodies: [
      { type: 'planet', x: 700, y: 450, r: 56 },
      { type: 'moon', r: 28, orbit: { cx: 700, cy: 450, r: 230, w: 1.6, phase: 0 } },
      { type: 'moon', r: 26, orbit: { cx: 700, cy: 450, r: 350, w: -1, phase: 2.4 } },
    ],
    solution: { a: 5.8643062867009474, p: 491.5733333333333 },
  },

  {
    name: 'Deep Field',
    nameZh: '深空',
    par: 5,
    hint: 'You have seen all of it. Now do it blind.',
    hintZh: '这些机关你都见过了,现在闭眼来一次。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 150 },
    goal: { x: 1300, y: 780, r: 34 },
    bodies: [
      { type: 'blackhole', x: 560, y: 430, r: 22 },
      { type: 'repulsor', x: 920, y: 300, r: 38 },
      { type: 'wormhole', x: 400, y: 810, r: 30, link: 3 },
      { type: 'wormhole', x: 1120, y: 170, r: 30, link: 2 },
      { type: 'moon', r: 28, orbit: { cx: 980, cy: 660, r: 190, w: -1.2, phase: 1.2 } },
    ],
    solution: { a: 6.14355896702004, p: 477.36 },
  },

  {
    name: 'Threading the Eye',
    nameZh: '穿眼',
    par: 4,
    hint: 'A blackhole guards the direct line. The gap beside it is real, but thin.',
    hintZh: '黑洞守着直线通道,旁边虽有缝隙,但很窄。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 450 },
    goal: { x: 1300, y: 450, r: 30 },
    bodies: [
      { type: 'blackhole', x: 720, y: 420, r: 24 },
      { type: 'planet', x: 720, y: 700, r: 46 },
    ],
    solution: { a: 5.869066275570023, p: 472.0300000000001 },
  },

  {
    name: 'Three-Body',
    nameZh: '三体',
    par: 5,
    hint: 'All three planets pull at once. Nothing here is a straight line.',
    hintZh: '三颗行星同时施力,这里没有一条直线。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 150, y: 780 },
    goal: { x: 1280, y: 160, r: 32 },
    bodies: [
      { type: 'planet', x: 520, y: 500, r: 54 },
      { type: 'planet', x: 900, y: 300, r: 50 },
      { type: 'planet', x: 1100, y: 650, r: 44 },
    ],
    solution: { a: 5.969026041820607, p: 477.36 },
  },

  {
    name: 'Relay',
    nameZh: '接力',
    par: 5,
    hint: 'Wormhole in, orbiting moon out. Time it or eat the planet.',
    hintZh: '虫洞入,环绕卫星出。掐准时机,否则就撞上行星。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 140, y: 200 },
    goal: { x: 1290, y: 800, r: 32 },
    bodies: [
      { type: 'wormhole', x: 560, y: 220, r: 30, link: 1 },
      { type: 'wormhole', x: 980, y: 620, r: 30, link: 0 },
      { type: 'planet', x: 1120, y: 300, r: 60 },
      { type: 'moon', r: 26, orbit: { cx: 700, cy: 700, r: 200, w: 1.3, phase: 0 } },
    ],
    solution: { a: 0.5426387310746006, p: 280.15 },
  },

  {
    name: 'Last Light',
    nameZh: '余晖',
    par: 6,
    hint: 'Everything you have learned, in one field.',
    hintZh: '你学到的一切,都汇集在这一场里。',
    bounds: { x: 0, y: 0, w: 1440, h: 900 },
    start: { x: 130, y: 450 },
    goal: { x: 1310, y: 450, r: 34 },
    bodies: [
      { type: 'repulsor', x: 420, y: 450, r: 40 },
      { type: 'blackhole', x: 780, y: 250, r: 22 },
      { type: 'wormhole', x: 760, y: 650, r: 28, link: 3 },
      { type: 'wormhole', x: 1080, y: 300, r: 28, link: 2 },
      { type: 'moon', r: 26, orbit: { cx: 900, cy: 600, r: 210, w: -0.9, phase: 1.0 } },
    ],
    solution: { a: 5.883346242177248, p: 200.20000000000002 },
  },
];

/** Sum of every hole's par — the number to beat for a round. */
export const TOTAL_PAR = HOLES.reduce((n, h) => n + h.par, 0);
