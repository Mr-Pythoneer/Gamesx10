// Afterimage — hand-designed levels. Every level's `solution` is machine-verified by
// the throwaway harness used during development (see game.js self-test, which replays
// these at runtime) — unsolvable levels are deleted, never shipped.
//
// Grid legend:
//   # solid wall        . empty          ^ spike (deadly)
//   S spawn              G goal           _ one-way ledge (land on top, pass from below)
//   1-4 pressure plate (one-way top; weighted by player OR any visible ghost)
//   a-d door (matches plate 1-4; solid unless its plate is weighted; ghosts always pass through)

// A `solution` is an array of runs; each run is an array of [frames, mask] RLE pairs
// (mask bits: 1=left, 2=right, 4=jump). A run that ends without dying or reaching the
// goal is a manual retry — exactly what pressing R does live. Verified by node.js in
// development (see report) and re-verified every load by the in-browser self-test.
export const LEVELS = [
  {
    name: 'First Echo', nameZh: '第一声回响',
    hint: 'Stand on the plate, then retry — your ghost will hold it for you.',
    hintZh: '站到压力板上,然后重试——你的幻影会替你按住它。',
    par: 1,
    grid: [
      '####################',
      '#........#.........#',
      '#........#.........#',
      '#........#.........#',
      '#S....1..a.......G.#',
      '####################',
    ],
    solution: [
      [[55, 2], [40, 0]],
      [[40, 2], [12, 6], [8, 2], [200, 2]],
    ],
  },
  {
    name: 'Stepping Stone', nameZh: '垫脚石',
    hint: 'A ghost standing still is still standing. Climb it.',
    hintZh: '静止不动的幻影仍然站在那里。踩上去。',
    par: 1,
    grid: [
      '####################',
      '#..................#',
      '#..................#',
      '#.........G........#',
      '#.........##.......#',
      '#.........##.......#',
      '#S........##.......#',
      '####################',
    ],
    solution: [
      [[56, 2], [2, 0]],
      [[11, 0], [14, 6], [15, 2], [6, 0], [13, 6], [21, 2], [31, 6]],
    ],
  },
  {
    name: 'Two Hands', nameZh: '两只手',
    hint: 'Hop onto a ledge plate, then retry. Two ghosts, two doors.',
    hintZh: '跳上压力板,然后重试。两个幻影,两扇门。',
    par: 2,
    grid: [
      '##################################',
      '#.......#.............#..........#',
      '#...11..#........22...#..........#',
      '#S......a.............b........G.#',
      '##################################',
      '##################################',
    ],
    solution: [
      [[23, 2], [25, 6], [20, 0]],
      [[168, 2], [15, 6], [20, 0]],
      [[319, 2]],
    ],
  },
  {
    name: 'Three of a Kind', nameZh: '三重奏',
    hint: 'Two ledges to hold the doors, one more to boost you over the last wall.',
    hintZh: '两个幻影按住两扇门,再多一个把你顶过最后那堵墙。',
    par: 3,
    grid: [
      '##########################################',
      '#.......#.............#.............G....#',
      '#...11..#........22...#............##....#',
      '#S......a.............b............##....#',
      '##########################################',
      '#.......#.............#..................#',
      '#.......#.............#..................#',
      '##########################################',
    ],
    solution: [
      [[23, 2], [25, 6], [20, 0]],
      [[168, 2], [15, 6], [20, 0]],
      [[352, 2], [15, 0]],
      [[340, 2], [14, 6], [25, 2], [14, 6], [10, 2]],
    ],
  },
];
