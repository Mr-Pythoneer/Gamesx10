// Mirrorbind levels.
//
// Grid legend:  # solid   . empty   ^ spike (deadly)   S spawn   E exit
//
// Each level has 2-3 "worlds". One set of keys drives every world at once, but each
// world applies its own transform to your input:
//   flipX   — left/right are swapped
//   flipY   — gravity points up; jump goes down
//
// `solution` is a verified input script, discovered by the built-in BFS solver
// (see solve() in game.js) and replayed by window.__selftest() to prove the level
// is beatable. Format: [[frames, mask], ...] where mask bits are 1=left 2=right 4=jump.

export const LEVELS = [
  {
    name: 'Bound',
    hint: 'One set of keys. Two of you. Get both to the exit.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#S.........E#',
          '#############',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#E.........S#',
          '#############',
        ],
      },
    ],
  },

  {
    name: 'Gap',
    hint: 'Jump is the one thing you both agree on.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#S.........E#',
          '####...######',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#E.........S#',
          '######...####',
        ],
      },
    ],
  },

  {
    name: 'Offset',
    hint: 'The holes no longer line up. Find the window that clears both.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#S.........E#',
          '###...#######',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#E.........S#',
          '#######...###',
        ],
      },
    ],
  },

  {
    name: 'Spike',
    hint: 'Spikes kill instantly. Both of you die when either of you does.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#....###....#',
          '#S..^...^..E#',
          '#############',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#....###....#',
          '#E..^...^..S#',
          '#############',
        ],
      },
    ],
  },

  {
    name: 'Stair',
    hint: 'One of you climbs. The other has to survive the same jumps.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#..........E#',
          '#.........###',
          '#.......##..#',
          '#.....##....#',
          '#S..##......#',
          '#############',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#E..........#',
          '###.........#',
          '#..##.......#',
          '#....##.....#',
          '#......##..S#',
          '#############',
        ],
      },
    ],
  },

  {
    name: 'Ceiling',
    hint: 'Low roof on one side. Jump in the wrong place and you crack your head.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#......###..#',
          '#...........#',
          '#...........#',
          '#S.........E#',
          '####..#######',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#..###......#',
          '#...........#',
          '#...........#',
          '#E.........S#',
          '#######..####',
        ],
      },
    ],
  },

  {
    name: 'Pillar',
    hint: 'Nothing is symmetric any more.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#....#......#',
          '#....#......#',
          '#....#..^...#',
          '#S..........E',
          '#############',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#.......#...#',
          '#.......#...#',
          '#...^...#...#',
          'E..........S#',
          '#############',
        ],
      },
    ],
  },

  {
    name: 'Upside',
    hint: 'A third you, and gravity has opinions. Jump pushes them at the ceiling.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#S.........E#',
          '#############',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#E.........S#',
          '#############',
        ],
      },
      {
        flipX: false,
        flipY: true,
        grid: [
          '#############',
          '#S.........E#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#############',
        ],
      },
    ],
  },

  {
    name: 'Inverted',
    hint: 'Three of you now. The ceiling world has a gap too.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#S.........E#',
          '####...######',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#E.........S#',
          '######...####',
        ],
      },
      {
        flipX: false,
        flipY: true,
        grid: [
          '#####...#####',
          '#S.........E#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#############',
        ],
      },
    ],
  },

  {
    name: 'Bindfast',
    hint: 'Two of you go one way, one goes the other, and the ceiling has a hole.',
    worlds: [
      {
        flipX: false,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#..........E#',
          '#.........###',
          '#S..........#',
          '####..#######',
        ],
      },
      {
        flipX: true,
        grid: [
          '#############',
          '#...........#',
          '#...........#',
          '#E..........#',
          '###.........#',
          '#..........S#',
          '#######..####',
        ],
      },
      {
        flipX: true,
        flipY: true,
        grid: [
          '######..#####',
          '#E.........S#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#...........#',
          '#############',
        ],
      },
    ],
  },
];

// Verified winning input scripts. Discovered by solve() in game.js (weighted best-first
// search over the same stepSim the live game uses), then replayed by window.__selftest()
// so "every level is beatable" is a machine-checked claim, not a designer's hope.
// Format: [[frames, mask], ...] — mask bits 1=left 2=right 4=jump.
const SOLUTIONS = {
  0: [[110, 2], [5, 0]],
  1: [[35, 2], [5, 6], [20, 2], [5, 6], [45, 2], [5, 0]],
  2: [[25, 2], [5, 6], [80, 2], [5, 0]],
  3: [[25, 2], [15, 6], [70, 2], [5, 0]],
  4: [[25, 6], [5, 2], [5, 6], [5, 2], [20, 6], [15, 2], [5, 4], [15, 6], [10, 2], [10, 6], [5, 2], [5, 6], [5, 2], [5, 0]],
  5: [[35, 2], [5, 6], [20, 2], [5, 6], [45, 2], [5, 0]],
  6: [[40, 2], [5, 6], [75, 2], [5, 0]],
  7: [[110, 2], [5, 0]],
  8: [[35, 2], [15, 6], [60, 2], [5, 0]],
  9: [[10, 6], [25, 2], [10, 6], [25, 2], [10, 6], [25, 2], [5, 5], [10, 6], [15, 2], [5, 0]],
};

for (let i = 0; i < LEVELS.length; i++) LEVELS[i].solution = SOLUTIONS[i] || null;

export default LEVELS;
