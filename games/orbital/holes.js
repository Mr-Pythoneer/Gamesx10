// Orbital — 18 hand-authored holes.
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
    par: 2,
    hint: 'Drag back from the probe and let go. Straight lines do not survive gravity.',
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
    par: 2,
    hint: 'Falling toward a planet is free speed. Falling into one is not.',
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
    par: 2,
    hint: 'Two equal pulls cancel. Split the difference.',
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
    par: 2,
    hint: 'Moons nudge. Planets shove.',
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
    par: 2,
    hint: 'You cannot go through it. Go around and let it reel you back.',
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
    par: 2,
    hint: 'Three wells, one lane. Read the whole curve before you let go.',
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
    par: 3,
    hint: 'BLACK HOLE. All the pull of a sun packed into something you can barely see.',
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
    par: 3,
    hint: 'REPULSOR. Negative gravity. It will not catch you — it throws you.',
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
    par: 3,
    hint: 'The hole is small and the gap is smaller.',
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
    par: 3,
    hint: 'Dead centre is the only place their pull agrees to leave you alone.',
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
    par: 3,
    hint: 'Bounce off nothing at all. Fire past it and let it hand you back.',
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
    par: 4,
    hint: 'That moon is moving. The clock starts when you let go.',
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
    par: 3,
    hint: 'WORMHOLE. In one mouth, out the other, same speed, same heading.',
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
    par: 4,
    hint: 'The short way across the field is through it.',
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
    par: 4,
    hint: 'Take the tunnel, then let the planet finish the job.',
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
    par: 5,
    hint: 'Everything at once, and the preview runs out early.',
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
    par: 4,
    hint: 'Two moons, two directions, one window.',
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
    par: 5,
    hint: 'You have seen all of it. Now do it blind.',
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
];

/** Sum of every hole's par — the number to beat for a round. */
export const TOTAL_PAR = HOLES.reduce((n, h) => n + h.par, 0);
