// Swarm — content tables. Pure data, no DOM, no randomness. Imported by both game.js
// and the self-test / verification scripts.

// ---------------------------------------------------------------- weapons
// Each weapon: id, name, desc, maxLevel, base stats, and a per-level stat curve fn.
// `fire(owner, sim, level, api)` is called by the sim's weapon-cooldown loop.

export const WEAPONS = {
  blade: {
    id: 'blade', name: 'Whirling Blade', nameZh: '旋风刃', icon: 'blade',
    desc: 'Spinning blades orbit you, cutting anything they touch.',
    descZh: '刀刃绕身旋转,触之即伤。',
    maxLevel: 8,
    stat(level) {
      return {
        count: 1 + Math.floor(level / 2),      // orbiting blades
        dmg: 6 + level * 2,
        radius: 34 + level * 2,
        speed: 2.2 + level * 0.12,
      };
    },
  },
  bolt: {
    id: 'bolt', name: 'Auto Bolt', nameZh: '追踪弩', icon: 'bolt',
    desc: 'Fires a homing bolt at the nearest enemy on a timer.',
    descZh: '定时向最近的敌人发射追踪弩箭。',
    maxLevel: 8,
    stat(level) {
      return {
        cooldown: Math.max(0.18, 0.85 - level * 0.08),
        dmg: 8 + level * 3,
        count: 1 + Math.floor(level / 3),
        speed: 260,
      };
    },
  },
  nova: {
    id: 'nova', name: 'Nova Pulse', nameZh: '新星脉冲', icon: 'nova',
    desc: 'Periodically detonates a damaging ring centered on you.',
    descZh: '周期性以自身为中心引爆伤害光环。',
    maxLevel: 8,
    stat(level) {
      return {
        cooldown: Math.max(0.9, 2.6 - level * 0.2),
        dmg: 10 + level * 4,
        radius: 60 + level * 8,
      };
    },
  },
  lance: {
    id: 'lance', name: 'Piercing Lance', nameZh: '贯穿长枪', icon: 'lance',
    desc: 'Launches a straight lance that pierces every enemy in its path.',
    descZh: '发射一支直线长枪,贯穿路径上的所有敌人。',
    maxLevel: 8,
    stat(level) {
      return {
        cooldown: Math.max(0.5, 1.4 - level * 0.11),
        dmg: 12 + level * 5,
        speed: 380,
        width: 8 + level,
      };
    },
  },
  spray: {
    id: 'spray', name: 'Shot Spray', nameZh: '散射弹幕', icon: 'spray',
    desc: 'Fans out a spread of short-range pellets at the nearest cluster.',
    descZh: '朝最近的敌群扇形射出一片近程弹丸。',
    maxLevel: 8,
    stat(level) {
      return {
        cooldown: Math.max(0.35, 1.1 - level * 0.08),
        dmg: 4 + level * 1.5,
        pellets: 3 + Math.floor(level / 2),
        speed: 300,
        range: 180,
      };
    },
  },
  aura: {
    id: 'aura', name: 'Static Aura', nameZh: '静电光环', icon: 'aura',
    desc: 'A constant damage field that ticks on every enemy touching you.',
    descZh: '持续伤害力场,对接触到你的敌人不断造成伤害。',
    maxLevel: 8,
    stat(level) {
      return {
        radius: 40 + level * 4,
        dps: 6 + level * 2.5,
      };
    },
  },
  chain: {
    id: 'chain', name: 'Chain Spark', nameZh: '连锁电击', icon: 'chain',
    desc: 'A bolt of electricity that arcs between nearby enemies.',
    descZh: '电弧在附近敌人之间连锁跳跃。',
    maxLevel: 8,
    stat(level) {
      return {
        cooldown: Math.max(0.4, 1.3 - level * 0.1),
        dmg: 7 + level * 2.5,
        jumps: 2 + Math.floor(level / 2),
        jumpRange: 110,
      };
    },
  },
  mine: {
    id: 'mine', name: 'Drop Mine', nameZh: '感应地雷', icon: 'mine',
    desc: 'Drops a proximity mine behind you that explodes on contact.',
    descZh: '在身后放置感应地雷,接触即爆炸。',
    maxLevel: 8,
    stat(level) {
      return {
        cooldown: Math.max(0.6, 1.8 - level * 0.14),
        dmg: 16 + level * 6,
        radius: 40 + level * 3,
        fuse: 3.0,
      };
    },
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

// ---------------------------------------------------------------- passives

export const PASSIVES = {
  might: { id: 'might', name: 'Might', nameZh: '力量', icon: 'might', desc: '+dmg to all weapons.', descZh: '提升所有武器的伤害。', maxLevel: 5, stat: (l) => ({ dmgMul: 1 + l * 0.14 }) },
  haste: { id: 'haste', name: 'Haste', nameZh: '疾行', icon: 'haste', desc: '+move speed.', descZh: '提升移动速度。', maxLevel: 5, stat: (l) => ({ speedMul: 1 + l * 0.09 }) },
  focus: { id: 'focus', name: 'Focus', nameZh: '专注', icon: 'focus', desc: '-weapon cooldowns.', descZh: '缩短武器冷却时间。', maxLevel: 5, stat: (l) => ({ cdMul: 1 - l * 0.09 }) },
  vigor: { id: 'vigor', name: 'Vigor', nameZh: '活力', icon: 'vigor', desc: '+max HP and regen.', descZh: '提升最大生命值并持续回血。', maxLevel: 5, stat: (l) => ({ hpMul: 1 + l * 0.16, regen: l * 0.4 }) },
  magnet: { id: 'magnet', name: 'Magnet', nameZh: '磁铁', icon: 'magnet', desc: '+XP pickup radius.', descZh: '扩大经验拾取范围。', maxLevel: 5, stat: (l) => ({ pickupMul: 1 + l * 0.35 }) },
  armor: { id: 'armor', name: 'Armor', nameZh: '护甲', icon: 'armor', desc: 'Flat damage reduction.', descZh: '固定减免受到的伤害。', maxLevel: 5, stat: (l) => ({ reduce: l * 1.2 }) },
  growth: { id: 'growth', name: 'Growth', nameZh: '成长', icon: 'growth', desc: '+XP gained from gems.', descZh: '提升经验宝石的获得量。', maxLevel: 5, stat: (l) => ({ xpMul: 1 + l * 0.15 }) },
  wide: { id: 'wide', name: 'Amplitude', nameZh: '振幅', icon: 'wide', desc: '+area/size of all weapon effects.', descZh: '扩大所有武器效果的范围。', maxLevel: 5, stat: (l) => ({ areaMul: 1 + l * 0.12 }) },
};

export const PASSIVE_IDS = Object.keys(PASSIVES);

// ---------------------------------------------------------------- evolutions
// requires: weapon at maxLevel + specific passive owned (any level >=1).
// Evolved weapons replace the base weapon's fire behavior entirely (distinct tag).

export const EVOLUTIONS = [
  { id: 'blade_evo', weapon: 'blade', passive: 'wide', name: 'Blade Storm', nameZh: '刃暴', desc: 'Doubles the blade ring and adds a knockback shockwave on every hit.', descZh: '刀刃数量翻倍,每次命中附带击退冲击波。' },
  { id: 'bolt_evo', weapon: 'bolt', passive: 'focus', name: 'Railgun', nameZh: '轨道炮', desc: 'Bolts become instant hitscan lines that pierce the whole map.', descZh: '弩箭变为瞬发贯穿全图的光线。' },
  { id: 'nova_evo', weapon: 'nova', passive: 'vigor', name: 'Heartstorm', nameZh: '心风暴', desc: 'Nova pulses continuously at low power and heals you per enemy hit.', descZh: '光环持续低功率脉动,每命中一个敌人回复生命。' },
  { id: 'lance_evo', weapon: 'lance', passive: 'might', name: 'Skewer', nameZh: '穿刺者', desc: 'Lance fires three parallel piercing beams instead of one.', descZh: '长枪同时发射三条平行贯穿光束。' },
  { id: 'aura_evo', weapon: 'aura', passive: 'magnet', name: 'Gravity Well', nameZh: '引力井', desc: 'Aura pulls enemies inward while damaging them, then quakes.', descZh: '光环在造成伤害的同时将敌人拉近,随后引发震荡。' },
  { id: 'chain_evo', weapon: 'chain', passive: 'growth', name: 'Storm Front', nameZh: '风暴锋', desc: 'Chain spark jumps infinitely and grants bonus XP per arc.', descZh: '连锁电击无限跳跃,每次跳跃额外获得经验。' },
];

// ---------------------------------------------------------------- enemies

export const ENEMIES = {
  chaser: { id: 'chaser', name: 'Chaser', nameZh: '追猎者', hp: 12, speed: 62, dmg: 6, radius: 9, xp: 1, color: 'hot' },
  swarmer: { id: 'swarmer', name: 'Swarmer', nameZh: '蜂群体', hp: 5, speed: 88, dmg: 3, radius: 6, xp: 1, color: 'warm' },
  charger: { id: 'charger', name: 'Charger', nameZh: '冲撞者', hp: 24, speed: 40, dmg: 12, radius: 12, xp: 2, color: 'violet', chargeSpeed: 220, chargeCooldown: 2.2 },
  splitter: { id: 'splitter', name: 'Splitter', nameZh: '分裂体', hp: 20, speed: 50, dmg: 7, radius: 11, xp: 2, color: 'accent2', splitInto: 2 },
  shielded: { id: 'shielded', name: 'Shielded', nameZh: '护盾者', hp: 40, speed: 45, dmg: 8, radius: 12, xp: 3, color: 'dim', shield: 30 },
  ranged: { id: 'ranged', name: 'Ranged', nameZh: '射手', hp: 14, speed: 35, dmg: 5, radius: 9, xp: 2, color: 'accent', shootRange: 220, shootCooldown: 1.6 },
  elite: { id: 'elite', name: 'Elite', nameZh: '精英', hp: 140, speed: 55, dmg: 14, radius: 16, xp: 8, color: 'hot' },
};

export const BOSS = { id: 'boss', name: 'The Swarm Mother', nameZh: '虫群之母', hp: 3200, speed: 42, dmg: 22, radius: 34, xp: 100 };

// ---------------------------------------------------------------- characters

export const CHARACTERS = [
  {
    id: 'wren', name: 'Wren', nameZh: '鹪鹩', desc: 'Balanced starter. Opens with the Whirling Blade.',
    descZh: '均衡型初始角色,携带旋风刃出场。',
    startWeapon: 'blade', bias: {}, unlock: null,
  },
  {
    id: 'kestrel', name: 'Kestrel', nameZh: '茶隼', desc: 'Fast and fragile. Opens with Auto Bolt, +15% speed, -15% max HP.',
    descZh: '速度快但脆弱,携带追踪弩出场,速度+15%,最大生命-15%。',
    startWeapon: 'bolt', bias: { speedMul: 1.15, hpMul: 0.85 }, unlock: { kind: 'gold', amount: 200 },
  },
  {
    id: 'thorn', name: 'Thorn', nameZh: '荆棘', desc: 'Tanky brawler. Opens with Static Aura, +25% max HP, -10% speed.',
    descZh: '肉盾型近战,携带静电光环出场,最大生命+25%,速度-10%。',
    startWeapon: 'aura', bias: { speedMul: 0.9, hpMul: 1.25 }, unlock: { kind: 'wins', amount: 1 },
  },
  {
    id: 'vane', name: 'Vane', nameZh: '维恩', desc: 'Glass cannon. Opens with Lance, +20% damage, -20% max HP.',
    descZh: '玻璃大炮,携带贯穿长枪出场,伤害+20%,最大生命-20%。',
    startWeapon: 'lance', bias: { hpMul: 0.8 }, unlock: { kind: 'gold', amount: 500 },
  },
  {
    id: 'coil', name: 'Coil', nameZh: '科尔', desc: 'Crowd control specialist. Opens with Chain Lightning, +12% max HP, -8% speed.',
    descZh: '控场专精,携带连锁闪电出场,最大生命+12%,速度-8%。',
    startWeapon: 'chain', bias: { speedMul: 0.92, hpMul: 1.12 }, unlock: { kind: 'wins', amount: 3 },
  },
];

// ---------------------------------------------------------------- spawn director
// Returns archetype weights and density for a given time-in-run (seconds, 0..600).

export function directorAt(tSec) {
  const m = tSec / 60;
  // The run is 10 minutes and ends at the boss. Density previously ramped on an
  // 11-minute scale (m/11), so it never reached 1.0 before the fight — the back half
  // of every run stayed under-pressure. Full density now lands at 9:30, leaving a
  // deliberate 30s crunch before the boss.
  const density = clamp01(m / 9.5);
  const weights = { chaser: 1, swarmer: 0 };
  if (m >= 1.5) weights.swarmer = 0.8;
  if (m >= 3) weights.charger = 0.5;
  if (m >= 4) weights.splitter = 0.4;
  if (m >= 5.5) weights.shielded = 0.35;
  if (m >= 6.5) weights.ranged = 0.35;
  // Elite chance capped out at 2% on a 12-minute ramp that never completed either —
  // elites were nearly nonexistent in a real run. Reaches 8% by 9:00 instead.
  const eliteChance = m >= 2.5 ? clamp01((m - 2.5) / 6.5) * 0.08 : 0;
  return { density, weights, eliteChance };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export const RUN_DURATION = 600; // 10:00
