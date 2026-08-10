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
    nameZh: '起笔',
    hint: 'Drag to draw. What you draw is real. Get the ball into the well.',
    hintZh: '拖动来画线,画出来的东西就是真实的。让球掉进井里。',
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
    nameZh: '长空坠落',
    hint: 'Nothing catches the ball but your own handwriting.',
    hintZh: '除了你自己画的线,没有什么能接住球。',
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
    nameZh: '深渊',
    hint: 'Ink 1 falls. Ink 2 is nailed to the world. Long spans want tool 2.',
    hintZh: '墨水1会掉落。墨水2固定在世界上。长跨度用工具2。',
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
    nameZh: '地下通道',
    hint: 'The slab is in the way. Get low early, then let gravity do the walking.',
    hintZh: '石板挡住了路。早点降低高度,剩下的交给重力。',
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
    nameZh: '跷跷板',
    hint: 'That post is a fulcrum. A short plank plus one PIN beats a giant ramp.',
    hintZh: '那根柱子是支点。一块短木板加一颗钉子胜过一条长坡道。',
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
    nameZh: '窗口',
    hint: 'One gap in the wall. Aim the ball through it.',
    hintZh: '墙上只有一个缺口。瞄准让球穿过去。',
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
    nameZh: '尖刺跨越',
    hint: 'Dynamic ink sags into the spikes. Static ink does not.',
    hintZh: '会掉落的墨水会垂进尖刺里,固定的墨水不会。',
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
    nameZh: '老虎机',
    hint: 'Drop short and you land on spikes. Sail long and you land on spikes.',
    hintZh: '掉得太短会落在尖刺上,飞得太远也会落在尖刺上。',
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
    nameZh: '垫脚石',
    hint: 'Two gaps, one budget. Spend it where the ball actually needs it.',
    hintZh: '两个缺口,一份预算。把墨水花在球真正需要的地方。',
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
    nameZh: '下降',
    hint: 'Shelves all the way down. Short hops cost less than long ones.',
    hintZh: '一路都是台阶。短跳比长跳更省墨水。',
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
    nameZh: '针眼',
    hint: 'Almost no ink. One flick of the wrist is the whole level.',
    hintZh: '几乎没有墨水。手腕轻轻一挥就是整关。',
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
    nameZh: '笔迹',
    hint: 'Everything you learned, and barely enough ink to say it.',
    hintZh: '把学到的一切用上,墨水却几乎不够。',
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

  {
    name: 'Fresh Ink',
    nameZh: '新墨',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 980,
    par: 559,
    ball: { x: 90, y: 124 },
    goal: { x: 914, y: 466, r: 54 },
    walls: [
      WALL_L, WALL_R,
      [632, 399, 849, 399],
      [849, 399, 849, 498],
      [849, 498, 960, 498]
    ],
    spikes: [],
  },

  {
    name: 'Straight Shot',
    nameZh: '直线一击',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 1110,
    par: 641,
    ball: { x: 58, y: 191 },
    goal: { x: 919, y: 511, r: 54 },
    walls: [
      WALL_L, WALL_R,
      [699, 464, 863, 464],
      [863, 464, 863, 546],
      [863, 546, 960, 546]
    ],
    spikes: [],
  },

  {
    name: 'One Breath',
    nameZh: '一气呵成',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 1090,
    par: 637,
    ball: { x: 65, y: 125 },
    goal: { x: 908, y: 518, r: 55 },
    walls: [
      WALL_L, WALL_R,
      [678, 448, 859, 448],
      [859, 448, 859, 547],
      [859, 547, 960, 547]
    ],
    spikes: [],
  },

  {
    name: 'Clean Line',
    nameZh: '干净的线',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 1060,
    par: 623,
    ball: { x: 64, y: 104 },
    goal: { x: 906, y: 478, r: 54 },
    walls: [
      WALL_L, WALL_R,
      [657, 431, 865, 431],
      [865, 431, 865, 510],
      [865, 510, 960, 510]
    ],
    spikes: [[47, 566, 667, 566]],
  },

  {
    name: 'No Detours',
    nameZh: '不绕路',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 1090,
    par: 647,
    ball: { x: 66, y: 113 },
    goal: { x: 899, y: 453, r: 54 },
    walls: [
      WALL_L, WALL_R,
      [703, 411, 853, 411],
      [853, 411, 853, 482],
      [853, 482, 960, 482]
    ],
    spikes: [],
  },

  {
    name: 'Steady Hand',
    nameZh: '稳手',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 900,
    par: 537,
    ball: { x: 62, y: 196 },
    goal: { x: 885, y: 536, r: 51 },
    walls: [
      WALL_L, WALL_R,
      [570, 483, 785, 483],
      [785, 483, 785, 569],
      [785, 569, 960, 569]
    ],
    spikes: [],
  },

  {
    name: 'Fresh Ink',
    nameZh: '新墨',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 920,
    par: 554,
    ball: { x: 68, y: 203 },
    goal: { x: 912, y: 474, r: 54 },
    walls: [
      WALL_L, WALL_R,
      [632, 413, 848, 413],
      [848, 413, 848, 502],
      [848, 502, 960, 502]
    ],
    spikes: [],
  },

  {
    name: 'Straight Shot',
    nameZh: '直线一击',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 960,
    par: 584,
    ball: { x: 65, y: 161 },
    goal: { x: 899, y: 498, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [641, 428, 822, 428],
      [822, 428, 822, 527],
      [822, 527, 960, 527]
    ],
    spikes: [[48, 566, 656, 566]],
  },

  {
    name: 'One Breath',
    nameZh: '一气呵成',
    hint: 'One stroke, start to finish. Aim it well.',
    hintZh: '一笔到底,瞄准就好。',
    ink: 1050,
    par: 645,
    ball: { x: 80, y: 62 },
    goal: { x: 891, y: 516, r: 53 },
    walls: [
      WALL_L, WALL_R,
      [639, 485, 786, 485],
      [786, 485, 786, 547],
      [786, 547, 960, 547]
    ],
    spikes: [],
  },

  {
    name: 'Two-Part Harmony',
    nameZh: '两段和声',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 900,
    par: 559,
    ball: { x: 55, y: 82 },
    goal: { x: 866, y: 500, r: 51 },
    walls: [
      WALL_L, WALL_R,
      [145, 292, 291, 326],
      [655, 432, 796, 432],
      [796, 432, 796, 531],
      [796, 531, 960, 531]
    ],
    spikes: [],
  },

  {
    name: 'Broken Ground',
    nameZh: '断裂的地面',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 760,
    par: 478,
    ball: { x: 88, y: 116 },
    goal: { x: 880, y: 490, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [178, 330, 357, 370],
      [631, 456, 805, 456],
      [805, 456, 805, 517],
      [805, 517, 960, 517]
    ],
    spikes: [],
  },

  {
    name: 'Relay',
    nameZh: '接力',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 830,
    par: 525,
    ball: { x: 76, y: 185 },
    goal: { x: 897, y: 506, r: 52 },
    walls: [
      WALL_L, WALL_R,
      [166, 361, 262, 380],
      [628, 451, 818, 451],
      [818, 451, 818, 536],
      [818, 536, 960, 536]
    ],
    spikes: [],
  },

  {
    name: 'Waystations',
    nameZh: '中途站',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 600,
    par: 385,
    ball: { x: 85, y: 160 },
    goal: { x: 918, y: 463, r: 51 },
    walls: [
      WALL_L, WALL_R,
      [175, 321, 347, 345],
      [437, 356, 573, 403],
      [715, 422, 855, 422],
      [855, 422, 855, 493],
      [855, 493, 960, 493]
    ],
    spikes: [[71, 566, 187, 566]],
  },

  {
    name: 'Landings',
    nameZh: '落脚点',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 820,
    par: 530,
    ball: { x: 63, y: 157 },
    goal: { x: 896, y: 483, r: 49 },
    walls: [
      WALL_L, WALL_R,
      [164, 342, 259, 367],
      [616, 446, 803, 446],
      [803, 446, 803, 511],
      [803, 511, 960, 511]
    ],
    spikes: [],
  },

  {
    name: 'Split Route',
    nameZh: '分段路线',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 780,
    par: 511,
    ball: { x: 75, y: 154 },
    goal: { x: 909, y: 493, r: 49 },
    walls: [
      WALL_L, WALL_R,
      [166, 339, 303, 354],
      [643, 432, 833, 432],
      [833, 432, 833, 522],
      [833, 522, 960, 522]
    ],
    spikes: [[296, 566, 655, 566]],
  },

  {
    name: 'Checkpoints',
    nameZh: '检查点',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 890,
    par: 589,
    ball: { x: 56, y: 98 },
    goal: { x: 903, y: 482, r: 48 },
    walls: [
      WALL_L, WALL_R,
      [165, 308, 279, 336],
      [671, 432, 831, 432],
      [831, 432, 831, 513],
      [831, 513, 960, 513]
    ],
    spikes: [[270, 566, 679, 566]],
  },

  {
    name: 'Terraces',
    nameZh: '台地',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 600,
    par: 399,
    ball: { x: 68, y: 160 },
    goal: { x: 909, y: 470, r: 49 },
    walls: [
      WALL_L, WALL_R,
      [158, 319, 305, 353],
      [395, 335, 511, 362],
      [664, 405, 840, 405],
      [840, 405, 840, 497],
      [840, 497, 960, 497]
    ],
    spikes: [[52, 566, 163, 566]],
  },

  {
    name: 'Two-Part Harmony',
    nameZh: '两段和声',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 840,
    par: 564,
    ball: { x: 88, y: 75 },
    goal: { x: 910, y: 463, r: 50 },
    walls: [
      WALL_L, WALL_R,
      [178, 279, 276, 312],
      [653, 414, 851, 414],
      [851, 414, 851, 492],
      [851, 492, 960, 492]
    ],
    spikes: [],
  },

  {
    name: 'Broken Ground',
    nameZh: '断裂的地面',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 770,
    par: 520,
    ball: { x: 89, y: 149 },
    goal: { x: 908, y: 534, r: 49 },
    walls: [
      WALL_L, WALL_R,
      [179, 344, 351, 374],
      [684, 482, 843, 482],
      [843, 482, 843, 563],
      [843, 563, 960, 563]
    ],
    spikes: [],
  },

  {
    name: 'Relay',
    nameZh: '接力',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 680,
    par: 467,
    ball: { x: 63, y: 152 },
    goal: { x: 886, y: 533, r: 49 },
    walls: [
      WALL_L, WALL_R,
      [153, 326, 249, 345],
      [339, 384, 455, 415],
      [658, 480, 828, 480],
      [828, 480, 828, 565],
      [828, 565, 960, 565]
    ],
    spikes: [],
  },

  {
    name: 'Waystations',
    nameZh: '中途站',
    hint: 'Each gap wants its own stroke. Spend ink where the ball actually needs it.',
    hintZh: '每个缺口都需要单独一笔,把墨水花在球真正需要的地方。',
    ink: 840,
    par: 583,
    ball: { x: 75, y: 102 },
    goal: { x: 899, y: 508, r: 46 },
    walls: [
      WALL_L, WALL_R,
      [171, 310, 295, 324],
      [677, 458, 823, 458],
      [823, 458, 823, 533],
      [823, 533, 960, 533]
    ],
    spikes: [],
  },

  {
    name: 'Narrow Margins',
    nameZh: '窄边距',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 700,
    par: 488,
    ball: { x: 69, y: 200 },
    goal: { x: 905, y: 507, r: 45 },
    walls: [
      WALL_L, WALL_R,
      [159, 357, 262, 375],
      [352, 396, 456, 422],
      [708, 473, 861, 473],
      [861, 473, 861, 535],
      [861, 535, 960, 535]
    ],
    spikes: [[59, 566, 169, 566], [448, 566, 718, 566]],
  },

  {
    name: 'No Room for Error',
    nameZh: '容不得半点差错',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 580,
    par: 411,
    ball: { x: 73, y: 122 },
    goal: { x: 905, y: 500, r: 46 },
    walls: [
      WALL_L, WALL_R,
      [171, 296, 344, 311],
      [434, 351, 558, 372],
      [690, 439, 850, 439],
      [850, 439, 850, 525],
      [850, 525, 960, 525]
    ],
    spikes: [[65, 566, 182, 566], [335, 566, 444, 566], [551, 566, 710, 566]],
  },

  {
    name: 'Thread the Gap',
    nameZh: '穿过缝隙',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 580,
    par: 416,
    ball: { x: 73, y: 72 },
    goal: { x: 891, y: 510, r: 48 },
    walls: [
      WALL_L, WALL_R,
      [166, 261, 337, 291],
      [427, 345, 529, 384],
      [648, 451, 806, 451],
      [806, 451, 806, 536],
      [806, 536, 960, 536]
    ],
    spikes: [[61, 566, 178, 566], [321, 566, 445, 566], [516, 566, 661, 566]],
  },

  {
    name: 'Sharpened Path',
    nameZh: '磨尖的路',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 530,
    par: 384,
    ball: { x: 76, y: 142 },
    goal: { x: 898, y: 495, r: 46 },
    walls: [
      WALL_L, WALL_R,
      [169, 317, 291, 335],
      [381, 360, 504, 396],
      [625, 431, 815, 431],
      [815, 431, 815, 524],
      [815, 524, 960, 524]
    ],
    spikes: [[66, 566, 189, 566], [494, 566, 640, 566]],
  },

  {
    name: 'Close Call',
    nameZh: '千钧一发',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 800,
    par: 585,
    ball: { x: 54, y: 82 },
    goal: { x: 919, y: 494, r: 48 },
    walls: [
      WALL_L, WALL_R,
      [159, 302, 254, 344],
      [631, 450, 855, 450],
      [855, 450, 855, 519],
      [855, 519, 960, 519]
    ],
    spikes: [[241, 566, 650, 566]],
  },

  {
    name: 'Between the Teeth',
    nameZh: '牙缝之间',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 730,
    par: 543,
    ball: { x: 76, y: 140 },
    goal: { x: 909, y: 528, r: 46 },
    walls: [
      WALL_L, WALL_R,
      [171, 340, 286, 356],
      [638, 465, 866, 465],
      [866, 465, 866, 553],
      [866, 553, 960, 553]
    ],
    spikes: [[68, 566, 190, 566], [272, 566, 644, 566]],
  },

  {
    name: 'Tightrope',
    nameZh: '走钢丝',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 630,
    par: 469,
    ball: { x: 56, y: 209 },
    goal: { x: 878, y: 501, r: 47 },
    walls: [
      WALL_L, WALL_R,
      [160, 366, 317, 388],
      [634, 443, 819, 443],
      [819, 443, 819, 530],
      [819, 530, 960, 530]
    ],
    spikes: [[43, 566, 178, 566], [307, 566, 648, 566]],
  },

  {
    name: 'Razor\'s Edge',
    nameZh: '刀刃之上',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 680,
    par: 513,
    ball: { x: 90, y: 202 },
    goal: { x: 904, y: 473, r: 46 },
    walls: [
      WALL_L, WALL_R,
      [187, 347, 284, 379],
      [666, 411, 822, 411],
      [822, 411, 822, 503],
      [822, 503, 960, 503]
    ],
    spikes: [[70, 566, 192, 566]],
  },

  {
    name: 'Narrow Margins',
    nameZh: '窄边距',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 620,
    par: 474,
    ball: { x: 69, y: 71 },
    goal: { x: 876, y: 506, r: 44 },
    walls: [
      WALL_L, WALL_R,
      [166, 297, 342, 333],
      [582, 454, 791, 454],
      [791, 454, 791, 534],
      [791, 534, 960, 534]
    ],
    spikes: [[56, 566, 180, 566], [323, 566, 590, 566]],
  },

  {
    name: 'No Room for Error',
    nameZh: '容不得半点差错',
    hint: 'The spikes do not forgive a short ramp or a long one.',
    hintZh: '尖刺不会放过太短或太长的坡道。',
    ink: 710,
    par: 554,
    ball: { x: 66, y: 68 },
    goal: { x: 891, y: 470, r: 45 },
    walls: [
      WALL_L, WALL_R,
      [161, 266, 318, 294],
      [684, 406, 834, 406],
      [834, 406, 834, 493],
      [834, 493, 960, 493]
    ],
    spikes: [[51, 566, 167, 566], [308, 566, 698, 566]],
  },

  {
    name: 'Last Drop',
    nameZh: '最后一滴',
    hint: 'Barely enough ink to say what you mean.',
    hintZh: '墨水几乎不够,但足以表达清楚。',
    ink: 570,
    par: 449,
    ball: { x: 73, y: 117 },
    goal: { x: 899, y: 519, r: 42 },
    walls: [
      WALL_L, WALL_R,
      [163, 296, 280, 340],
      [370, 359, 484, 380],
      [660, 465, 819, 465],
      [819, 465, 819, 544],
      [819, 544, 960, 544]
    ],
    spikes: [],
  },

  {
    name: 'Thin Margin',
    nameZh: '薄利',
    hint: 'Barely enough ink to say what you mean.',
    hintZh: '墨水几乎不够,但足以表达清楚。',
    ink: 560,
    par: 422,
    ball: { x: 61, y: 174 },
    goal: { x: 897, y: 506, r: 44 },
    walls: [
      WALL_L, WALL_R,
      [151, 339, 243, 373],
      [333, 381, 499, 396],
      [667, 462, 817, 462],
      [817, 462, 817, 530],
      [817, 530, 960, 530]
    ],
    spikes: [[46, 566, 167, 566], [227, 566, 340, 566], [483, 566, 675, 566]],
  },

  {
    name: 'Final Ink',
    nameZh: '最后的墨水',
    hint: 'Barely enough ink to say what you mean.',
    hintZh: '墨水几乎不够,但足以表达清楚。',
    ink: 550,
    par: 418,
    ball: { x: 63, y: 93 },
    goal: { x: 892, y: 538, r: 42 },
    walls: [
      WALL_L, WALL_R,
      [153, 292, 310, 306],
      [400, 355, 562, 397],
      [669, 476, 814, 476],
      [814, 476, 814, 562],
      [814, 562, 960, 562]
    ],
    spikes: [[56, 566, 170, 566], [543, 566, 686, 566]],
  },

  {
    name: 'Vanishing Budget',
    nameZh: '预算耗尽',
    hint: 'Barely enough ink to say what you mean.',
    hintZh: '墨水几乎不够,但足以表达清楚。',
    ink: 525,
    par: 422,
    ball: { x: 86, y: 67 },
    goal: { x: 886, y: 517, r: 45 },
    walls: [
      WALL_L, WALL_R,
      [176, 254, 322, 284],
      [412, 343, 502, 379],
      [625, 453, 787, 453],
      [787, 453, 787, 544],
      [787, 544, 960, 544]
    ],
    spikes: [[74, 566, 183, 566], [304, 566, 430, 566]],
  },

  {
    name: 'The Smallest Line',
    nameZh: '最短的线',
    hint: 'Barely enough ink to say what you mean.',
    hintZh: '墨水几乎不够,但足以表达清楚。',
    ink: 510,
    par: 402,
    ball: { x: 65, y: 86 },
    goal: { x: 911, y: 490, r: 43 },
    walls: [
      WALL_L, WALL_R,
      [155, 258, 274, 281],
      [364, 325, 504, 372],
      [637, 423, 846, 423],
      [846, 423, 846, 514],
      [846, 514, 960, 514]
    ],
    spikes: [[54, 566, 175, 566], [266, 566, 378, 566], [490, 566, 656, 566]],
  },

  {
    name: 'No Second Stroke',
    nameZh: '没有第二笔',
    hint: 'Barely enough ink to say what you mean.',
    hintZh: '墨水几乎不够,但足以表达清楚。',
    ink: 510,
    par: 404,
    ball: { x: 70, y: 192 },
    goal: { x: 909, y: 538, r: 41 },
    walls: [
      WALL_L, WALL_R,
      [160, 356, 328, 392],
      [418, 398, 569, 426],
      [723, 476, 864, 476],
      [864, 476, 864, 564],
      [864, 564, 960, 564]
    ],
    spikes: [[60, 566, 176, 566], [316, 566, 427, 566], [553, 566, 738, 566]],
  },

  {
    name: 'Endgame',
    nameZh: '终局',
    hint: 'Barely enough ink to say what you mean.',
    hintZh: '墨水几乎不够,但足以表达清楚。',
    ink: 510,
    par: 428,
    ball: { x: 52, y: 104 },
    goal: { x: 902, y: 517, r: 40 },
    walls: [
      WALL_L, WALL_R,
      [147, 281, 244, 310],
      [334, 344, 462, 387],
      [617, 453, 816, 453],
      [816, 453, 816, 540],
      [816, 540, 960, 540]
    ],
    spikes: [[40, 566, 161, 566], [227, 566, 349, 566], [443, 566, 637, 566]],
  },
];

// ---------------------------------------------------------------- verified solutions
//
// Each script below was found/refined by replaying candidates through the real physics
// (pure stepSim, fixed dt, no randomness) and confirming sim.status === 'won' inside the
// level's ink budget. window.__selftest() replays all fifty on every run, so "this game
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
  12: { strokes: [
      { tool: 'static', points: [[-1.361, 165.011], [671.597, 424.96]] },
    ] },
  13: { strokes: [
      { tool: 'static', points: [[4.638, 184.559], [714.589, 479.67]] },
    ] },
  14: { strokes: [
      { tool: 'static', points: [[64.341, 146.317], [706.866, 477.142]] },
    ] },
  15: { strokes: [
      { tool: 'static', points: [[60.185, 119.543], [670.267, 448.555]] },
    ] },
  16: { strokes: [
      { tool: 'static', points: [[37.497, 127.697], [739.288, 435.695]] },
    ] },
  17: { strokes: [
      { tool: 'static', points: [[24.412, 209.416], [609.041, 516.534]] },
    ] },
  18: { strokes: [
      { tool: 'static', points: [[64.159, 202.8], [648.684, 404.221]] },
    ] },
  19: { strokes: [
      { tool: 'static', points: [[20.195, 190.846], [671.549, 451.524]] },
    ] },
  20: { strokes: [
      { tool: 'static', points: [[55.662, 91.969], [660.373, 511.635]] },
    ] },
  21: { strokes: [
      { tool: 'static', points: [[22.628, 122.134], [136.36, 287.089]] },
      { tool: 'static', points: [[280.878, 312.204], [677.319, 443.763]] },
    ] },
  22: { strokes: [
      { tool: 'static', points: [[82.652, 147.599], [204.899, 336.626]] },
      { tool: 'static', points: [[364.633, 372.396], [665.095, 444.355]] },
    ] },
  23: { strokes: [
      { tool: 'static', points: [[55.156, 189.668], [178.622, 395.802]] },
      { tool: 'static', points: [[269.854, 381.524], [650.146, 463.476]] },
    ] },
  24: { strokes: [
      { tool: 'static', points: [[55.829, 205.344], [185.773, 320.528]] },
      { tool: 'static', points: [[346.48, 365.755], [435.956, 347.36]] },
      { tool: 'static', points: [[559.596, 392.513], [708.164, 392.678]] },
    ] },
  25: { strokes: [
      { tool: 'static', points: [[59.93, 170.648], [180.46, 370.429]] },
      { tool: 'static', points: [[266.811, 368.728], [616.637, 448.584]] },
    ] },
  26: { strokes: [
      { tool: 'static', points: [[71.083, 196.825], [192.469, 345.821]] },
      { tool: 'static', points: [[340.288, 358.148], [638.95, 423.909]] },
    ] },
  27: { strokes: [
      { tool: 'static', points: [[39.195, 90.724], [193.192, 306.963]] },
      { tool: 'static', points: [[270.882, 333.846], [696.261, 447.141]] },
    ] },
  28: { strokes: [
      { tool: 'static', points: [[45.8, 197.338], [182.338, 319.283]] },
      { tool: 'static', points: [[289.491, 357.933], [393.963, 333.707]] },
      { tool: 'static', points: [[516.017, 365.844], [704.988, 424.766]] },
    ] },
  29: { strokes: [
      { tool: 'static', points: [[67.494, 108.881], [220.453, 273.659]] },
      { tool: 'static', points: [[272.17, 314.461], [705.766, 436.258]] },
    ] },
  30: { strokes: [
      { tool: 'static', points: [[77.954, 176.696], [188.664, 339.769]] },
      { tool: 'static', points: [[353.69, 385.759], [729.824, 502.451]] },
    ] },
  31: { strokes: [
      { tool: 'static', points: [[58.029, 164.646], [201.111, 371.561]] },
      { tool: 'static', points: [[256.34, 348.181], [341.757, 418.239]] },
      { tool: 'static', points: [[466.53, 424.321], [680.381, 491.56]] },
    ] },
  32: { strokes: [
      { tool: 'static', points: [[28.112, 120.804], [237.364, 333.045]] },
      { tool: 'static', points: [[306.226, 343.538], [691.379, 472.066]] },
    ] },
  33: { strokes: [
      { tool: 'static', points: [[68.227, 229.056], [185.021, 364.06]] },
      { tool: 'static', points: [[267.75, 380.968], [340.509, 379.963]] },
      { tool: 'static', points: [[463.841, 423.587], [736.078, 482.731]] },
    ] },
  34: { strokes: [
      { tool: 'static', points: [[69.055, 123.071], [208.568, 305.681]] },
      { tool: 'static', points: [[351.31, 314.249], [456.69, 361.751]] },
      { tool: 'static', points: [[565.134, 375.621], [682.97, 419.071]] },
    ] },
  35: { strokes: [
      { tool: 'static', points: [[43.292, 69.274], [200.147, 246.186]] },
      { tool: 'static', points: [[339.271, 309.253], [450.14, 354.884]] },
      { tool: 'static', points: [[525.303, 371.978], [671.029, 461.075]] },
    ] },
  36: { strokes: [
      { tool: 'static', points: [[70.697, 136.607], [198.061, 326.397]] },
      { tool: 'static', points: [[298.708, 337.141], [403.292, 371.859]] },
      { tool: 'static', points: [[511.685, 398.223], [647.315, 442.777]] },
    ] },
  37: { strokes: [
      { tool: 'static', points: [[48.354, 100.61], [210.53, 309.228]] },
      { tool: 'static', points: [[252.171, 332.457], [674.474, 425.273]] },
    ] },
  38: { strokes: [
      { tool: 'static', points: [[64.67, 156.725], [207.198, 331.771]] },
      { tool: 'static', points: [[284.817, 396.76], [660.358, 476.634]] },
    ] },
  39: { strokes: [
      { tool: 'static', points: [[40.27, 212.89], [201.973, 374.506]] },
      { tool: 'static', points: [[331.861, 394.534], [656.118, 455.632]] },
    ] },
  40: { strokes: [
      { tool: 'static', points: [[74.074, 236.727], [206.25, 338.101]] },
      { tool: 'static', points: [[288.011, 383.864], [671.886, 392.205]] },
    ] },
  41: { strokes: [
      { tool: 'static', points: [[35.546, 119.429], [195.412, 298.662]] },
      { tool: 'static', points: [[315.299, 371.241], [600.584, 470.62]] },
    ] },
  42: { strokes: [
      { tool: 'static', points: [[20.193, 58.151], [165.386, 281.203]] },
      { tool: 'static', points: [[311.276, 310.047], [694.498, 420.931]] },
    ] },
  43: { strokes: [
      { tool: 'static', points: [[50.165, 158.443], [186.024, 304.707]] },
      { tool: 'static', points: [[287.827, 341.652], [392.173, 371.348]] },
      { tool: 'static', points: [[474.786, 396.492], [689.687, 489.185]] },
    ] },
  44: { strokes: [
      { tool: 'static', points: [[24.15, 154.318], [161.986, 349.885]] },
      { tool: 'static', points: [[250.969, 373.708], [355.031, 394.292]] },
      { tool: 'static', points: [[514.512, 422.962], [689.554, 473.075]] },
    ] },
  45: { strokes: [
      { tool: 'static', points: [[52.446, 93.214], [179.703, 298.711]] },
      { tool: 'static', points: [[306.198, 320.086], [422.478, 368.167]] },
      { tool: 'static', points: [[574.09, 394.043], [692.564, 485.248]] },
    ] },
  46: { strokes: [
      { tool: 'static', points: [[84.963, 84.285], [196.92, 267.327]] },
      { tool: 'static', points: [[328.691, 288.386], [419.708, 367.738]] },
      { tool: 'static', points: [[504.723, 374.872], [626.672, 481.512]] },
    ] },
  47: { strokes: [
      { tool: 'static', points: [[47.305, 88.588], [181.291, 264.912]] },
      { tool: 'static', points: [[281.187, 284.514], [386.813, 335.486]] },
      { tool: 'static', points: [[522.164, 380.084], [660.096, 430.926]] },
    ] },
  48: { strokes: [
      { tool: 'static', points: [[52.843, 224.203], [181.999, 381.117]] },
      { tool: 'static', points: [[353.233, 397.227], [438.009, 384.957]] },
      { tool: 'static', points: [[576.609, 428.47], [756.78, 481.616]] },
    ] },
  49: { strokes: [
      { tool: 'static', points: [[48.927, 147.579], [151.492, 292.002]] },
      { tool: 'static', points: [[273.238, 310.786], [354.479, 347.882]] },
      { tool: 'static', points: [[456.356, 374.735], [639.639, 463.866]] },
    ] },
};

for (let i = 0; i < LEVELS.length; i++) {
  const s = SOLUTIONS[i];
  LEVELS[i].solution = s ? { settle: 30, maxFrames: 900, ...s } : null;
}

export default LEVELS;
