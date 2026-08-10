// Petri — stampable Conway patterns. Pure data + pure helper functions, no DOM, no Date.now.

export const PATTERNS = [
  {
    id: 'block', name: 'Block', nameZh: '方块', key: '1', cost: 4,
    desc: 'still life — a stable anchor that never changes',
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
  },
  {
    id: 'blinker', name: 'Blinker', nameZh: '闪烁体', key: '2', cost: 6,
    desc: 'oscillator — flips between two states forever',
    cells: [[0, 0], [0, 1], [0, 2]],
  },
  {
    id: 'glider', name: 'Glider', nameZh: '滑翔机', key: '3', cost: 10,
    desc: 'travels diagonally, eats whatever is in its path',
    cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]],
  },
  {
    id: 'lwss', name: 'LWSS', nameZh: '轻型飞船', key: '4', cost: 22,
    desc: 'lightweight spaceship — faster, wider push down a lane',
    cells: [[1, 0], [4, 0], [0, 1], [0, 2], [4, 2], [0, 3], [1, 3], [2, 3], [3, 3]],
  },
  {
    id: 'gun', name: 'Gun', nameZh: '滑翔机枪', key: '5', cost: 60,
    desc: 'gosper-style emitter — spits gliders forever once seeded',
    cells: [
      [24, 0],
      [22, 1], [24, 1],
      [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2],
      [11, 3], [15, 3], [20, 3], [21, 3], [34, 3], [35, 3],
      [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4],
      [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5],
      [10, 6], [16, 6], [24, 6],
      [11, 7], [15, 7],
      [12, 8], [13, 8],
    ],
  },
  {
    id: 'seed', name: 'Seed', nameZh: '种子', key: '6', cost: 14,
    desc: 'R-pentomino — tiny, chaotic, grows unpredictably',
    cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
  },
];

export function patternById(id) {
  return PATTERNS.find((p) => p.id === id) || PATTERNS[0];
}

/** Rotate offsets by rot*90deg (rot 0..3) and normalize so min x/y = 0. */
export function rotatePattern(cells, rot) {
  const r = ((rot % 4) + 4) % 4;
  let out = cells.map(([x, y]) => {
    if (r === 0) return [x, y];
    if (r === 1) return [-y, x];
    if (r === 2) return [-x, -y];
    return [y, -x];
  });
  let minX = Infinity, minY = Infinity;
  for (const [x, y] of out) { if (x < minX) minX = x; if (y < minY) minY = y; }
  out = out.map(([x, y]) => [x - minX, y - minY]);
  return out;
}

export function patternBounds(cells) {
  let maxX = 0, maxY = 0;
  for (const [x, y] of cells) { if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  return { w: maxX + 1, h: maxY + 1 };
}

/** Stamp a (rotated) pattern centered at (cx,cy) onto grid with the given color. Clips to bounds. */
export function stampPattern(grid, gw, gh, pattern, cx, cy, rot, color) {
  const cells = rotatePattern(pattern.cells, rot);
  const { w, h } = patternBounds(cells);
  const ox = cx - ((w / 2) | 0);
  const oy = cy - ((h / 2) | 0);
  let placed = 0;
  for (const [dx, dy] of cells) {
    const x = ox + dx, y = oy + dy;
    if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
    grid[y * gw + x] = color;
    placed++;
  }
  return placed;
}
