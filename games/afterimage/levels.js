// Afterimage — hand-designed levels. Every level's `solution` is machine-verified by
// the throwaway harness used during development (see game.js self-test, which replays
// these at runtime) — unsolvable levels are deleted, never shipped.
//
// Grid legend:
//   # solid wall        . empty          ^ spike (deadly)
//   S spawn              G goal           _ one-way ledge (land on top, pass from below)
//   1-4 pressure plate (one-way top; weighted by player OR any visible ghost)
//   a-d door (matches plate 1-4; solid unless its plate is weighted; ghosts always pass through)

export const LEVELS = [
  {
    name: 'First Echo',
    hint: 'Stand on the plate, then retry — your ghost will hold it for you.',
    par: 1,
    grid: [
      '####################',
      '#..................#',
      '#..................#',
      '#..................#',
      '#S....1..a.......G.#',
      '####################',
    ],
  },
  {
    name: 'Stepping Stone',
    hint: 'A ghost standing still is still standing. Climb it.',
    par: 1,
    grid: [
      '####################',
      '#..................#',
      '#..................#',
      '#..................#',
      '#.........G........#',
      '#.........##.......#',
      '#S........##.......#',
      '####################',
    ],
  },
  {
    name: 'Two Hands',
    hint: 'Hop onto a ledge plate, then retry. Two ghosts, two doors.',
    par: 2,
    grid: [
      '##################################',
      '#................................#',
      '#...11...........22..............#',
      '#S......a.............b........G.#',
      '##################################',
      '##################################',
    ],
  },
];
