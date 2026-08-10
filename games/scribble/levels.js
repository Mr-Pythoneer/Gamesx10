// Scribble levels — pure data. No imports, no DOM, no functions in the exported shape.
//
// The world is a fixed 960x600 logical box (see WORLD_W / WORLD_H in physics.js); the
// renderer scales it to whatever canvas size it is handed, so nothing here is tied to
// a particular window size.
//
// Geometry:
//   walls  : [x1,y1,x2,y2] solid capsule segments. Ball AND ink collide with them.
//   spikes : [x1,y1,x2,y2] hazard segments. Only the ball cares; ink falls straight past.
//   ball   : where the ball hangs before you drop it.
//   goal   : circle. Ball centre inside it => level cleared.
//   ink    : how much stroke length you are allowed to have on screen at once.
//   par    : the "you found a better idea" target. Beating it is the replay hook.
//
// `solution` is a VERIFIED stroke script. Every one of them was replayed through the
// real stepSim() (same code the live game runs) and asserted to reach the goal — see
// registerSelftest('scribble', ...) in game.js. Format:
//   { strokes: [{ tool, points: [[x,y], ...] }, ...], settle, maxFrames }

const WALL_L = [0, -400, 0, 900];
const WALL_R = [960, -400, 960, 900];

export const LEVELS = [
  {
    name: 'First Line',
    hint: 'Drag to draw. What you draw is real. Get the ball into the well.',
    ink: 900,
    par: 560,
    ball: { x: 120, y: 70 },
    goal: { x: 897, y: 528, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [560, 500, 830, 500],
      [830, 500, 830, 560],
      [830, 560, 960, 560],
    ],
    spikes: [],
  },

  {
    name: 'Long Drop',
    hint: 'Nothing catches the ball but your own handwriting.',
    ink: 620,
    par: 300,
    ball: { x: 60, y: 160 },
    goal: { x: 910, y: 468, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 240, 300, 372],
      [620, 430, 860, 430],
      [860, 430, 860, 500],
      [860, 500, 960, 500],
    ],
    spikes: [[330, 566, 600, 566]],
  },

  {
    name: 'Chasm',
    hint: 'Ink 1 falls. Ink 2 is nailed to the world. Long spans want tool 2.',
    ink: 700,
    par: 430,
    ball: { x: 70, y: 210 },
    goal: { x: 920, y: 438, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 300, 240, 344],
      [700, 392, 880, 392],
      [880, 392, 880, 470],
      [880, 470, 960, 470],
    ],
    spikes: [[280, 566, 660, 566]],
  },

  {
    name: 'Underpass',
    hint: 'The slab is in the way. Get low early, then let gravity do the walking.',
    ink: 560,
    par: 260,
    ball: { x: 60, y: 110 },
    goal: { x: 910, y: 534, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 180, 220, 226],
      [420, -40, 420, 300],
      [420, 300, 720, 300],
      [460, 430, 860, 510],
      [860, 510, 860, 566],
      [860, 566, 960, 566],
    ],
    spikes: [[240, 566, 440, 566]],
  },

  {
    name: 'Seesaw',
    hint: 'That post is a fulcrum. A short plank plus one PIN beats a giant ramp.',
    ink: 560,
    par: 280,
    ball: { x: 60, y: 110 },
    goal: { x: 910, y: 508, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 180, 300, 244],
      [300, 470, 440, 470],
      [480, 540, 480, 352],
      [520, 470, 860, 470],
      [860, 470, 860, 540],
      [860, 540, 960, 540],
    ],
    spikes: [],
  },

  {
    name: 'Window',
    hint: 'One gap in the wall. Aim the ball through it.',
    ink: 480,
    par: 260,
    ball: { x: 60, y: 90 },
    goal: { x: 910, y: 508, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 140, 220, 190],
      [560, -40, 560, 290],
      [560, 400, 560, 470],
      [580, 470, 860, 470],
      [860, 470, 860, 540],
      [860, 540, 960, 540],
    ],
    spikes: [[240, 566, 540, 566]],
  },

  {
    name: 'Spike Span',
    hint: 'Dynamic ink sags into the spikes. Static ink does not.',
    ink: 620,
    par: 430,
    ball: { x: 60, y: 230 },
    goal: { x: 910, y: 438, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 300, 220, 344],
      [700, 400, 860, 400],
      [860, 400, 860, 470],
      [860, 470, 960, 470],
    ],
    spikes: [[240, 520, 690, 520]],
  },

  {
    name: 'Slot Machine',
    hint: 'Drop short and you land on spikes. Sail long and you land on spikes.',
    ink: 460,
    par: 230,
    ball: { x: 60, y: 90 },
    goal: { x: 710, y: 486, r: 56 },
    walls: [
      WALL_L, WALL_R,
      [0, 140, 200, 190],
      [600, 420, 600, 520],
      [600, 520, 820, 520],
      [820, 520, 820, 340],
    ],
    spikes: [[260, 436, 580, 436]],
  },

  {
    name: 'Stepping Stones',
    hint: 'Two gaps, one budget. Spend it where the ball actually needs it.',
    ink: 480,
    par: 300,
    ball: { x: 60, y: 190 },
    goal: { x: 910, y: 458, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 260, 200, 300],
      [380, 340, 560, 364],
      [740, 420, 860, 420],
      [860, 420, 860, 490],
      [860, 490, 960, 490],
    ],
    spikes: [[210, 566, 730, 566]],
  },

  {
    name: 'Descent',
    hint: 'Shelves all the way down. Short hops cost less than long ones.',
    ink: 420,
    par: 220,
    ball: { x: 70, y: 80 },
    goal: { x: 900, y: 478, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [60, 180, 300, 210],
      [420, 300, 560, 326],
      [660, 410, 830, 440],
      [830, 440, 830, 510],
      [830, 510, 960, 510],
    ],
    spikes: [[120, 566, 800, 566]],
  },

  {
    name: 'Needle',
    hint: 'Almost no ink. One flick of the wrist is the whole level.',
    ink: 260,
    par: 120,
    ball: { x: 410, y: 50 },
    goal: { x: 890, y: 552, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [300, -40, 300, 300],
      [520, -40, 520, 300],
      [520, 440, 820, 520],
      [820, 520, 820, 580],
      [820, 580, 960, 580],
    ],
    spikes: [[310, 566, 500, 566]],
  },

  {
    name: 'Handwriting',
    hint: 'Everything you learned, and barely enough ink to say it.',
    ink: 470,
    par: 340,
    ball: { x: 60, y: 80 },
    goal: { x: 910, y: 478, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [0, 150, 170, 190],
      [400, 320, 540, 344],
      [660, 420, 830, 440],
      [830, 440, 830, 510],
      [830, 510, 960, 510],
    ],
    spikes: [[190, 566, 650, 566]],
  },
];

// ---------------------------------------------------------------- verified solutions
//
// Each script below was found/refined by replaying candidates through the real physics
// (pure stepSim, fixed dt, no randomness) and confirming sim.status === 'won' inside the
// level's ink budget. window.__selftest() replays all twelve on every run, so "this game
// is completable" is a machine-checked claim rather than a designer's hope.

const SOLUTIONS = {
  0: { strokes: [{ tool: 'static', points: [[30, 240], [600, 470]] }] },                   // 611 ink
  1: { strokes: [{ tool: 'static', points: [[300, 376], [640, 424]] }] },                  // 343 ink
  2: { strokes: [{ tool: 'static', points: [[240, 348], [706, 388]] }] },                  // 468 ink
  3: { strokes: [{ tool: 'static', points: [[220, 232], [455, 425]] }] },                  // 304 ink
  4: { strokes: [{ tool: 'static', points: [[330, 250], [740, 440]] }] },                  // 452 ink
  5: { strokes: [{ tool: 'static', points: [[220, 194], [520, 330]] }] },                  // 325 ink
  6: { strokes: [{ tool: 'static', points: [[220, 348], [706, 396]] }] },                  // 488 ink
  7: { strokes: [{ tool: 'static', points: [[200, 190], [460, 300]] }] },                  // 282 ink
  8: {
    strokes: [
      { tool: 'static', points: [[200, 304], [384, 340]] },
      { tool: 'static', points: [[560, 366], [744, 418]] },
    ],
  },                                                                                       // 379 ink
  9: {
    strokes: [
      { tool: 'static', points: [[300, 212], [424, 300]] },
      { tool: 'static', points: [[560, 328], [664, 412]] },
    ],
  },                                                                                       // 282 ink
  10: { strokes: [{ tool: 'static', points: [[380, 340], [500, 430]] }] },                 // 150 ink
  11: {
    strokes: [
      { tool: 'static', points: [[170, 194], [404, 320]] },
      { tool: 'static', points: [[540, 346], [664, 420]] },
    ],
  },                                                                                       // 409 ink
};

for (let i = 0; i < LEVELS.length; i++) {
  const s = SOLUTIONS[i];
  LEVELS[i].solution = s ? { settle: 30, maxFrames: 900, ...s } : null;
}

export default LEVELS;
