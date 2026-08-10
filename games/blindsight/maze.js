// Blindsight — maze geometry. PURE and DOM-free: generation, tile queries,
// DDA raycasting, line-of-sight, BFS fields, circle-vs-grid movement.
//
// Everything in here is deterministic given the RNG that is handed in. Nothing
// touches Math.random, Date.now, window, or the canvas — so the self-test and a
// plain node script can exercise it identically to the live game.

export const TILE = 24;

// Face indices. A face belongs to a SOLID tile and points at the open space it
// borders, which is what makes "did the ping reveal this surface?" answerable.
export const FACE_N = 0, FACE_E = 1, FACE_S = 2, FACE_W = 3;

const BIG = 1e30;
const CELL_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export function makeMap(tw, th, fill = 1) {
  const solid = new Uint8Array(tw * th);
  if (fill) solid.fill(1);
  return { tw, th, solid };
}

export function solidAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.tw || ty >= map.th) return 1;
  return map.solid[ty * map.tw + tx];
}

export function tileCenter(tx, ty) { return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE }; }
export function tileOf(x, y) { return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) }; }

/** Face buffer index for a (tile, face) pair. */
export function faceIndex(map, tx, ty, face) { return ((ty * map.tw + tx) << 2) | face; }

/** Build a map from ASCII rows ('#' solid). Used by the self-test for known layouts. */
export function mapFromRows(rows) {
  const th = rows.length, tw = rows[0].length;
  const map = makeMap(tw, th, 0);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) map.solid[y * tw + x] = rows[y][x] === '#' ? 1 : 0;
  }
  return map;
}

/**
 * Recursive-backtracker maze on a cell grid, expanded to a tile grid of
 * (cols*2+1) x (rows*2+1), then braided so dead ends (death traps in a game
 * where something chases you) mostly become loops.
 */
export function generateMaze(rng, cols, rows, { braid = 0.8, loops = 0.1 } = {}) {
  const tw = cols * 2 + 1, th = rows * 2 + 1;
  const map = makeMap(tw, th, 1);
  const open = (tx, ty) => { map.solid[ty * tw + tx] = 0; };
  const isOpen = (tx, ty) => map.solid[ty * tw + tx] === 0;

  const visited = new Uint8Array(cols * rows);
  const stack = [0];
  visited[0] = 1;
  open(1, 1);

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const cx = cur % cols, cy = (cur / cols) | 0;
    const cand = [];
    for (let d = 0; d < 4; d++) {
      const nx = cx + CELL_DIRS[d][0], ny = cy + CELL_DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (visited[ny * cols + nx]) continue;
      cand.push(d);
    }
    if (!cand.length) { stack.pop(); continue; }
    const d = cand[rng.int(cand.length)];
    const nx = cx + CELL_DIRS[d][0], ny = cy + CELL_DIRS[d][1];
    visited[ny * cols + nx] = 1;
    open(2 * nx + 1, 2 * ny + 1);
    open(cx + nx + 1, cy + ny + 1);   // the wall tile between the two cells
    stack.push(ny * cols + nx);
  }

  // Extra loops: carve some interior walls so the maze has cycles to run in.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      for (let d = 1; d <= 2; d++) {            // east + south only, no duplicates
        const nx = cx + CELL_DIRS[d][0], ny = cy + CELL_DIRS[d][1];
        if (nx >= cols || ny >= rows) continue;
        const mx = cx + nx + 1, my = cy + ny + 1;
        if (isOpen(mx, my)) continue;
        if (rng.next() < loops) open(mx, my);
      }
    }
  }

  // Braid: open a second exit on most dead ends.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const closed = [];
      let openCount = 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + CELL_DIRS[d][0], ny = cy + CELL_DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (isOpen(cx + nx + 1, cy + ny + 1)) openCount++;
        else closed.push([cx + nx + 1, cy + ny + 1]);
      }
      if (openCount <= 1 && closed.length && rng.next() < braid) {
        const pick = closed[rng.int(closed.length)];
        open(pick[0], pick[1]);
      }
    }
  }

  // Guarantee the spawn cell has an eastward corridor, so "walk right" always
  // does something from the start (nice for players, and the self-test relies on it).
  open(2, 1);

  return map;
}

/**
 * DDA raycast (Amanatides & Woo). `dx,dy` must be a unit vector.
 * Returns the first solid surface hit, including WHICH face of that tile was struck.
 */
export function castRay(map, ox, oy, dx, dy, maxDist) {
  let tx = Math.floor(ox / TILE), ty = Math.floor(oy / TILE);
  const deltaX = dx === 0 ? BIG : Math.abs(TILE / dx);
  const deltaY = dy === 0 ? BIG : Math.abs(TILE / dy);
  let stepX = 0, stepY = 0, sideX = BIG, sideY = BIG;
  if (dx < 0) { stepX = -1; sideX = (ox - tx * TILE) / -dx; }
  else if (dx > 0) { stepX = 1; sideX = ((tx + 1) * TILE - ox) / dx; }
  if (dy < 0) { stepY = -1; sideY = (oy - ty * TILE) / -dy; }
  else if (dy > 0) { stepY = 1; sideY = ((ty + 1) * TILE - oy) / dy; }

  const miss = () => ({ hit: 0, x: ox + dx * maxDist, y: oy + dy * maxDist, dist: maxDist, tx: -1, ty: -1, face: -1 });

  for (let guard = 0; guard < 4096; guard++) {
    let dist, side;
    if (sideX < sideY) { dist = sideX; sideX += deltaX; tx += stepX; side = 0; }
    else { dist = sideY; sideY += deltaY; ty += stepY; side = 1; }
    if (!(dist <= maxDist)) return miss();
    if (tx < 0 || ty < 0 || tx >= map.tw || ty >= map.th) return miss();
    if (map.solid[ty * map.tw + tx]) {
      const face = side === 0
        ? (stepX > 0 ? FACE_W : FACE_E)
        : (stepY > 0 ? FACE_N : FACE_S);
      return { hit: 1, x: ox + dx * dist, y: oy + dy * dist, dist, tx, ty, face };
    }
  }
  return miss();
}

/** True when nothing solid sits between the two points. */
export function hasLOS(map, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const r = castRay(map, ax, ay, dx / d, dy / d, d - 0.001);
  return !r.hit;
}

/** BFS distance field over walkable tiles. -1 = solid or unreachable. */
export function bfsField(map, sx, sy) {
  const n = map.tw * map.th;
  const dist = new Int32Array(n).fill(-1);
  if (sx < 0 || sy < 0 || sx >= map.tw || sy >= map.th) return dist;
  const start = sy * map.tw + sx;
  if (map.solid[start]) return dist;
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  q[tail++] = start; dist[start] = 0;
  while (head < tail) {
    const cur = q[head++];
    const cx = cur % map.tw, cy = (cur / map.tw) | 0;
    const nd = dist[cur] + 1;
    for (let d = 0; d < 4; d++) {
      const nx = cx + CELL_DIRS[d][0], ny = cy + CELL_DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= map.tw || ny >= map.th) continue;
      const ni = ny * map.tw + nx;
      if (map.solid[ni] || dist[ni] >= 0) continue;
      dist[ni] = nd;
      q[tail++] = ni;
    }
  }
  return dist;
}

/** All walkable tile indices, in scan order. */
export function walkableTiles(map) {
  const out = [];
  for (let i = 0; i < map.solid.length; i++) if (!map.solid[i]) out.push(i);
  return out;
}

export function boxBlocked(map, x, y, r) {
  const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
  const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) if (solidAt(map, tx, ty)) return true;
  }
  return false;
}

/** Axis-separated movement so bodies slide along walls instead of sticking. */
export function moveCircle(map, body, dx, dy, r) {
  if (dx) { const nx = body.x + dx; if (!boxBlocked(map, nx, body.y, r)) body.x = nx; }
  if (dy) { const ny = body.y + dy; if (!boxBlocked(map, body.x, ny, r)) body.y = ny; }
}

/** Nearest walkable tile centre to a world point (spiral search). */
export function nearestWalkable(map, x, y) {
  const t = tileOf(x, y);
  const tx = Math.max(0, Math.min(map.tw - 1, t.tx));
  const ty = Math.max(0, Math.min(map.th - 1, t.ty));
  if (!solidAt(map, tx, ty)) return tileCenter(tx, ty);
  for (let rad = 1; rad < Math.max(map.tw, map.th); rad++) {
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        if (Math.abs(ox) !== rad && Math.abs(oy) !== rad) continue;
        const nx = tx + ox, ny = ty + oy;
        if (nx < 0 || ny < 0 || nx >= map.tw || ny >= map.th) continue;
        if (!solidAt(map, nx, ny)) return tileCenter(nx, ny);
      }
    }
  }
  return tileCenter(tx, ty);
}
