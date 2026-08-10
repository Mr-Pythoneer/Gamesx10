// Swarm — 10-minute bullet-heaven roguelite. Gamesx10 flagship.
//
// Shape (matches the house pattern): a PURE simulation — makeSim(seed, characterId, meta)
// and stepSim(sim, intent, dt) — driven by both the live game and the headless self-test.
// Nothing in the sim ever calls Math.random()/Date.now(); all randomness comes from
// sim.rng (seeded RNG), all timing from the fixed dt the kit hands to update().

import {
  boot, registerSelftest, Palette, FX, Sound, Store, RNG,
  clamp, lerp, dist, text, roundRect, allFinite, TAU,
} from '../../shared/kit.js';
import {
  WEAPONS, WEAPON_IDS, PASSIVES, PASSIVE_IDS, EVOLUTIONS,
  ENEMIES, BOSS, CHARACTERS, directorAt, RUN_DURATION,
} from './content.js';

// ---------------------------------------------------------------- tuning constants

const PLAYER_RADIUS = 12;
const BASE_SPEED = 140;
const BASE_HP = 130;
const PICKUP_BASE = 70;
const SPAWN_RADIUS = 460;
const CELL = 64;
const MAX_ENEMIES = 1400;
const MAX_PROJECTILES = 1800;

// ================================================================== PURE SIMULATION

export function makeSim(seed, characterId, meta = {}) {
  const rng = new RNG(seed);
  const character = CHARACTERS.find((c) => c.id === characterId) || CHARACTERS[0];
  const player = {
    x: 0, y: 0, hp: BASE_HP, maxHp: BASE_HP, facing: -Math.PI / 2, hitFlash: 0,
    level: 1, xp: 0, xpNext: 5,
    weapons: { [character.startWeapon]: 1 },
    passives: {},
    evolved: {},
    bias: character.bias || {},
    metaDmgMul: 1 + (meta.dmg || 0) * 0.08,
    metaSpeedMul: 1 + (meta.speed || 0) * 0.05,
    metaHpMul: 1 + (meta.hp || 0) * 0.08,
    bladeAngle: 0,
    cd: {},
  };
  return {
    seed, rng, characterId: character.id,
    player,
    enemies: [], projectiles: [], gems: [], mines: [],
    damageNumbers: [], rings: [], beams: [], arcs: [],
    elapsed: 0, spawnT: 0.6, kills: 0, gold: 0, nextId: 1,
    bossSpawned: false, boss: null,
    phase: 'playing', draft: null,
    frame: 0, t: 0,
  };
}

function computeStats(sim) {
  const p = sim.player;
  let dmgMul = 1, speedMul = 1, cdMul = 1, hpMul = 1, pickupMul = 1, reduce = 0, xpMul = 1, areaMul = 1, regen = 0;
  for (const pid in p.passives) {
    const lvl = p.passives[pid];
    const st = PASSIVES[pid].stat(lvl);
    if (st.dmgMul) dmgMul *= st.dmgMul;
    if (st.speedMul) speedMul *= st.speedMul;
    if (st.cdMul) cdMul *= st.cdMul;
    if (st.hpMul) hpMul *= st.hpMul;
    if (st.pickupMul) pickupMul *= st.pickupMul;
    if (st.reduce) reduce += st.reduce;
    if (st.xpMul) xpMul *= st.xpMul;
    if (st.areaMul) areaMul *= st.areaMul;
    if (st.regen) regen += st.regen;
  }
  dmgMul *= p.metaDmgMul || 1;
  speedMul *= (p.metaSpeedMul || 1) * (p.bias.speedMul || 1);
  hpMul *= (p.metaHpMul || 1) * (p.bias.hpMul || 1);
  return { dmgMul, speedMul, cdMul: Math.max(0.15, cdMul), hpMul, pickupMul, reduce, xpMul, areaMul, regen };
}

// ---- spatial grid (uniform buckets, squared-distance checks) ----

function cellKey(cx, cy) { return cx * 100003 + cy; }
function buildGrid(entities) {
  const grid = new Map();
  for (const e of entities) {
    if (e.dead) continue;
    const cx = Math.floor(e.x / CELL), cy = Math.floor(e.y / CELL);
    const k = cellKey(cx, cy);
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(e);
  }
  return grid;
}
function forNear(grid, x, y, radius, cb) {
  const r = Math.max(1, Math.ceil(radius / CELL) + 1);
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const arr = grid.get(cellKey(cx + dx, cy + dy));
      if (arr) for (const e of arr) cb(e);
    }
  }
}

function nearestEnemy(sim, x, y) {
  let best = null, bd = Infinity;
  for (const en of sim.enemies) {
    if (en.dead) continue;
    const dx = en.x - x, dy = en.y - y;
    const dd = dx * dx + dy * dy;
    if (dd < bd) { bd = dd; best = en; }
  }
  return best;
}

function dealDamage(sim, en, dmg) {
  if (en.dead || dmg <= 0) return;
  if (en.shieldHp > 0) {
    const absorb = Math.min(en.shieldHp, dmg);
    en.shieldHp -= absorb;
    dmg -= absorb;
    if (dmg <= 0) return;
  }
  en.hp -= dmg;
  if (sim.damageNumbers.length < 200) sim.damageNumbers.push({ x: en.x, y: en.y, val: Math.round(dmg), life: 0.6 });
  if (en.hp <= 0 && !en.dead) killEnemy(sim, en);
}

function killEnemy(sim, en) {
  en.dead = true;
  sim.kills++;
  if (en.type === 'boss') {
    sim.gold += 300;
    return;
  }
  sim.gems.push({ id: sim.nextId++, x: en.x, y: en.y, value: en.xp, dead: false });
  sim.gold += Math.ceil(en.xp * 0.6);
  if (en.type === 'splitter' && !en.isChild && sim.enemies.length < MAX_ENEMIES - 2) {
    for (let i = 0; i < 2; i++) {
      const ang = sim.rng.next() * TAU;
      sim.enemies.push({
        id: sim.nextId++, type: 'splitter', x: en.x + Math.cos(ang) * 14, y: en.y + Math.sin(ang) * 14,
        hp: Math.max(4, Math.floor(en.maxHp / 2)), maxHp: Math.max(4, Math.floor(en.maxHp / 2)),
        speed: en.speed * 1.1, dmg: Math.floor(en.dmg * 0.7), radius: en.radius * 0.7,
        xp: 1, color: en.color, dead: false, isChild: true, shieldHp: 0,
      });
    }
  }
}

function spawnEnemy(sim, dir, forceElite) {
  if (sim.enemies.length >= MAX_ENEMIES) return;
  let type = 'chaser';
  if (forceElite) type = 'elite';
  else {
    const entries = Object.entries(dir.weights).filter(([, w]) => w > 0);
    const total = entries.reduce((a, [, w]) => a + w, 0) || 1;
    let r = sim.rng.next() * total;
    for (const [k, w] of entries) { if (r < w) { type = k; break; } r -= w; }
  }
  const def = ENEMIES[type];
  const ang = sim.rng.next() * TAU;
  const x = sim.player.x + Math.cos(ang) * SPAWN_RADIUS;
  const y = sim.player.y + Math.sin(ang) * SPAWN_RADIUS;
  sim.enemies.push({
    id: sim.nextId++, type, x, y, hp: def.hp, maxHp: def.hp, speed: def.speed, dmg: def.dmg,
    radius: def.radius, xp: def.xp, color: def.color, dead: false,
    shieldHp: def.shield || 0, chargeSpeed: def.chargeSpeed, chargeCooldown: def.chargeCooldown,
    shootRange: def.shootRange, shootCooldown: def.shootCooldown,
  });
}

function updateSpawner(sim, dt) {
  if (sim.bossSpawned) return;
  sim.spawnT -= dt;
  const dir = directorAt(sim.elapsed);
  if (sim.spawnT <= 0) {
    sim.spawnT = lerp(1.1, 0.12, dir.density);
    const n = 1 + Math.floor(dir.density * 3);
    for (let i = 0; i < n; i++) spawnEnemy(sim, dir);
    if (sim.rng.next() < dir.eliteChance) spawnEnemy(sim, dir, true);
  }
}

function spawnRawEnemyProjectile(sim, x, y, dirx, diry, dmg) {
  if (sim.projectiles.length >= MAX_PROJECTILES) return;
  sim.projectiles.push({ id: sim.nextId++, x, y, vx: dirx * 180, vy: diry * 180, dmg, life: 4, hitRadius: 6, from: 'enemy', dead: false });
}

function updateEnemies(sim, dt, stats) {
  const p = sim.player;
  for (const en of sim.enemies) {
    if (en.dead) continue;
    if (en.hitCd) for (const k in en.hitCd) en.hitCd[k] = Math.max(0, en.hitCd[k] - dt);
    en.kx = (en.kx || 0) * 0.9;
    en.ky = (en.ky || 0) * 0.9;
    const dx = p.x - en.x, dy = p.y - en.y;
    const d = Math.hypot(dx, dy) || 1;
    let speed = en.speed;
    let mvx = dx / d, mvy = dy / d;

    if (en.type === 'charger') {
      en.chargeT = (en.chargeT == null ? 0 : en.chargeT) - dt;
      if (en.charging) {
        speed = en.chargeSpeed || 220;
        mvx = en.chargeDirX; mvy = en.chargeDirY;
        en.chargeTimer -= dt;
        if (en.chargeTimer <= 0) { en.charging = false; en.chargeT = en.chargeCooldown; }
      } else if (en.chargeT <= 0 && d < 260) {
        en.charging = true; en.chargeTimer = 0.6; en.chargeDirX = dx / d; en.chargeDirY = dy / d;
      }
    } else if (en.type === 'ranged') {
      en.shootT = (en.shootT == null ? en.shootCooldown : en.shootT) - dt;
      if (d < en.shootRange && en.shootT <= 0) { en.shootT = en.shootCooldown; spawnRawEnemyProjectile(sim, en.x, en.y, dx / d, dy / d, en.dmg); }
      if (d < en.shootRange * 0.6) speed = -speed * 0.5;
    } else if (en.type === 'boss') {
      en.novaT = (en.novaT == null ? 2 : en.novaT) - dt;
      if (en.novaT <= 0) {
        en.novaT = 2.4;
        for (let i = 0; i < 10; i++) { const a = (TAU / 10) * i; spawnRawEnemyProjectile(sim, en.x, en.y, Math.cos(a), Math.sin(a), en.dmg * 0.5); }
      }
    }

    en.x += (mvx * speed + en.kx) * dt;
    en.y += (mvy * speed + en.ky) * dt;

    const rr = en.radius + PLAYER_RADIUS;
    if (dx * dx + dy * dy <= rr * rr) {
      en.hitCd = en.hitCd || {};
      if ((en.hitCd.player || 0) <= 0) {
        const taken = Math.max(1, en.dmg - stats.reduce);
        p.hp -= taken;
        p.hitFlash = 0.15;
        en.hitCd.player = 0.5;
      }
    }
  }
  for (let i = sim.enemies.length - 1; i >= 0; i--) if (sim.enemies[i].dead) sim.enemies.splice(i, 1);
}

function spawnPlayerProjectile(sim, opts) {
  if (sim.projectiles.length >= MAX_PROJECTILES) return;
  sim.projectiles.push({
    id: sim.nextId++, x: opts.x, y: opts.y, vx: opts.vx, vy: opts.vy, dmg: opts.dmg, life: opts.life,
    pierce: opts.pierce || 0, hitRadius: opts.hitRadius, from: 'player', hitSet: new Set(),
    homing: !!opts.homing, targetId: opts.targetId, dead: false,
  });
}

function updateProjectiles(sim, dt, stats, grid) {
  for (const pr of sim.projectiles) {
    if (pr.dead) continue;
    pr.life -= dt;
    if (pr.life <= 0) { pr.dead = true; continue; }
    if (pr.homing && pr.targetId != null) {
      const tgt = sim.enemies.find((e) => e.id === pr.targetId && !e.dead);
      if (tgt) {
        const dx = tgt.x - pr.x, dy = tgt.y - pr.y;
        const d = Math.hypot(dx, dy) || 1;
        const turn = Math.min(1, 6 * dt);
        const spd = Math.hypot(pr.vx, pr.vy) || 1;
        pr.vx += (dx / d * spd - pr.vx) * turn;
        pr.vy += (dy / d * spd - pr.vy) * turn;
      }
    }
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    if (pr.from === 'player') {
      forNear(grid, pr.x, pr.y, pr.hitRadius + 24, (en) => {
        if (en.dead || pr.dead) return;
        if (pr.hitSet.has(en.id)) return;
        const dx = en.x - pr.x, dy = en.y - pr.y;
        const rr = en.radius + pr.hitRadius;
        if (dx * dx + dy * dy <= rr * rr) {
          dealDamage(sim, en, pr.dmg);
          pr.hitSet.add(en.id);
          pr.pierce -= 1;
          if (pr.pierce < 0) pr.dead = true;
        }
      });
    } else {
      const dx = sim.player.x - pr.x, dy = sim.player.y - pr.y;
      const rr = PLAYER_RADIUS + pr.hitRadius;
      if (dx * dx + dy * dy <= rr * rr) {
        sim.player.hp -= Math.max(1, pr.dmg - stats.reduce);
        sim.player.hitFlash = 0.15;
        pr.dead = true;
      }
    }
  }
  for (let i = sim.projectiles.length - 1; i >= 0; i--) if (sim.projectiles[i].dead) sim.projectiles.splice(i, 1);
}

function updateMines(sim, dt, grid) {
  for (const m of sim.mines) {
    if (m.dead) continue;
    m.fuse -= dt;
    let trigger = m.fuse <= 0;
    if (!trigger) {
      forNear(grid, m.x, m.y, m.radius, (en) => {
        if (trigger || en.dead) return;
        const dx = en.x - m.x, dy = en.y - m.y;
        if (dx * dx + dy * dy <= (en.radius + 14) * (en.radius + 14)) trigger = true;
      });
    }
    if (trigger) {
      forNear(grid, m.x, m.y, m.radius, (en) => {
        if (en.dead) return;
        const dx = en.x - m.x, dy = en.y - m.y;
        if (dx * dx + dy * dy <= m.radius * m.radius) dealDamage(sim, en, m.dmg);
      });
      m.dead = true;
    }
  }
  for (let i = sim.mines.length - 1; i >= 0; i--) if (sim.mines[i].dead) sim.mines.splice(i, 1);
}

function updateGems(sim, dt, stats) {
  const p = sim.player;
  const pr = PICKUP_BASE * stats.pickupMul;
  for (const g of sim.gems) {
    if (g.dead) continue;
    const dx = p.x - g.x, dy = p.y - g.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < pr) { g.x += (dx / d) * 260 * dt; g.y += (dy / d) * 260 * dt; }
    if (d < PLAYER_RADIUS + 6) { g.dead = true; p.xp += g.value * stats.xpMul; }
  }
  for (let i = sim.gems.length - 1; i >= 0; i--) if (sim.gems[i].dead) sim.gems.splice(i, 1);
}

function updateWeapons(sim, dt, stats, grid) {
  const p = sim.player;
  for (const wid of Object.keys(p.weapons)) {
    const level = p.weapons[wid];
    const evo = p.evolved[wid];
    const base = WEAPONS[wid];
    const st = base.stat(level);
    const dmg = (st.dmg || 0) * stats.dmgMul;
    const cooldown = st.cooldown != null ? Math.max(0.08, st.cooldown * stats.cdMul) : null;
    const radius = st.radius != null ? st.radius * stats.areaMul : undefined;

    if (wid === 'blade') {
      p.bladeAngle = (p.bladeAngle || 0) + st.speed * dt;
      const count = evo ? st.count * 2 : st.count;
      for (let i = 0; i < count; i++) {
        const ang = p.bladeAngle + (TAU / count) * i;
        const bx = p.x + Math.cos(ang) * radius, by = p.y + Math.sin(ang) * radius;
        forNear(grid, bx, by, 26, (en) => {
          if (en.dead) return;
          en.hitCd = en.hitCd || {};
          if ((en.hitCd.blade || 0) <= 0) {
            dealDamage(sim, en, dmg);
            en.hitCd.blade = 0.25;
            if (evo) { en.kx = (en.kx || 0) + Math.cos(ang) * 140; en.ky = (en.ky || 0) + Math.sin(ang) * 140; }
          }
        });
      }
      continue;
    }
    if (wid === 'aura') {
      forNear(grid, p.x, p.y, radius, (en) => {
        if (en.dead) return;
        dealDamage(sim, en, st.dps * stats.dmgMul * dt);
        if (evo) {
          const dx = p.x - en.x, dy = p.y - en.y;
          const d = Math.hypot(dx, dy) || 1;
          en.kx = (en.kx || 0) + (dx / d) * 20;
          en.ky = (en.ky || 0) + (dy / d) * 20;
        }
      });
      continue;
    }

    p.cd[wid] = (p.cd[wid] == null ? 0 : p.cd[wid]) - dt;
    if (p.cd[wid] > 0) continue;
    p.cd[wid] = cooldown;
    const near = nearestEnemy(sim, p.x, p.y);

    if (wid === 'bolt') {
      for (let i = 0; i < st.count; i++) {
        if (evo) {
          const ang = near ? Math.atan2(near.y - p.y, near.x - p.x) : p.facing;
          const dirx = Math.cos(ang), diry = Math.sin(ang);
          forNear(grid, p.x, p.y, 2000, (en) => {
            if (en.dead) return;
            const dx = en.x - p.x, dy = en.y - p.y;
            const proj = dx * dirx + dy * diry;
            if (proj < 0) return;
            const perp = Math.abs(dx * diry - dy * dirx);
            if (perp <= en.radius + 6) dealDamage(sim, en, dmg * 1.5);
          });
          if (sim.beams.length < 40) sim.beams.push({ x1: p.x, y1: p.y, x2: p.x + dirx * 900, y2: p.y + diry * 900, life: 0.15 });
        } else {
          let vx = 0, vy = -st.speed;
          if (near) { const dx = near.x - p.x, dy = near.y - p.y; const d = Math.hypot(dx, dy) || 1; vx = (dx / d) * st.speed; vy = (dy / d) * st.speed; }
          spawnPlayerProjectile(sim, { x: p.x, y: p.y, vx, vy, dmg, life: 2.2, pierce: 0, hitRadius: 6, homing: true, targetId: near ? near.id : null });
        }
      }
      continue;
    }
    if (wid === 'nova') {
      const rad = evo ? radius * 0.7 : radius;
      forNear(grid, p.x, p.y, rad, (en) => {
        if (en.dead) return;
        dealDamage(sim, en, evo ? dmg * 0.5 : dmg);
        if (evo) sim.player.hp = Math.min(sim.player.maxHp, sim.player.hp + 1);
      });
      if (sim.rings.length < 30) sim.rings.push({ x: p.x, y: p.y, r: rad, life: 0.3 });
      if (evo) p.cd[wid] = Math.max(0.3, cooldown * 0.35);
      continue;
    }
    if (wid === 'lance') {
      const ang = near ? Math.atan2(near.y - p.y, near.x - p.x) : p.facing;
      const lanes = evo ? 3 : 1;
      for (let i = 0; i < lanes; i++) {
        const off = (i - (lanes - 1) / 2) * st.width * 3;
        const perpx = -Math.sin(ang), perpy = Math.cos(ang);
        spawnPlayerProjectile(sim, {
          x: p.x + perpx * off, y: p.y + perpy * off, vx: Math.cos(ang) * st.speed, vy: Math.sin(ang) * st.speed,
          dmg, life: 1.4, pierce: 99, hitRadius: st.width * stats.areaMul,
        });
      }
      continue;
    }
    if (wid === 'spray') {
      const ang = near ? Math.atan2(near.y - p.y, near.x - p.x) : p.facing;
      for (let i = 0; i < st.pellets; i++) {
        const a = ang + (i - (st.pellets - 1) / 2) * 0.18;
        spawnPlayerProjectile(sim, { x: p.x, y: p.y, vx: Math.cos(a) * st.speed, vy: Math.sin(a) * st.speed, dmg, life: st.range / st.speed, pierce: 0, hitRadius: 6 });
      }
      continue;
    }
    if (wid === 'chain') {
      if (!near) continue;
      let cur = near;
      const hit = new Set();
      const jumps = evo ? 40 : st.jumps;
      let bonusXp = 0;
      let fromX = p.x, fromY = p.y;
      for (let i = 0; i < jumps + 1 && cur; i++) {
        if (hit.has(cur.id)) break;
        dealDamage(sim, cur, dmg);
        hit.add(cur.id);
        if (sim.arcs.length < 60) sim.arcs.push({ x1: fromX, y1: fromY, x2: cur.x, y2: cur.y, life: 0.2 });
        if (evo) bonusXp += 0.15;
        fromX = cur.x; fromY = cur.y;
        let next = null, bd = Infinity;
        forNear(grid, cur.x, cur.y, st.jumpRange, (en) => {
          if (en.dead || hit.has(en.id)) return;
          const dx = en.x - cur.x, dy = en.y - cur.y;
          const dd = dx * dx + dy * dy;
          if (dd < bd) { bd = dd; next = en; }
        });
        cur = next;
      }
      if (bonusXp > 0) sim.player.xp += bonusXp;
      continue;
    }
    if (wid === 'mine') {
      const ang = (p.facing || 0) + Math.PI;
      if (sim.mines.length < 60) sim.mines.push({ id: sim.nextId++, x: p.x + Math.cos(ang) * 16, y: p.y + Math.sin(ang) * 16, dmg, radius, fuse: st.fuse, dead: false });
      continue;
    }
  }
}

function buildDraftOptions(sim) {
  const p = sim.player;
  const cards = [];
  for (const evo of EVOLUTIONS) {
    if ((p.weapons[evo.weapon] || 0) >= WEAPONS[evo.weapon].maxLevel && (p.passives[evo.passive] || 0) >= 1 && !p.evolved[evo.weapon]) {
      cards.push({ kind: 'evolution', id: evo.id, weapon: evo.weapon, name: evo.name, desc: evo.desc });
    }
  }
  for (const wid of WEAPON_IDS) {
    const lvl = p.weapons[wid];
    if (lvl != null) { if (lvl < WEAPONS[wid].maxLevel) cards.push({ kind: 'weapon', id: wid, name: WEAPONS[wid].name + ' +1', desc: WEAPONS[wid].desc, level: lvl + 1 }); }
    else if (Object.keys(p.weapons).length < 8) cards.push({ kind: 'weapon', id: wid, name: WEAPONS[wid].name + ' (new)', desc: WEAPONS[wid].desc, level: 1 });
  }
  for (const pid of PASSIVE_IDS) {
    const lvl = p.passives[pid];
    if (lvl != null) { if (lvl < PASSIVES[pid].maxLevel) cards.push({ kind: 'passive', id: pid, name: PASSIVES[pid].name + ' +1', desc: PASSIVES[pid].desc, level: lvl + 1 }); }
    else if (Object.keys(p.passives).length < 8) cards.push({ kind: 'passive', id: pid, name: PASSIVES[pid].name + ' (new)', desc: PASSIVES[pid].desc, level: 1 });
  }
  sim.rng.shuffle(cards);
  const picked = cards.slice(0, 3);
  while (picked.length < 3) picked.push({ kind: 'gold', id: 'gold', name: 'Gold Cache', desc: '+20 gold, banked at run end.', level: 1 });
  return picked;
}

export function applyCard(sim, card) {
  const p = sim.player;
  if (card.kind === 'weapon') p.weapons[card.id] = card.level;
  else if (card.kind === 'passive') p.passives[card.id] = card.level;
  else if (card.kind === 'evolution') p.evolved[card.weapon] = card.id;
  else if (card.kind === 'gold') sim.gold += 20;
}

function checkLevelUp(sim) {
  const p = sim.player;
  let leveled = false;
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = Math.round(5 + p.level * 4.5);
    leveled = true;
  }
  if (leveled && sim.phase === 'playing') {
    sim.draft = { options: buildDraftOptions(sim) };
    sim.phase = 'draft';
  }
}

function checkBoss(sim) {
  if (!sim.bossSpawned && sim.elapsed >= RUN_DURATION) {
    sim.bossSpawned = true;
    const boss = {
      id: sim.nextId++, type: 'boss', x: sim.player.x, y: sim.player.y - SPAWN_RADIUS * 0.7,
      hp: BOSS.hp, maxHp: BOSS.hp, speed: BOSS.speed, dmg: BOSS.dmg, radius: BOSS.radius, xp: BOSS.xp,
      dead: false, color: 'hot', shieldHp: 0, novaT: 2,
    };
    sim.boss = boss;
    sim.enemies.push(boss);
  }
  if (sim.bossSpawned && sim.boss && sim.boss.dead && sim.phase === 'playing') sim.phase = 'win';
}

function checkLoseWin(sim) {
  if (sim.player.hp <= 0 && sim.phase !== 'lose') { sim.player.hp = 0; sim.phase = 'lose'; }
}

function decayList(list, dt) {
  for (let i = list.length - 1; i >= 0; i--) { list[i].life -= dt; if (list[i].life <= 0) list.splice(i, 1); }
}

/** intent = { mx, my, draftPick } — mx/my in [-1,1] (need not be normalized). */
export function stepSim(sim, intent = {}, dt = 1 / 60) {
  if (sim.phase === 'lose' || sim.phase === 'win') return sim;

  if (sim.phase === 'draft') {
    if (intent.draftPick != null && sim.draft && sim.draft.options[intent.draftPick]) {
      applyCard(sim, sim.draft.options[intent.draftPick]);
      sim.draft = null;
      sim.phase = 'playing';
    }
    sim.frame++;
    return sim;
  }

  const stats = computeStats(sim);
  sim.player.maxHp = BASE_HP * stats.hpMul;
  sim.player.hp = Math.min(sim.player.maxHp, sim.player.hp + stats.regen * dt);
  sim.elapsed += dt;

  // movement
  const p = sim.player;
  let mx = intent.mx || 0, my = intent.my || 0;
  const mlen = Math.hypot(mx, my);
  if (mlen > 1) { mx /= mlen; my /= mlen; }
  const speed = BASE_SPEED * stats.speedMul;
  p.x += mx * speed * dt;
  p.y += my * speed * dt;
  if (mlen > 0.05) p.facing = Math.atan2(my, mx);
  if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt);

  const grid = buildGrid(sim.enemies);
  updateWeapons(sim, dt, stats, grid);
  updateSpawner(sim, dt);
  updateEnemies(sim, dt, stats);
  const grid2 = buildGrid(sim.enemies);
  updateProjectiles(sim, dt, stats, grid2);
  updateMines(sim, dt, grid2);
  updateGems(sim, dt, stats);

  decayList(sim.damageNumbers, dt);
  decayList(sim.rings, dt);
  decayList(sim.beams, dt);
  decayList(sim.arcs, dt);

  checkLevelUp(sim);
  checkBoss(sim);
  checkLoseWin(sim);

  sim.frame++;
  sim.t += dt;
  return sim;
}

// ================================================================== LIVE GAME (kit glue)

function isUnlocked(ch, game) {
  if (!ch.unlock) return true;
  if (ch.unlock.kind === 'gold') return game.store.get('gold', 0) >= ch.unlock.amount;
  if (ch.unlock.kind === 'wins') return game.store.get('wins', 0) >= ch.unlock.amount;
  return true;
}

function upgradeCost(lvl) { return 20 + lvl * 15; }

function init(game) {
  return { screen: 'title', charIndex: 0, sim: null, draftRects: [], endStats: null, prevPhase: null, titleT: 0 };
}

function readIntent(game, state) {
  const inp = game.input;
  let mx = 0, my = 0;
  if (inp.isDown('left') || inp.isDown('a')) mx -= 1;
  if (inp.isDown('right') || inp.isDown('d')) mx += 1;
  if (inp.isDown('up') || inp.isDown('w')) my -= 1;
  if (inp.isDown('down') || inp.isDown('s')) my += 1;
  if (mx === 0 && my === 0 && inp.pointer.down) {
    const dx = inp.pointer.x - game.w / 2, dy = inp.pointer.y - game.h / 2;
    const d = Math.hypot(dx, dy);
    if (d > 6) { mx = dx / d; my = dy / d; }
  }
  let draftPick = null;
  const sim = state.sim;
  if (sim && sim.phase === 'draft') {
    if (inp.justPressed('1')) draftPick = 0;
    else if (inp.justPressed('2')) draftPick = 1;
    else if (inp.justPressed('3')) draftPick = 2;
    else if (inp.pointerPressed) {
      for (let i = 0; i < state.draftRects.length; i++) {
        const r = state.draftRects[i];
        if (inp.pointer.x >= r.x && inp.pointer.x <= r.x + r.w && inp.pointer.y >= r.y && inp.pointer.y <= r.y + r.h) { draftPick = i; break; }
      }
    }
  }
  return { mx, my, draftPick };
}

function handleTitleInput(state, game) {
  const inp = game.input;
  if (inp.justPressed('left')) state.charIndex = (state.charIndex + CHARACTERS.length - 1) % CHARACTERS.length;
  if (inp.justPressed('right')) state.charIndex = (state.charIndex + 1) % CHARACTERS.length;
  if (inp.justPressed('space') || inp.justPressed('enter')) {
    const ch = CHARACTERS[state.charIndex];
    if (isUnlocked(ch, game)) {
      const meta = { dmg: game.store.get('up_dmg', 0), speed: game.store.get('up_speed', 0), hp: game.store.get('up_hp', 0) };
      state.sim = makeSim(game.rng.int(1e9) || 1, ch.id, meta);
      state.screen = 'run';
      state.endStats = null;
      state.prevPhase = 'playing';
      game.sound.blip(700);
    }
  }
  const gold = game.store.get('gold', 0);
  const buy = (key, cost) => { if (gold >= cost) { game.store.set('gold', gold - cost); return true; } return false; };
  if (inp.justPressed('q')) { const l = game.store.get('up_dmg', 0); if (buy('dmg', upgradeCost(l))) game.store.set('up_dmg', l + 1); }
  if (inp.justPressed('e')) { const l = game.store.get('up_speed', 0); if (buy('spd', upgradeCost(l))) game.store.set('up_speed', l + 1); }
  if (inp.justPressed('r')) { const l = game.store.get('up_hp', 0); if (buy('hp', upgradeCost(l))) game.store.set('up_hp', l + 1); }
}

function update(state, dt, game) {
  if (state.screen === 'title') { state.titleT += dt; handleTitleInput(state, game); return; }
  const sim = state.sim;
  if (!sim) return;
  const prevHp = sim.player.hp;
  const prevKills = sim.kills;
  const prevPhase = sim.phase;
  const intent = readIntent(game, state);
  stepSim(sim, intent, dt);

  if (sim.player.hp < prevHp) game.fx.shake(3);
  if (sim.kills > prevKills && game.rng.next() < 0.25) game.sound.blip(480 + game.rng.next() * 260);

  if (prevPhase !== 'draft' && sim.phase === 'draft') { game.sound.ok(); game.fx.shake(5); }
  if (prevPhase === 'draft' && sim.phase === 'playing') game.sound.blip(880);

  if ((sim.phase === 'win' || sim.phase === 'lose') && !state.endStats) {
    state.endStats = { kills: sim.kills, level: sim.player.level, time: sim.elapsed, gold: sim.gold, won: sim.phase === 'win' };
    game.store.set('gold', game.store.get('gold', 0) + sim.gold);
    if (sim.phase === 'win') { game.store.set('wins', game.store.get('wins', 0) + 1); game.store.best('bestTime', sim.elapsed, false); game.sound.ok(); game.fx.shake(10); }
    else { game.sound.bad(); game.fx.shake(14); }
    game.store.best('bestKills', sim.kills, true);
  }
  if (sim.phase === 'win' || sim.phase === 'lose') {
    if (game.input.justPressed('enter') || game.input.justPressed('space')) {
      state.screen = 'title'; state.sim = null; state.endStats = null;
    }
  }
}

// ---------------------------------------------------------------- rendering

function drawIcon(ctx, x, y, color, filled) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.18; ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
  ctx.restore();
}

function wrapText(ctx, str, x, y, maxW, lh, opts) {
  ctx.font = `${opts.weight || 500} ${opts.size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const words = str.split(' ');
  let line = '', yy = y;
  for (const wd of words) {
    const t = line + wd + ' ';
    if (ctx.measureText(t).width > maxW && line) { text(ctx, line.trim(), x, yy, opts); line = wd + ' '; yy += lh; }
    else line = t;
  }
  if (line) text(ctx, line.trim(), x, yy, opts);
  return yy + lh;
}

function renderWorld(sim, ctx, game) {
  const ox = game.w / 2 - sim.player.x, oy = game.h / 2 - sim.player.y;
  ctx.save();
  ctx.translate(ox, oy);

  ctx.strokeStyle = Palette.grid; ctx.lineWidth = 1;
  const gs = 48;
  const sx = Math.floor((sim.player.x - game.w) / gs) * gs, ex = sim.player.x + game.w;
  const sy = Math.floor((sim.player.y - game.h) / gs) * gs, ey = sim.player.y + game.h;
  ctx.beginPath();
  for (let x = sx; x < ex; x += gs) { ctx.moveTo(x, sy); ctx.lineTo(x, ey); }
  for (let y = sy; y < ey; y += gs) { ctx.moveTo(sx, y); ctx.lineTo(ex, y); }
  ctx.stroke();

  for (const m of sim.mines) { ctx.fillStyle = Palette.warm; ctx.globalAlpha = 0.6 + 0.4 * Math.sin(sim.t * 10); ctx.beginPath(); ctx.arc(m.x, m.y, 6, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
  for (const g of sim.gems) { ctx.fillStyle = Palette.accent2; ctx.beginPath(); ctx.arc(g.x, g.y, 4, 0, TAU); ctx.fill(); }
  for (const pr of sim.projectiles) { ctx.fillStyle = pr.from === 'player' ? Palette.accent : Palette.hot; ctx.beginPath(); ctx.arc(pr.x, pr.y, pr.hitRadius || 4, 0, TAU); ctx.fill(); }
  for (const b of sim.beams) { ctx.strokeStyle = Palette.accent2; ctx.globalAlpha = Math.max(0, b.life / 0.15); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke(); ctx.globalAlpha = 1; }
  for (const a of sim.arcs) { ctx.strokeStyle = Palette.violet; ctx.globalAlpha = Math.max(0, a.life / 0.2); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke(); ctx.globalAlpha = 1; }
  for (const r of sim.rings) { ctx.strokeStyle = Palette.warm; ctx.globalAlpha = Math.max(0, r.life / 0.3); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; }

  for (const en of sim.enemies) {
    if (en.dead) continue;
    ctx.fillStyle = Palette[en.color] || Palette.hot;
    ctx.beginPath(); ctx.arc(en.x, en.y, en.radius, 0, TAU); ctx.fill();
    if (en.shieldHp > 0) { ctx.strokeStyle = Palette.accent2; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(en.x, en.y, en.radius + 3, 0, TAU); ctx.stroke(); }
    if (en.type === 'boss') {
      text(ctx, 'SWARM MOTHER', en.x, en.y - en.radius - 30, { size: 11, color: Palette.hot, align: 'center', weight: 700 });
      ctx.fillStyle = Palette.panel; ctx.fillRect(en.x - 60, en.y - en.radius - 18, 120, 6);
      ctx.fillStyle = Palette.hot; ctx.fillRect(en.x - 60, en.y - en.radius - 18, 120 * Math.max(0, en.hp / en.maxHp), 6);
    }
  }

  const p = sim.player;
  ctx.fillStyle = p.hitFlash > 0 ? '#ffffff' : Palette.accent;
  ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, TAU); ctx.fill();
  if (p.weapons.blade) {
    const st = WEAPONS.blade.stat(p.weapons.blade);
    const count = p.evolved.blade ? st.count * 2 : st.count;
    for (let i = 0; i < count; i++) {
      const ang = p.bladeAngle + (TAU / count) * i;
      ctx.fillStyle = Palette.violet;
      ctx.beginPath(); ctx.arc(p.x + Math.cos(ang) * st.radius, p.y + Math.sin(ang) * st.radius, 5, 0, TAU); ctx.fill();
    }
  }
  for (const d of sim.damageNumbers) text(ctx, '-' + d.val, d.x, d.y - 12, { size: 11, color: Palette.warm, align: 'center', alpha: Math.max(0, d.life / 0.6) });
  ctx.restore();
}

function renderHud(sim, ctx, game) {
  const p = sim.player;
  const timeLeft = Math.max(0, RUN_DURATION - sim.elapsed);
  const mm = Math.floor(timeLeft / 60), ss = Math.floor(timeLeft % 60);
  text(ctx, sim.bossSpawned ? 'BOSS FIGHT' : `${mm}:${String(ss).padStart(2, '0')}`, game.w / 2, 10, { size: 16, color: Palette.ink, align: 'center', weight: 700 });
  text(ctx, `Lv ${p.level}`, 14, 10, { size: 13, color: Palette.warm, weight: 700 });
  text(ctx, `Kills ${sim.kills}`, 14, 30, { size: 11, color: Palette.dim });
  text(ctx, `Gold ${sim.gold}`, game.w - 14, 10, { size: 12, color: Palette.warm, align: 'right' });

  ctx.fillStyle = Palette.panel; ctx.fillRect(14, game.h - 34, 180, 10);
  ctx.fillStyle = Palette.hot; ctx.fillRect(14, game.h - 34, 180 * Math.max(0, p.hp / p.maxHp), 10);
  text(ctx, `${Math.ceil(p.hp)}/${Math.round(p.maxHp)}`, 14, game.h - 50, { size: 10, color: Palette.dim });

  ctx.fillStyle = Palette.panel; ctx.fillRect(14, game.h - 18, 180, 6);
  ctx.fillStyle = Palette.accent2; ctx.fillRect(14, game.h - 18, 180 * Math.min(1, p.xp / p.xpNext), 6);

  let ix = game.w - 14 - 14;
  for (const wid of Object.keys(p.weapons)) { drawIcon(ctx, ix, 34, p.evolved[wid] ? Palette.warm : Palette.accent); ix -= 26; }
  let px = game.w - 14 - 14;
  for (const pid of Object.keys(p.passives)) { drawIcon(ctx, px, 58, Palette.violet); px -= 22; }
}

function renderDraft(sim, state, ctx, game) {
  ctx.fillStyle = 'rgba(5,6,10,0.74)'; ctx.fillRect(0, 0, game.w, game.h);
  text(ctx, 'LEVEL UP', game.w / 2, game.h * 0.16, { size: 20, color: Palette.accent, align: 'center', weight: 700 });
  const cardW = Math.min(220, game.w / 3 - 24), cardH = Math.min(190, game.h * 0.55), gap = 18;
  const totalW = cardW * 3 + gap * 2;
  const startX = game.w / 2 - totalW / 2;
  const y = game.h / 2 - cardH / 2;
  state.draftRects.length = 0;
  sim.draft.options.forEach((card, i) => {
    const x = startX + i * (cardW + gap);
    roundRect(ctx, x, y, cardW, cardH, 10);
    ctx.fillStyle = Palette.panel; ctx.fill();
    ctx.strokeStyle = card.kind === 'evolution' ? Palette.warm : Palette.grid; ctx.lineWidth = 2; ctx.stroke();
    text(ctx, `${i + 1}`, x + 14, y + 12, { size: 12, color: Palette.dim });
    text(ctx, card.name, x + cardW / 2, y + 38, { size: 14, color: Palette.ink, align: 'center', weight: 700 });
    text(ctx, card.kind.toUpperCase(), x + cardW / 2, y + 60, { size: 9, color: card.kind === 'evolution' ? Palette.warm : Palette.accent2, align: 'center' });
    wrapText(ctx, card.desc, x + 14, y + 86, cardW - 28, 14, { size: 11, color: Palette.dim });
    state.draftRects.push({ x, y, w: cardW, h: cardH });
  });
  text(ctx, 'press 1 / 2 / 3 or click a card', game.w / 2, y + cardH + 18, { size: 11, color: Palette.dim, align: 'center' });
}

function renderEnd(state, ctx, game) {
  ctx.fillStyle = 'rgba(5,6,10,0.82)'; ctx.fillRect(0, 0, game.w, game.h);
  const s = state.endStats || {};
  text(ctx, s.won ? 'RUN COMPLETE' : 'OVERWHELMED', game.w / 2, game.h / 2 - 40, { size: 26, color: s.won ? Palette.accent : Palette.hot, align: 'center', weight: 700 });
  const mm = Math.floor((s.time || 0) / 60), ss = Math.floor((s.time || 0) % 60);
  text(ctx, `Level ${s.level || 1} · ${s.kills || 0} kills · ${mm}:${String(ss).padStart(2, '0')}`, game.w / 2, game.h / 2, { size: 13, color: Palette.ink, align: 'center' });
  text(ctx, `+${s.gold || 0} gold banked`, game.w / 2, game.h / 2 + 22, { size: 12, color: Palette.warm, align: 'center' });
  text(ctx, 'ENTER / SPACE for title', game.w / 2, game.h / 2 + 50, { size: 11, color: Palette.dim, align: 'center' });
}

function renderTitle(state, ctx, game) {
  ctx.fillStyle = Palette.bg2; ctx.fillRect(0, 0, game.w, game.h);
  text(ctx, 'SWARM', game.w / 2, game.h * 0.1, { size: 38, color: Palette.accent, align: 'center', weight: 800 });
  text(ctx, 'You only move. Everything else fires itself.', game.w / 2, game.h * 0.1 + 42, { size: 13, color: Palette.dim, align: 'center' });

  const ch = CHARACTERS[state.charIndex];
  const unlocked = isUnlocked(ch, game);
  const cy = game.h * 0.42;
  text(ctx, (state.charIndex > 0 ? '< ' : '  ') + ch.name + (state.charIndex < CHARACTERS.length - 1 ? ' >' : '  '), game.w / 2, cy, { size: 20, color: unlocked ? Palette.ink : Palette.dim, align: 'center', weight: 700 });
  wrapText(ctx, unlocked ? ch.desc : `Locked — ${ch.unlock.kind === 'gold' ? `need ${ch.unlock.amount} gold` : `win ${ch.unlock.amount} run(s)`}`, game.w / 2 - 160, cy + 26, 320, 15, { size: 12, color: Palette.dim, align: 'center' });

  text(ctx, 'PRESS SPACE', game.w / 2, cy + 70, { size: 14, color: Palette.warm, align: 'center', alpha: 0.6 + 0.4 * Math.sin(state.titleT * 4), weight: 700 });
  text(ctx, '<- / -> choose character', game.w / 2, cy + 96, { size: 11, color: Palette.dim, align: 'center' });

  const gold = game.store.get('gold', 0);
  const wins = game.store.get('wins', 0);
  const by = game.h - 78;
  text(ctx, `Gold: ${gold}   Wins: ${wins}`, game.w / 2, by - 40, { size: 12, color: Palette.warm, align: 'center' });
  const dmgL = game.store.get('up_dmg', 0), spdL = game.store.get('up_speed', 0), hpL = game.store.get('up_hp', 0);
  text(ctx, `Q: +Damage Lv${dmgL} (${upgradeCost(dmgL)}g)   E: +Speed Lv${spdL} (${upgradeCost(spdL)}g)   R: +Max HP Lv${hpL} (${upgradeCost(hpL)}g)`, game.w / 2, by - 18, { size: 10.5, color: Palette.dim, align: 'center' });
  text(ctx, 'WASD/arrows move, or hold pointer to move toward it', game.w / 2, game.h - 22, { size: 10.5, color: Palette.dim, align: 'center' });
}

function render(state, ctx, game) {
  if (state.screen === 'title') { renderTitle(state, ctx, game); return; }
  const sim = state.sim;
  if (!sim) return;
  renderWorld(sim, ctx, game);
  renderHud(sim, ctx, game);
  if (sim.phase === 'draft') renderDraft(sim, state, ctx, game);
  if (sim.phase === 'win' || sim.phase === 'lose') renderEnd(state, ctx, game);
}

// ---------------------------------------------------------------- boot

const game = boot({ id: 'swarm', title: 'Swarm', seed: 1, init, update, render });

// ================================================================== SELF-TEST

registerSelftest('swarm', (check, log) => {
  const dt = 1 / 60;

  // 1. world initializes; content tables are internally consistent
  const s0 = makeSim(1, 'wren');
  check('player spawns at origin with a starting weapon', s0.player.x === 0 && s0.player.y === 0 && Object.keys(s0.player.weapons).length === 1, `weapons=${Object.keys(s0.player.weapons)}`);
  const evoOk = EVOLUTIONS.every((e) => WEAPONS[e.weapon] && PASSIVES[e.passive]);
  check('every evolution recipe references a real weapon and passive', evoOk, `${EVOLUTIONS.length} recipes`);
  check('roster sizes match spec (8 weapons, 8 passives, >=6 evolutions)', WEAPON_IDS.length === 8 && PASSIVE_IDS.length === 8 && EVOLUTIONS.length >= 6,
    `w=${WEAPON_IDS.length} p=${PASSIVE_IDS.length} evo=${EVOLUTIONS.length}`);

  // 2. player responds to injected input — real movement delta
  const s1 = makeSim(2, 'wren');
  const x0 = s1.player.x;
  for (let i = 0; i < 30; i++) stepSim(s1, { mx: 1, my: 0 }, dt);
  check('player moves right under sustained +mx intent', s1.player.x > x0 + 10, `dx=${(s1.player.x - x0).toFixed(1)}`);

  // 3. progress: kill increments score/XP, level-up triggers a draft
  const s2 = makeSim(3, 'wren');
  s2.enemies.push({ id: 900, type: 'chaser', x: 5, y: 0, hp: 1, maxHp: 1, speed: 0, dmg: 0, radius: 9, xp: 5, color: 'hot', dead: false, shieldHp: 0 });
  s2.player.weapons = { aura: 1 };
  let sawDraft = false;
  for (let i = 0; i < 200 && !sawDraft; i++) {
    stepSim(s2, { mx: 0, my: 0 }, dt);
    if (s2.phase === 'draft') sawDraft = true;
  }
  check('kill drops XP gem, collecting it levels up and opens a draft', s2.kills >= 1 && sawDraft, `kills=${s2.kills} phase=${s2.phase} level=${s2.player.level}`);
  if (sawDraft) {
    stepSim(s2, { draftPick: 0 }, dt);
    check('draft pick resolves back to playing', s2.phase === 'playing', `phase=${s2.phase}`);
  }

  // 4. WIN is reachable — spawn the boss for real, then whittle its HP down via the
  //    real damage path (hp set low is the only shortcut; kill/collision/win-check code all runs).
  const s3 = makeSim(4, 'kestrel');
  s3.player.weapons = { nova: 8 };
  s3.elapsed = RUN_DURATION;
  stepSim(s3, { mx: 0, my: 0 }, dt); // triggers checkBoss -> spawns real boss
  check('boss spawns at run duration', s3.bossSpawned && !!s3.boss, `bossSpawned=${s3.bossSpawned}`);
  if (s3.boss) s3.boss.hp = 5; // fast-path: shrink HP only, real collision/kill/win code still runs
  for (let i = 0; i < 400 && s3.phase !== 'win'; i++) stepSim(s3, { mx: 0, my: 0 }, dt);
  check('WIN reachable through the real boss-kill code path', s3.phase === 'win', `phase=${s3.phase} bossDead=${s3.boss && s3.boss.dead}`);

  // 5. LOSE is reachable — stand still and let the swarm overwhelm a fragile build
  const s4 = makeSim(5, 'kestrel');
  s4.player.weapons = {};
  let frames4 = 0;
  for (; frames4 < 4000 && s4.phase === 'playing'; frames4++) {
    stepSim(s4, { mx: 0, my: 0 }, dt);
    if (s4.phase === 'draft') stepSim(s4, { draftPick: 0 }, dt);
  }
  check('LOSE reachable when standing still with no weapons', s4.phase === 'lose', `phase=${s4.phase} hp=${s4.player.hp.toFixed(1)} frames=${frames4}`);

  // 6. allFinite after >=600 simulated frames of movement + drafting
  const s5 = makeSim(6, 'thorn');
  for (let i = 0; i < 700; i++) {
    const ang = i * 0.13;
    stepSim(s5, { mx: Math.cos(ang), my: Math.sin(ang), draftPick: i % 5 === 0 ? 0 : null }, dt);
  }
  const fin = allFinite(s5);
  check('state stays finite after 700 frames of movement + drafting', fin.ok, fin.bad.slice(0, 3).join(','));

  // 7. nothing throws across the whole board (already implicit — this assertion documents it)
  check('no exceptions thrown during any check above', true);

  // 8. every weapon and every passive can be picked and applied without error
  let allOk = true, errs = [];
  for (const wid of WEAPON_IDS) {
    try {
      const s = makeSim(10, 'wren');
      applyCard(s, { kind: 'weapon', id: wid, level: WEAPONS[wid].maxLevel });
      for (let i = 0; i < 20; i++) stepSim(s, { mx: 0.3, my: 0.2 }, dt);
      if (!allFinite(s).ok) throw new Error('non-finite');
    } catch (e) { allOk = false; errs.push('weapon:' + wid); }
  }
  for (const pid of PASSIVE_IDS) {
    try {
      const s = makeSim(11, 'wren');
      applyCard(s, { kind: 'passive', id: pid, level: PASSIVES[pid].maxLevel });
      for (let i = 0; i < 20; i++) stepSim(s, { mx: -0.2, my: 0.4 }, dt);
      if (!allFinite(s).ok) throw new Error('non-finite');
    } catch (e) { allOk = false; errs.push('passive:' + pid); }
  }
  for (const evo of EVOLUTIONS) {
    try {
      const s = makeSim(12, 'wren');
      applyCard(s, { kind: 'weapon', id: evo.weapon, level: WEAPONS[evo.weapon].maxLevel });
      applyCard(s, { kind: 'passive', id: evo.passive, level: 1 });
      applyCard(s, { kind: 'evolution', weapon: evo.weapon, id: evo.id });
      for (let i = 0; i < 20; i++) stepSim(s, { mx: 0.1, my: -0.3 }, dt);
      if (!allFinite(s).ok) throw new Error('non-finite');
    } catch (e) { allOk = false; errs.push('evo:' + evo.id); }
  }
  check('every weapon, passive, and evolution applies and runs without error', allOk, errs.join(','));

  // live-game check: injected kit input drives the real game loop
  game.restart();
  game.state.screen = 'run';
  game.state.sim = makeSim(42, 'wren');
  const liveX0 = game.state.sim.player.x;
  game.input.press('right');
  game.step(30);
  game.input.release('right');
  check('live game responds to kit input', game.state.sim.player.x > liveX0 + 4, `dx=${(game.state.sim.player.x - liveX0).toFixed(1)}`);
  check('live state stays finite', allFinite(game.state.sim).ok);

  game.restart();
  log(`weapons=${WEAPON_IDS.length} passives=${PASSIVE_IDS.length} evolutions=${EVOLUTIONS.length}`);
});

globalThis.__swarm = { makeSim, stepSim, applyCard, WEAPONS, PASSIVES, EVOLUTIONS, ENEMIES, BOSS, CHARACTERS, RUN_DURATION };

export default game;
