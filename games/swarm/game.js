// Swarm — 10-minute bullet-heaven roguelite. Gamesx10 flagship.
//
// Shape (matches the house pattern): a PURE simulation — makeSim(seed, characterId, meta)
// and stepSim(sim, intent, dt) — driven by both the live game and the headless self-test.
// Nothing in the sim ever calls Math.random()/Date.now(); all randomness comes from
// sim.rng (seeded RNG), all timing from the fixed dt the kit hands to update().

import {
  boot, registerSelftest, Palette, FX, Sound, Store, RNG,
  clamp, lerp, dist, text, roundRect, allFinite, TAU,
  Type, HUD_H, hudStrip, stat, panel, meter, orb, vignette, titleCard, withGlow,
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
    // Purely presentational: death sites for this step, drained by the live game into
    // particle bursts and cleared at the top of every stepSim so headless runs stay bounded.
    fxKills: [],
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
  en.flash = 0.12; // render-only hit flash; nothing in the sim ever reads it
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
  if (sim.fxKills && sim.fxKills.length < 40) {
    sim.fxKills.push({ x: en.x, y: en.y, c: en.color || 'hot', big: en.type === 'boss' || en.type === 'elite' });
  }
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
    if (en.flash > 0) en.flash = Math.max(0, en.flash - dt);
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
  if (sim.fxKills) sim.fxKills.length = 0;
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
  return { screen: 'title', charIndex: 0, sim: null, draftRects: [], endStats: null, prevPhase: null, titleT: 0, draftT: 0 };
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
  const prevBoss = sim.bossSpawned;
  const intent = readIntent(game, state);
  stepSim(sim, intent, dt);

  // Kill sites the sim recorded this step become particle bursts. The sim never reads
  // them back, so this stays a one-way render feed and determinism is untouched.
  for (const k of sim.fxKills) {
    game.fx.burst(k.x, k.y, {
      count: k.big ? 26 : 6, color: Palette[k.c] || Palette.hot,
      speed: k.big ? 240 : 110, life: k.big ? 0.7 : 0.34, size: k.big ? 4 : 2.5, drag: 0.88,
    });
  }
  if (sim.player.hp < prevHp) {
    game.fx.shake(3);
    game.fx.burst(sim.player.x, sim.player.y, { count: 9, color: Palette.hot, speed: 150, life: 0.3, size: 3, drag: 0.88 });
  }
  if (sim.kills > prevKills && game.rng.next() < 0.25) game.sound.blip(480 + game.rng.next() * 260);
  if (!prevBoss && sim.bossSpawned) { game.fx.shake(14); game.sound.bad(); }

  if (sim.phase === 'draft') state.draftT += dt; else state.draftT = 0;
  if (prevPhase !== 'draft' && sim.phase === 'draft') { game.sound.ok(); game.fx.shake(5); state.draftT = 0; }
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
//
// Presentation only: everything below reads the sim and never writes to it.
//
// A bullet-heaven routinely has several hundred bodies on screen, so per-entity radial
// gradients and shadowBlur are not affordable at draw time. Each archetype is instead
// rendered ONCE — with its full halo, core and rim — into a small offscreen canvas and
// then blitted. That is both prettier than a flat arc and cheaper than one.

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SERIF = 'ui-serif, "New York", Palatino, Georgia, serif';

const hpColor = (f) => (f > 0.55 ? Palette.accent : f > 0.28 ? Palette.warm : Palette.hot);

// ---- offscreen sprite cache -------------------------------------------------

const SPRITES = new Map();

/** draw(c, size) runs once, with the origin already translated to the sprite centre. */
function sprite(key, size, draw) {
  let cv = SPRITES.get(key);
  if (cv) return cv;
  const dpr = 2;
  const s = Math.max(4, Math.ceil(size));
  cv = document.createElement('canvas');
  cv.width = Math.ceil(s * dpr);
  cv.height = Math.ceil(s * dpr);
  const c = cv.getContext('2d');
  c.scale(dpr, dpr);
  c.translate(s / 2, s / 2);
  draw(c, s);
  cv._size = s;
  if (SPRITES.size > 140) SPRITES.clear();
  SPRITES.set(key, cv);
  return cv;
}

function blit(ctx, cv, x, y, rot = 0, alpha = 1) {
  const s = cv._size;
  const fade = alpha !== 1;
  if (fade) { ctx.save(); ctx.globalAlpha = alpha; }
  if (rot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.drawImage(cv, -s / 2, -s / 2, s, s);
    ctx.restore();
  } else {
    ctx.drawImage(cv, x - s / 2, y - s / 2, s, s);
  }
  if (fade) ctx.restore();
}

// ---- tiling patterns (backdrop) --------------------------------------------

const PATTERNS = new Map();

function patternOf(ctx, key, size, draw) {
  let p = PATTERNS.get(key);
  if (p !== undefined) return p;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  draw(cv.getContext('2d'), size);
  p = ctx.createPattern(cv, 'repeat');
  PATTERNS.set(key, p);
  return p;
}

/** Offset a scroll position into [-m, 0) so a repeating fill lines up seamlessly. */
function wrapOffset(v, m) { return ((v % m) + m) % m - m; }

function fillPattern(ctx, pat, ox, oy, w, h) {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = pat;
  ctx.fillRect(-ox, -oy, w, h);
  ctx.restore();
}

const GRID_TILE = 96;
function drawGridTile(c, s) {
  c.fillStyle = 'rgba(23,29,44,0.5)';           // minor line, half-cell
  c.fillRect(s / 2, 0, 1, s);
  c.fillRect(0, s / 2, s, 1);
  c.fillStyle = 'rgba(38,49,74,0.95)';          // major line, full cell
  c.fillRect(0, 0, 1, s);
  c.fillRect(0, 0, s, 1);
}

const STAR_TILE = 300;
function drawStarTile(c, s, layer) {
  const r = new RNG(4177 + layer * 977);
  const n = 20 + layer * 6;
  for (let i = 0; i < n; i++) {
    const x = 4 + r.next() * (s - 8);
    const y = 4 + r.next() * (s - 8);
    const rad = 0.5 + layer * 0.45 + r.next() * 0.7;
    c.globalAlpha = 0.07 + layer * 0.09 + r.next() * 0.11;
    c.fillStyle = layer === 2 ? Palette.ink : Palette.dim;
    c.beginPath();
    c.arc(x, y, rad, 0, TAU);
    c.fill();
  }
  c.globalAlpha = 1;
}

/**
 * Deep wash + three parallax star layers + an aligned world grid. Four full-screen
 * fills, all pattern-based, which is what kills the "empty debug canvas" feeling
 * without costing anything per entity.
 */
function drawBackdrop(ctx, game, camX, camY, ox, oy, showGrid) {
  const grad = ctx.createRadialGradient(
    game.w / 2, game.h * 0.46, 0,
    game.w / 2, game.h * 0.46, Math.max(game.w, game.h) * 0.72,
  );
  grad.addColorStop(0, '#101627');
  grad.addColorStop(0.5, Palette.bg2);
  grad.addColorStop(1, Palette.bg);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, game.w, game.h);

  for (let L = 0; L < 3; L++) {
    const par = 0.14 + L * 0.2;
    const pat = patternOf(ctx, 'stars' + L, STAR_TILE, (c, s) => drawStarTile(c, s, L));
    if (!pat) continue;
    fillPattern(ctx, pat,
      wrapOffset(game.w / 2 - camX * par, STAR_TILE),
      wrapOffset(game.h / 2 - camY * par, STAR_TILE),
      game.w, game.h);
  }

  if (showGrid) {
    const gpat = patternOf(ctx, 'grid', GRID_TILE, drawGridTile);
    if (gpat) fillPattern(ctx, gpat, wrapOffset(ox, GRID_TILE), wrapOffset(oy, GRID_TILE), game.w, game.h);
  }
}

// ---- entity sprites ---------------------------------------------------------

const orbSize = (r, glow) => Math.ceil(r * (2.2 + glow) * 2 + 8);

function flashSprite(r) {
  const rr = Math.round(r * 2) / 2;
  return sprite('flash:' + rr, orbSize(rr, 0.7), (c) => {
    withGlow(c, '#ffffff', 14, () => {
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(0, 0, rr * 1.06, 0, TAU);
      c.fill();
    });
  });
}

function drawEnemyArt(c, type, r, col) {
  if (type === 'charger') {
    // an arrowhead, so a charge telegraphs its direction at a glance
    withGlow(c, col, 15, () => {
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(r * 1.55, 0);
      c.lineTo(-r * 0.95, -r * 1.05);
      c.lineTo(-r * 0.4, 0);
      c.lineTo(-r * 0.95, r * 1.05);
      c.closePath();
      c.fill();
    });
    c.strokeStyle = 'rgba(255,255,255,0.6)';
    c.lineWidth = Math.max(1, r * 0.16);
    c.beginPath();
    c.moveTo(r * 1.55, 0);
    c.lineTo(-r * 0.95, -r * 1.05);
    c.stroke();
    return;
  }

  if (type === 'shielded') {
    withGlow(c, col, 13, () => {
      c.fillStyle = col;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * TAU / 6;
        const x = Math.cos(a) * r * 1.14, y = Math.sin(a) * r * 1.14;
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.closePath();
      c.fill();
    });
    c.strokeStyle = 'rgba(233,237,247,0.6)';
    c.lineWidth = Math.max(1.2, r * 0.16);
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = i * TAU / 6;
      const x = Math.cos(a) * r * 1.14, y = Math.sin(a) * r * 1.14;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.closePath();
    c.stroke();
    return;
  }

  if (type === 'elite') {
    withGlow(c, col, 22, () => {
      c.strokeStyle = col;
      c.lineWidth = Math.max(1.5, r * 0.2);
      for (let i = 0; i < 8; i++) {
        const a = i * TAU / 8;
        c.beginPath();
        c.moveTo(Math.cos(a) * r * 1.05, Math.sin(a) * r * 1.05);
        c.lineTo(Math.cos(a) * r * 1.6, Math.sin(a) * r * 1.6);
        c.stroke();
      }
    });
    orb(c, 0, 0, r, col, { glow: 1.1 });
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = Math.max(1, r * 0.12);
    c.beginPath();
    c.arc(0, 0, r * 0.62, 0, TAU);
    c.stroke();
    return;
  }

  if (type === 'ranged') {
    orb(c, 0, 0, r, col, { glow: 0.8 });
    c.strokeStyle = col;
    c.globalAlpha = 0.85;
    c.lineWidth = Math.max(1, r * 0.16);
    for (let i = 0; i < 3; i++) {
      const a = i * TAU / 3;
      c.beginPath();
      c.arc(0, 0, r * 1.5, a, a + 0.7);
      c.stroke();
    }
    c.globalAlpha = 1;
    return;
  }

  if (type === 'splitter') {
    orb(c, 0, 0, r, col, { glow: 0.85 });
    c.strokeStyle = 'rgba(7,8,13,0.75)';
    c.lineWidth = Math.max(1.2, r * 0.2);
    c.beginPath();
    c.moveTo(0, -r * 0.94);
    c.lineTo(0, r * 0.94);
    c.stroke();
    return;
  }

  // chaser, swarmer and anything unclassified
  orb(c, 0, 0, r, col, { glow: type === 'swarmer' ? 0.6 : 0.95 });
}

function enemySprite(type, radius, colorKey) {
  const r = Math.max(2, Math.round(radius * 2) / 2);
  const key = `e:${type}:${r}:${colorKey}`;
  return sprite(key, Math.ceil(r * 6.6 + 14), (c) => drawEnemyArt(c, type, r, Palette[colorKey] || Palette.hot));
}

function playerSprite() {
  return sprite('player', orbSize(PLAYER_RADIUS, 1.2), (c) => {
    orb(c, 0, 0, PLAYER_RADIUS, Palette.accent, { glow: 1.2 });
    c.fillStyle = 'rgba(7,8,13,0.55)';
    c.beginPath(); c.arc(0, 0, PLAYER_RADIUS * 0.52, 0, TAU); c.fill();
    c.fillStyle = '#eafff6';
    c.beginPath(); c.arc(0, 0, PLAYER_RADIUS * 0.27, 0, TAU); c.fill();
  });
}

function gemSprite() {
  return sprite('gem', 26, (c) => {
    withGlow(c, Palette.accent2, 13, () => {
      c.fillStyle = Palette.accent2;
      c.beginPath();
      c.moveTo(0, -5.8); c.lineTo(4.2, 0); c.lineTo(0, 5.8); c.lineTo(-4.2, 0);
      c.closePath(); c.fill();
    });
    c.fillStyle = '#dcefff';
    c.beginPath();
    c.moveTo(0, -3); c.lineTo(2.1, -0.3); c.lineTo(0, 1.7); c.lineTo(-2.1, -0.3);
    c.closePath(); c.fill();
  });
}

function projSprite(fromPlayer, r) {
  const rr = clamp(Math.round(r), 2, 18);
  const col = fromPlayer ? Palette.accent : Palette.hot;
  return sprite(`pr:${fromPlayer ? 1 : 0}:${rr}`, orbSize(rr, 1), (c) => {
    orb(c, 0, 0, rr, col, { glow: 1, rim: false });
    c.fillStyle = fromPlayer ? '#e8fff7' : '#ffe0e6';
    c.beginPath(); c.arc(0, 0, Math.max(1, rr * 0.45), 0, TAU); c.fill();
  });
}

function bladeSprite() {
  return sprite('blade', 34, (c) => {
    withGlow(c, Palette.violet, 14, () => {
      c.fillStyle = Palette.violet;
      c.beginPath();
      c.moveTo(7, 0); c.lineTo(0, -4.6); c.lineTo(-7, 0); c.lineTo(0, 4.6);
      c.closePath(); c.fill();
    });
    c.fillStyle = '#e6d8ff';
    c.beginPath();
    c.moveTo(4, 0); c.lineTo(0, -2.2); c.lineTo(-4, 0); c.lineTo(0, 2.2);
    c.closePath(); c.fill();
  });
}

function mineSprite() {
  return sprite('mine', 40, (c) => {
    withGlow(c, Palette.warm, 14, () => {
      c.strokeStyle = Palette.warm;
      c.lineWidth = 2;
      c.beginPath(); c.arc(0, 0, 7, 0, TAU); c.stroke();
      for (let i = 0; i < 4; i++) {
        const a = i * TAU / 4 + Math.PI / 4;
        c.beginPath();
        c.moveTo(Math.cos(a) * 7, Math.sin(a) * 7);
        c.lineTo(Math.cos(a) * 11, Math.sin(a) * 11);
        c.stroke();
      }
    });
    c.fillStyle = Palette.warm;
    c.beginPath(); c.arc(0, 0, 2.6, 0, TAU); c.fill();
  });
}

// ---- glyphs (loadout chips + draft cards) -----------------------------------

/** Simple vector marks so weapons and passives are identifiable without labels. */
function glyph(ctx, id, x, y, r, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.2, r * 0.16);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const ring = (rr, a0, a1) => { ctx.beginPath(); ctx.arc(0, 0, rr, a0 == null ? 0 : a0, a1 == null ? TAU : a1); ctx.stroke(); };
  const dot = (dx, dy, rr) => { ctx.beginPath(); ctx.arc(dx, dy, rr, 0, TAU); ctx.fill(); };
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  const poly = (pts, fill) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) { if (i) ctx.lineTo(pts[i], pts[i + 1]); else ctx.moveTo(pts[i], pts[i + 1]); }
    ctx.closePath();
    if (fill) ctx.fill(); else ctx.stroke();
  };

  switch (id) {
    // weapons
    case 'blade': ring(r * 0.72); dot(r, 0, r * 0.26); dot(-r * 0.5, r * 0.86, r * 0.26); dot(-r * 0.5, -r * 0.86, r * 0.26); break;
    case 'bolt': ctx.beginPath(); ctx.moveTo(r * 0.4, -r); ctx.lineTo(-r * 0.35, -r * 0.05); ctx.lineTo(r * 0.2, -r * 0.05); ctx.lineTo(-r * 0.45, r); ctx.stroke(); break;
    case 'nova': ring(r); ring(r * 0.55); dot(0, 0, r * 0.18); break;
    case 'lance': line(-r, r, r * 0.7, -r * 0.7); poly([r, -r, r * 0.18, -r * 0.86, r * 0.86, -r * 0.18], true); break;
    case 'spray': line(-r * 0.7, r * 0.5, r * 0.9, -r * 0.85); line(-r * 0.9, 0, r * 0.5, -r); line(-r * 0.3, r * 0.95, r, -r * 0.3); break;
    case 'aura': ctx.setLineDash([r * 0.35, r * 0.35]); ring(r); ctx.setLineDash([]); dot(0, 0, r * 0.3); break;
    case 'chain': dot(-r * 0.85, -r * 0.6, r * 0.24); dot(r * 0.85, r * 0.6, r * 0.24); ctx.beginPath(); ctx.moveTo(-r * 0.6, -r * 0.4); ctx.lineTo(0, r * 0.12); ctx.lineTo(r * 0.18, -r * 0.24); ctx.lineTo(r * 0.6, r * 0.4); ctx.stroke(); break;
    case 'mine': ring(r * 0.52); for (let i = 0; i < 6; i++) { const a = i * TAU / 6; line(Math.cos(a) * r * 0.68, Math.sin(a) * r * 0.68, Math.cos(a) * r, Math.sin(a) * r); } break;
    // passives
    case 'might': poly([0, -r, r * 0.85, r * 0.7, -r * 0.85, r * 0.7], true); break;
    case 'haste': ctx.beginPath(); ctx.moveTo(-r, -r * 0.8); ctx.lineTo(-r * 0.12, 0); ctx.lineTo(-r, r * 0.8); ctx.stroke(); ctx.beginPath(); ctx.moveTo(r * 0.12, -r * 0.8); ctx.lineTo(r, 0); ctx.lineTo(r * 0.12, r * 0.8); ctx.stroke(); break;
    case 'focus': ring(r * 0.6); line(-r, 0, -r * 0.32, 0); line(r * 0.32, 0, r, 0); line(0, -r, 0, -r * 0.32); line(0, r * 0.32, 0, r); break;
    case 'vigor': line(0, -r, 0, r); line(-r, 0, r, 0); break;
    case 'magnet': ctx.beginPath(); ctx.arc(0, r * 0.1, r * 0.8, Math.PI, 0); ctx.stroke(); line(-r * 0.8, r * 0.1, -r * 0.8, r * 0.85); line(r * 0.8, r * 0.1, r * 0.8, r * 0.85); break;
    case 'armor': poly([0, -r, r * 0.85, -r * 0.5, r * 0.6, r * 0.8, 0, r, -r * 0.6, r * 0.8, -r * 0.85, -r * 0.5], false); break;
    case 'growth': line(-r, r * 0.8, -r * 0.1, -r * 0.15); line(-r * 0.1, -r * 0.15, r * 0.95, -r * 0.9); poly([r, -r, r * 0.2, -r * 0.88, r * 0.88, -r * 0.2], true); break;
    case 'wide': line(-r * 0.25, 0, -r, 0); line(r * 0.25, 0, r, 0); ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(-r * 0.5, -r * 0.45); ctx.moveTo(-r, 0); ctx.lineTo(-r * 0.5, r * 0.45); ctx.moveTo(r, 0); ctx.lineTo(r * 0.5, -r * 0.45); ctx.moveTo(r, 0); ctx.lineTo(r * 0.5, r * 0.45); ctx.stroke(); break;
    default: ring(r * 0.7); dot(0, 0, r * 0.22);
  }
  ctx.restore();
}

// ---- text helpers -----------------------------------------------------------

/** Word-wrap. Returns the y just past the last line drawn. */
function wrapText(ctx, str, x, y, maxW, lh, opts) {
  const o = opts || {};
  ctx.font = `${o.weight || 500} ${o.size}px ${o.font || MONO}`;
  const words = String(str).split(' ');
  const maxLines = o.maxLines || 99;
  let line = '', yy = y, drawn = 0;
  for (const wd of words) {
    const t = line + wd + ' ';
    if (ctx.measureText(t).width > maxW && line) {
      if (drawn + 1 >= maxLines) { line = line.trim() + '…'; break; }
      text(ctx, line.trim(), x, yy, o);
      drawn++;
      line = wd + ' ';
      yy += lh;
    } else line = t;
  }
  if (line) { text(ctx, line.trim(), x, yy, o); yy += lh; }
  return yy;
}

/** Deterministic 0..1 from two numbers — jitter that does not shimmer frame to frame. */
function hash2(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// ---- world ------------------------------------------------------------------

function drawBoss(ctx, sim, en) {
  const r = en.radius;
  ctx.save();

  const halo = ctx.createRadialGradient(en.x, en.y, r * 0.6, en.x, en.y, r * 3.2);
  halo.addColorStop(0, 'rgba(255,77,109,0.34)');
  halo.addColorStop(0.5, 'rgba(255,77,109,0.10)');
  halo.addColorStop(1, 'rgba(255,77,109,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(en.x, en.y, r * 3.2, 0, TAU); ctx.fill();

  const body = ctx.createRadialGradient(en.x - r * 0.32, en.y - r * 0.36, r * 0.1, en.x, en.y, r);
  body.addColorStop(0, '#ffa8b8');
  body.addColorStop(0.5, Palette.hot);
  body.addColorStop(1, '#4d0d1c');
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(en.x, en.y, r, 0, TAU); ctx.fill();

  ctx.translate(en.x, en.y);
  ctx.rotate(sim.t * 0.5);
  ctx.strokeStyle = 'rgba(255,77,109,0.75)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, r * 1.34, 0.4, 2.6); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 1.34, 3.6, 5.8); ctx.stroke();
  ctx.rotate(-sim.t * 1.4);
  ctx.strokeStyle = 'rgba(255,200,87,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, r * 1.78, 1.2, 3.1); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 1.78, 4.3, 6.2); ctx.stroke();
  ctx.restore();

  text(ctx, 'THE SWARM MOTHER', en.x, en.y - r - 30, {
    size: Type.label, color: Palette.hot, align: 'center', weight: 700,
  });
}

function renderWorld(sim, ctx, game) {
  const p = sim.player;
  const ox = game.w / 2 - p.x, oy = game.h / 2 - p.y;
  const stats = computeStats(sim);

  drawBackdrop(ctx, game, p.x, p.y, ox, oy, true);

  ctx.save();
  ctx.translate(ox, oy);

  const padX = game.w / 2 + 80, padY = game.h / 2 + 80;
  const vis = (x, y) => Math.abs(x - p.x) < padX && Math.abs(y - p.y) < padY;

  // --- pickup radius: a quiet ring that makes the Magnet passive legible
  const pr = PICKUP_BASE * stats.pickupMul;
  ctx.save();
  ctx.strokeStyle = Palette.accent2;
  ctx.globalAlpha = 0.09;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 9]);
  ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // --- mines
  const minePulse = 0.55 + 0.45 * Math.sin(sim.t * 9);
  const mspr = mineSprite();
  for (const m of sim.mines) {
    if (!vis(m.x, m.y)) continue;
    blit(ctx, mspr, m.x, m.y, 0, 0.5 + minePulse * 0.5);
  }

  // --- xp gems
  const gspr = gemSprite();
  const shimmer = 0.82 + 0.18 * Math.sin(sim.t * 4.5);
  for (const g of sim.gems) {
    if (!vis(g.x, g.y)) continue;
    blit(ctx, gspr, g.x, g.y, 0, shimmer);
  }

  // --- nova rings
  for (const rg of sim.rings) {
    const f = clamp(rg.life / 0.3, 0, 1);
    ctx.save();
    ctx.globalAlpha = f * 0.85;
    ctx.strokeStyle = Palette.warm;
    ctx.shadowColor = Palette.warm;
    ctx.shadowBlur = 16;
    ctx.lineWidth = 2 + (1 - f) * 3;
    ctx.beginPath();
    ctx.arc(rg.x, rg.y, rg.r * (0.84 + (1 - f) * 0.16), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // --- railgun beams: wide soft pass, then a hot core
  for (const b of sim.beams) {
    const f = clamp(b.life / 0.15, 0, 1);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalAlpha = f * 0.3;
    ctx.strokeStyle = Palette.accent2;
    ctx.lineWidth = 16 * f;
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
    ctx.globalAlpha = f;
    ctx.strokeStyle = '#dff1ff';
    ctx.lineWidth = 3 * f + 1;
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
    ctx.restore();
  }

  // --- chain arcs, jittered into lightning
  for (const a of sim.arcs) {
    const f = clamp(a.life / 0.2, 0, 1);
    const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    ctx.save();
    ctx.globalAlpha = f;
    ctx.strokeStyle = Palette.violet;
    ctx.shadowColor = Palette.violet;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      const j = (hash2(a.x1 + i * 31, a.y1 + i * 17) - 0.5) * Math.min(22, len * 0.28);
      ctx.lineTo(a.x1 + dx * t + nx * j, a.y1 + dy * t + ny * j);
    }
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
    ctx.restore();
  }

  // --- enemies
  for (const en of sim.enemies) {
    if (en.dead || !vis(en.x, en.y)) continue;
    if (en.type === 'boss') { drawBoss(ctx, sim, en); continue; }

    let rot = 0;
    if (en.type === 'charger') {
      rot = en.charging && en.chargeDirX != null
        ? Math.atan2(en.chargeDirY, en.chargeDirX)
        : Math.atan2(p.y - en.y, p.x - en.x);
    } else if (en.type === 'elite') rot = sim.t * 0.9;
    else if (en.type === 'ranged') rot = -sim.t * 0.7;

    blit(ctx, enemySprite(en.type, en.radius, en.color), en.x, en.y, rot);

    if (en.charging && en.chargeTimer > 0) {
      ctx.save();
      ctx.strokeStyle = Palette.hot;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(en.x, en.y, en.radius + 4 + (en.chargeTimer / 0.6) * 12, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    if (en.shieldHp > 0) {
      ctx.save();
      ctx.strokeStyle = Palette.accent2;
      ctx.globalAlpha = 0.35 + 0.45 * clamp(en.shieldHp / 30, 0, 1);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(en.x, en.y, en.radius + 5, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    if (en.flash > 0) blit(ctx, flashSprite(en.radius), en.x, en.y, 0, clamp(en.flash / 0.12, 0, 1) * 0.85);
  }

  // --- projectiles, with a motion streak so fast shots read as motion not dots
  for (const proj of sim.projectiles) {
    if (proj.dead || !vis(proj.x, proj.y)) continue;
    const mine = proj.from === 'player';
    const r = clamp(proj.hitRadius || 4, 2, 18);
    const sp = Math.hypot(proj.vx, proj.vy);
    if (sp > 40) {
      const k = Math.min(0.06, 16 / sp);
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = mine ? Palette.accent : Palette.hot;
      ctx.lineCap = 'round';
      ctx.lineWidth = r * 1.15;
      ctx.beginPath();
      ctx.moveTo(proj.x - proj.vx * k, proj.y - proj.vy * k);
      ctx.lineTo(proj.x, proj.y);
      ctx.stroke();
      ctx.restore();
    }
    blit(ctx, projSprite(mine, r), proj.x, proj.y);
  }

  // --- player
  const hpFrac = clamp(p.hp / Math.max(1, p.maxHp), 0, 1);
  blit(ctx, playerSprite(), p.x, p.y);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.facing || 0);
  ctx.fillStyle = 'rgba(233,237,247,0.9)';
  ctx.beginPath();
  ctx.moveTo(PLAYER_RADIUS + 8, 0);
  ctx.lineTo(PLAYER_RADIUS - 1, -4.6);
  ctx.lineTo(PLAYER_RADIUS - 1, 4.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (p.hitFlash > 0) blit(ctx, flashSprite(PLAYER_RADIUS), p.x, p.y, 0, clamp(p.hitFlash / 0.15, 0, 1));
  if (hpFrac < 0.7) {
    meter(ctx, p.x - 23, p.y + PLAYER_RADIUS + 10, 46, 5, hpFrac,
      { color: hpColor(hpFrac), track: 'rgba(0,0,0,0.6)', glow: false });
  }

  // --- orbiting blades
  if (p.weapons.blade) {
    const st = WEAPONS.blade.stat(p.weapons.blade);
    const count = p.evolved.blade ? st.count * 2 : st.count;
    ctx.save();
    ctx.strokeStyle = Palette.violet;
    ctx.globalAlpha = 0.13;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, st.radius, 0, TAU); ctx.stroke();
    ctx.restore();
    const bspr = bladeSprite();
    for (let i = 0; i < count; i++) {
      const ang = p.bladeAngle + (TAU / count) * i;
      blit(ctx, bspr, p.x + Math.cos(ang) * st.radius, p.y + Math.sin(ang) * st.radius, ang + Math.PI / 2);
    }
  }

  FX.draw(ctx);

  // --- damage numbers, popped and outlined so they stay readable over the swarm
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6,7,12,0.9)';
  ctx.lineWidth = 3;
  for (const d of sim.damageNumbers) {
    if (!vis(d.x, d.y)) continue;
    const f = clamp(d.life / 0.6, 0, 1);
    const pop = 1 + Math.max(0, f - 0.86) * 2.2;
    const size = (11 + Math.min(6, d.val / 22)) * pop;
    const yy = d.y - 15 - (1 - f) * 26;
    ctx.globalAlpha = f < 0.35 ? f / 0.35 : 1;
    ctx.font = `700 ${size.toFixed(1)}px ${MONO}`;
    ctx.strokeText(String(d.val), d.x, yy);
    ctx.fillStyle = d.val >= 40 ? Palette.warm : '#ffe7b8';
    ctx.fillText(String(d.val), d.x, yy);
  }
  ctx.restore();

  ctx.restore();
}

// ---- HUD --------------------------------------------------------------------

function loadoutChip(ctx, x, y, size, id, level, color) {
  panel(ctx, x, y, size, size, {
    fill: 'rgba(17,22,36,0.9)', border: 'rgba(120,132,156,0.34)', radius: 6,
    glowColor: color, glowBlur: 9,
  });
  glyph(ctx, id, x + size / 2, y + size / 2 - 1, size * 0.28, color);
  text(ctx, String(level), x + size - 3, y + size - 2, {
    size: Type.micro, color: Palette.dim, align: 'right', baseline: 'bottom', weight: 700,
  });
}

function renderHud(sim, state, ctx, game) {
  const p = sim.player;
  const compact = game.w < 780;

  hudStrip(ctx, game, { h: HUD_H });

  // Full-width XP bar welded to the underside of the strip — genre convention, and it
  // turns the dead band under the HUD into the run's most-read piece of information.
  meter(ctx, 0, HUD_H + 1, game.w, 5, clamp(p.xp / Math.max(1, p.xpNext), 0, 1), {
    color: Palette.accent2, track: 'rgba(255,255,255,0.05)', radius: 0,
  });

  const vs = compact ? 20 : Type.value;
  const y = 20;
  stat(ctx, 16, y, 'level', p.level, { color: Palette.warm, valueSize: vs });
  stat(ctx, 16 + (compact ? 76 : 100), y, 'kills', sim.kills, { valueSize: vs });

  const timeLeft = Math.max(0, RUN_DURATION - sim.elapsed);
  const mm = Math.floor(timeLeft / 60), ss = Math.floor(timeLeft % 60);
  stat(ctx, game.w / 2, y,
    sim.bossSpawned ? 'final wave' : 'time left',
    sim.bossSpawned ? 'BOSS' : `${mm}:${String(ss).padStart(2, '0')}`,
    { align: 'center', color: sim.bossSpawned ? Palette.hot : Palette.ink, valueSize: vs });

  stat(ctx, game.w - 16, y, 'gold', sim.gold, { align: 'right', color: Palette.warm, valueSize: vs });

  // boss health, directly under the strip
  if (sim.boss && !sim.boss.dead) {
    const bw = Math.min(520, game.w - 120);
    const bx = game.w / 2 - bw / 2, by = HUD_H + 26;
    text(ctx, 'THE SWARM MOTHER', game.w / 2, by - 3, {
      size: Type.label, color: Palette.hot, align: 'center', weight: 700, baseline: 'bottom',
    });
    meter(ctx, bx, by, bw, 9, clamp(sim.boss.hp / Math.max(1, sim.boss.maxHp), 0, 1), { color: Palette.hot });
  }

  // hull
  const hw = clamp(game.w * 0.24, 130, 280);
  const hf = clamp(p.hp / Math.max(1, p.maxHp), 0, 1);
  const hy = game.h - 34;
  text(ctx, 'HULL', 16, hy - 17, { size: Type.label, color: Palette.dim, weight: 600 });
  text(ctx, `${Math.ceil(p.hp)} / ${Math.round(p.maxHp)}`, 16 + hw, hy - 17, {
    size: Type.label, color: hpColor(hf), align: 'right', weight: 700,
  });
  meter(ctx, 16, hy, hw, 12, hf, { color: hpColor(hf) });

  // loadout
  const cs = compact ? 22 : 26, gap = 5;
  const passiveY = game.h - 22 - cs;
  const weaponY = passiveY - cs - gap;
  let wx = game.w - 16;
  for (const wid of Object.keys(p.weapons)) {
    wx -= cs;
    loadoutChip(ctx, wx, weaponY, cs, wid, p.weapons[wid], p.evolved[wid] ? Palette.warm : Palette.accent);
    wx -= gap;
  }
  let sx = game.w - 16;
  for (const pid of Object.keys(p.passives)) {
    sx -= cs;
    loadoutChip(ctx, sx, passiveY, cs, pid, p.passives[pid], Palette.violet);
    sx -= gap;
  }
}

// ---- draft ------------------------------------------------------------------

const CARD_TONE = {
  evolution: Palette.warm,
  weapon: Palette.accent,
  passive: Palette.violet,
  gold: Palette.dim,
};

function renderDraft(sim, state, ctx, game) {
  ctx.save();
  ctx.fillStyle = 'rgba(6,7,12,0.84)';
  ctx.fillRect(0, 0, game.w, game.h);
  ctx.restore();

  const ease = 1 - Math.pow(1 - clamp(state.draftT / 0.2, 0, 1), 3);
  const gap = clamp(game.w * 0.016, 12, 22);
  const cardW = Math.min(268, (game.w - gap * 4) / 3);
  const cardH = clamp(game.h * 0.46, 168, 238);
  const totalW = cardW * 3 + gap * 2;
  const startX = game.w / 2 - totalW / 2;
  const top = game.h / 2 - cardH / 2 + 12;

  withGlow(ctx, Palette.accent, 24, () => {
    text(ctx, 'LEVEL UP', game.w / 2, top - 78, {
      size: Math.min(38, game.w * 0.045), color: Palette.accent,
      align: 'center', weight: 700, font: SERIF,
    });
  });
  text(ctx, `LEVEL ${sim.player.level}  ·  CHOOSE ONE`, game.w / 2, top - 32, {
    size: Type.label, color: Palette.dim, align: 'center', weight: 600,
  });

  const ptr = game.input.pointer;
  state.draftRects.length = 0;

  ctx.save();
  ctx.globalAlpha = ease;
  const yOff = (1 - ease) * 20;

  sim.draft.options.forEach((card, i) => {
    const x = startX + i * (cardW + gap);
    const y = top + yOff;
    const tone = CARD_TONE[card.kind] || Palette.accent;
    const hot = ptr.x >= x && ptr.x <= x + cardW && ptr.y >= y && ptr.y <= y + cardH;

    panel(ctx, x, y, cardW, cardH, {
      fill: hot ? 'rgba(23,30,48,0.97)' : 'rgba(15,20,33,0.96)',
      border: hot ? tone : (card.kind === 'evolution' ? tone : Palette.grid),
      radius: 8, glowColor: hot || card.kind === 'evolution' ? tone : null, glowBlur: hot ? 26 : 16,
    });

    // keycap
    const kb = 26;
    panel(ctx, x + 13, y + 13, kb, kb, { fill: 'rgba(0,0,0,0.4)', border: tone, radius: 5 });
    text(ctx, String(i + 1), x + 13 + kb / 2, y + 13 + kb / 2, {
      size: Type.small, color: tone, align: 'center', baseline: 'middle', weight: 700,
    });

    text(ctx, card.kind.toUpperCase(), x + cardW - 13, y + 20, {
      size: Type.micro, color: tone, align: 'right', weight: 700,
    });

    glyph(ctx, card.id, x + cardW / 2, y + 78, 19, tone);

    const nameEnd = wrapText(ctx, card.name, x + cardW / 2, y + 106, cardW - 30, 21, {
      size: 17, color: Palette.ink, align: 'center', weight: 700, maxLines: 2,
    });
    wrapText(ctx, card.desc, x + cardW / 2, nameEnd + 8, cardW - 32, 16, {
      size: Type.small, color: Palette.dim, align: 'center', maxLines: 4,
    });

    // level pips
    const maxL = card.kind === 'weapon' ? (WEAPONS[card.id] || {}).maxLevel
      : card.kind === 'passive' ? (PASSIVES[card.id] || {}).maxLevel : 0;
    if (maxL) {
      const pw = 12, py = y + cardH - 18;
      const px0 = x + cardW / 2 - (maxL * pw) / 2;
      for (let k = 0; k < maxL; k++) {
        ctx.fillStyle = k < (card.level || 0) ? tone : 'rgba(255,255,255,0.10)';
        ctx.fillRect(px0 + k * pw, py, pw - 3, 3);
      }
    }

    state.draftRects.push({ x, y: top, w: cardW, h: cardH });
  });
  ctx.restore();

  text(ctx, 'PRESS 1 / 2 / 3  ·  OR CLICK A CARD', game.w / 2, top + cardH + 20, {
    size: Type.label, color: Palette.dim, align: 'center', weight: 600,
  });
}

// ---- end + title ------------------------------------------------------------

function renderEnd(state, ctx, game) {
  const s = state.endStats || {};
  const mm = Math.floor((s.time || 0) / 60), ss = Math.floor((s.time || 0) % 60);
  titleCard(ctx, game, {
    title: s.won ? 'RUN COMPLETE' : 'OVERWHELMED',
    tagline: `LEVEL ${s.level || 1}   ·   ${s.kills || 0} KILLS   ·   ${mm}:${String(ss).padStart(2, '0')}`,
    lines: [
      `+${s.gold || 0} gold banked`,
      s.won ? 'The Swarm Mother is down.' : 'The swarm closed in.',
    ],
    prompt: 'ENTER / SPACE — RETURN TO TITLE',
    t: game.t,
    accent: s.won ? Palette.accent : Palette.hot,
  });
}

function drawArrow(ctx, x, y, dir, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + dir * 6, y);
  ctx.lineTo(x - dir * 4, y - 7);
  ctx.lineTo(x - dir * 4, y + 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function renderTitle(state, ctx, game) {
  drawBackdrop(ctx, game, state.titleT * 13, -state.titleT * 8, 0, 0, false);
  vignette(ctx, game, 0.5);

  const gold = game.store.get('gold', 0);
  hudStrip(ctx, game, { h: HUD_H });
  stat(ctx, 16, 20, 'gold', gold, { color: Palette.warm });
  stat(ctx, game.w / 2, 20, 'wins', game.store.get('wins', 0), { align: 'center' });
  stat(ctx, game.w - 16, 20, 'best kills', game.store.get('bestKills', 0), { align: 'right' });

  const compact = game.h < 560;
  const tSize = clamp(game.w * 0.1, 34, 62);
  const charH = compact ? 96 : 116;
  const armH = compact ? 84 : 96;
  const blockH = tSize * 0.78 + 26 + 22 + charH + 34 + armH;
  let y = HUD_H + Math.max(16, (game.h - HUD_H - 34 - blockH) / 2);

  y += tSize * 0.78;
  withGlow(ctx, Palette.accent, 30, () => {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = Palette.accent;
    ctx.font = `700 ${tSize}px ${SERIF}`;
    ctx.fillText('SWARM', game.w / 2, y);
    ctx.restore();
  });
  y += 22;
  text(ctx, 'YOU ONLY MOVE. EVERYTHING ELSE FIRES ITSELF.', game.w / 2, y, {
    size: Type.label, color: Palette.dim, align: 'center', weight: 600,
  });
  y += 26;

  // --- operative
  const pw = Math.min(560, game.w - 40);
  const px = game.w / 2 - pw / 2;
  const ch = CHARACTERS[state.charIndex];
  const unlocked = isUnlocked(ch, game);
  panel(ctx, px, y, pw, charH, {
    title: 'operative', radius: 8,
    glowColor: unlocked ? Palette.accent : Palette.hot, glowBlur: 16,
  });
  drawArrow(ctx, px + 24, y + charH / 2 + 6, -1, state.charIndex > 0 ? Palette.ink : Palette.grid);
  drawArrow(ctx, px + pw - 24, y + charH / 2 + 6, 1, state.charIndex < CHARACTERS.length - 1 ? Palette.ink : Palette.grid);
  text(ctx, ch.name.toUpperCase(), game.w / 2, y + (compact ? 28 : 34), {
    size: compact ? 22 : 26, color: unlocked ? Palette.ink : Palette.dim,
    align: 'center', weight: 700, font: SERIF,
  });
  const desc = unlocked ? ch.desc
    : ch.unlock.kind === 'gold' ? `LOCKED — bank ${ch.unlock.amount} gold to recruit`
    : `LOCKED — win ${ch.unlock.amount} run to recruit`;
  wrapText(ctx, desc, game.w / 2, y + (compact ? 58 : 68), pw - 100, 16, {
    size: Type.small, color: unlocked ? Palette.dim : Palette.hot, align: 'center', maxLines: 2,
  });
  for (let i = 0; i < CHARACTERS.length; i++) {
    ctx.fillStyle = i === state.charIndex ? Palette.accent : Palette.grid;
    ctx.beginPath();
    ctx.arc(game.w / 2 + (i - (CHARACTERS.length - 1) / 2) * 13, y + charH - 13, 3, 0, TAU);
    ctx.fill();
  }
  y += charH + 12;

  const pulse = 0.5 + 0.5 * Math.sin(state.titleT * 3.4);
  text(ctx, unlocked ? 'PRESS SPACE TO DEPLOY' : 'LOCKED — CHOOSE ANOTHER OPERATIVE', game.w / 2, y, {
    size: Type.body, color: unlocked ? Palette.warm : Palette.hot,
    align: 'center', weight: 700, alpha: 0.45 + pulse * 0.55,
  });
  y += 22;

  // --- armory
  panel(ctx, px, y, pw, armH, { title: 'armory', radius: 8 });
  const cols = [
    { key: 'up_dmg', k: 'Q', label: 'damage', id: 'might' },
    { key: 'up_speed', k: 'E', label: 'speed', id: 'haste' },
    { key: 'up_hp', k: 'R', label: 'max hull', id: 'vigor' },
  ];
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    const lvl = game.store.get(c.key, 0);
    const cost = upgradeCost(lvl);
    const cxx = px + pw * ((i + 0.5) / 3);
    glyph(ctx, c.id, cxx - 44, y + 52, 9, Palette.dim);
    stat(ctx, cxx, y + 42, c.label, 'Lv ' + lvl, {
      align: 'center', valueSize: compact ? 18 : 20,
    });
    text(ctx, `[${c.k}]  ${cost}g`, cxx, y + (compact ? 66 : 70), {
      size: Type.label, color: gold >= cost ? Palette.warm : Palette.dim,
      align: 'center', weight: 700,
    });
  }

  text(ctx, 'WASD / ARROWS TO MOVE  ·  OR HOLD THE POINTER TO STEER  ·  1 2 3 TO DRAFT',
    game.w / 2, game.h - 20, { size: Type.micro, color: Palette.dim, align: 'center', alpha: 0.7 });
}

function render(state, ctx, game) {
  if (state.screen === 'title') { renderTitle(state, ctx, game); return; }
  const sim = state.sim;
  if (!sim) return;
  renderWorld(sim, ctx, game);
  vignette(ctx, game, 0.45);
  renderHud(sim, state, ctx, game);
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
