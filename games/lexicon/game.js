// Lexicon — physics word game.
//
// Letters rain into a jar and pile up for real. Drag a path through TOUCHING
// tiles to spell a word; it vaporizes, the pile collapses into the hole, and if
// you can spell again before the dust settles the chain multiplier stacks.
//
// All simulation lives in ./sim.js as pure functions over a plain state object.
// This file only turns the kit's input into an intent, draws the result, and
// makes noise. window.__selftest() drives the exact same stepSim().

import {
  boot, registerSelftest, Palette, FX, Sound, Store,
  clamp, text, roundRect, allFinite, TAU, randomSeedString,
} from '../../shared/kit.js';
import {
  makeSim, stepSim, addTile, findWord, settle, tileById, totalKE, maxOverlap, outOfBounds,
  scoreFor, chainMult, LETTER_VALUE,
  WORLD_W, WORLD_H, TILE_R, DANGER_Y, MIN_WORD, CHAIN_WINDOW, MAX_TILES,
} from './sim.js';
import { isWord, WORD_COUNT } from './words.js';

const VOWELS = 'aeiou';
const RARE = 'jqxz';

// ---------------------------------------------------------------- view

/** The jar keeps its aspect and is letterboxed into whatever canvas we get. */
function viewOf(g) {
  const padX = 12;
  const padTop = clamp(g.h * 0.1, 22, 54);
  const padBot = clamp(g.h * 0.04, 8, 22);
  const availW = Math.max(60, g.w - padX * 2);
  const availH = Math.max(60, g.h - padTop - padBot);
  const scale = Math.min(availW / WORLD_W, availH / WORLD_H);
  return {
    scale,
    ox: (g.w - WORLD_W * scale) / 2,
    oy: padTop + (availH - WORLD_H * scale) / 2,
    padTop,
  };
}

const toWorldX = (v, sx) => (sx - v.ox) / v.scale;
const toWorldY = (v, sy) => (sy - v.oy) / v.scale;
const toScreenX = (v, wx) => v.ox + wx * v.scale;
const toScreenY = (v, wy) => v.oy + wy * v.scale;

// ---------------------------------------------------------------- game state

function init(g) {
  return {
    phase: 'intro',                 // intro | play | over
    sim: makeSim(g.seed),
    view: viewOf(g),
    pops: [],
    best: Store.get('best', 0),
    bestWord: Store.get('longest', ''),
    swallow: false,
    t: 0,
    overT: 0,
    flash: 0,
    goodFlash: 0,
    thudT: 0,
  };
}

function nextSeed(s) {
  return (s.sim.rng.int(1e9) ^ 0x9e3779b9) >>> 0;
}

function restartRun(s, g) {
  s.sim = makeSim(nextSeed(s));
  s.phase = 'play';
  s.pops.length = 0;
  s.overT = 0;
  s.flash = 0;
  s.goodFlash = 0;
  s.swallow = g.input.pointer.down;
  FX.reset();
}

function pop(s, x, y, str, color, size = 20) {
  s.pops.push({ x, y, str, color, size, life: 1.1, max: 1.1 });
  if (s.pops.length > 24) s.pops.shift();
}

function handleEvents(s, g) {
  const v = s.view;
  for (const e of s.sim.events) {
    if (e.type === 'pick') {
      Sound.blip(360 + e.n * 62);
    } else if (e.type === 'unpick') {
      Sound.tone({ freq: 240, dur: 0.05, type: 'square', gain: 0.05 });
    } else if (e.type === 'clear') {
      const mult = chainMult(e.chain);
      Sound.ok();
      for (let i = 0; i < e.word.length; i++) {
        Sound.tone({
          freq: 330 * Math.pow(2, (i * 2 + e.chain * 5) / 12),
          dur: 0.1, type: 'triangle', gain: 0.08, at: i * 0.045,
        });
      }
      let cx = 0, cy = 0;
      for (const p of e.pts) {
        cx += p.x; cy += p.y;
        FX.burst(toScreenX(v, p.x), toScreenY(v, p.y), {
          count: 14, color: e.chain > 0 ? Palette.warm : Palette.accent,
          speed: 150 * v.scale, life: 0.55, size: 3 * v.scale, drag: 0.86, gravity: 220 * v.scale,
        });
      }
      cx /= e.pts.length; cy /= e.pts.length;
      pop(s, cx, cy - 14, '+' + e.gain, e.chain > 0 ? Palette.warm : Palette.accent, 24 + e.word.length * 2);
      if (e.chain > 0) pop(s, cx, cy - 44, 'CHAIN ×' + mult.toFixed(1), Palette.hot, 20);
      FX.shake(3 + e.word.length * 1.2 + e.chain * 4);
      s.goodFlash = 1;
    } else if (e.type === 'reject') {
      Sound.bad();
      FX.shake(2);
      s.flash = 0.7;
    } else if (e.type === 'over') {
      Sound.tone({ freq: 180, dur: 0.9, type: 'sawtooth', gain: 0.16, slide: -120 });
      Sound.noise({ dur: 0.7, gain: 0.16, freq: 400 });
      FX.shake(16);
      s.phase = 'over';
      s.overT = 0;
      Store.best('best', s.sim.score);
      s.best = Math.max(s.best, s.sim.score);
      if (s.sim.longest.length > s.bestWord.length) {
        s.bestWord = s.sim.longest;
        Store.set('longest', s.bestWord);
      }
    }
  }
  // landing thuds, throttled so a collapse doesn't machine-gun
  if (s.sim.impact > 0.18 && s.thudT <= 0) {
    Sound.noise({ dur: 0.09, gain: 0.05 + s.sim.impact * 0.09, freq: 320 + s.sim.impact * 500 });
    s.thudT = 0.07;
  }
}

function update(s, dt, g) {
  s.view = viewOf(g);
  s.t += dt;
  if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 2.2);
  if (s.goodFlash > 0) s.goodFlash = Math.max(0, s.goodFlash - dt * 3.4);
  if (s.thudT > 0) s.thudT -= dt;
  for (let i = s.pops.length - 1; i >= 0; i--) {
    const p = s.pops[i];
    p.life -= dt;
    p.y -= 26 * dt;
    if (p.life <= 0) s.pops.splice(i, 1);
  }

  const I = g.input;

  if (s.phase === 'intro') {
    // The opening rain plays behind the title card, so the pile is already alive.
    stepSim(s.sim, { pointer: { x: -9999, y: -9999, down: false }, submit: false }, dt);
    handleEvents(s, g);
    if (I.pointerPressed || I.justPressed('space') || I.justPressed('enter')) {
      s.phase = 'play';
      s.swallow = I.pointer.down;
      s.sim.t = 0;          // difficulty ramp starts when the player does
      s.sim.idleT = 0;
      Sound.init(); Sound.resume();
    }
    return;
  }

  if (s.phase === 'over') {
    s.overT += dt;
    stepSim(s.sim, { pointer: { x: -9999, y: -9999, down: false }, submit: false }, dt);
    if (I.justPressed('r') || (s.overT > 0.45 && (I.pointerPressed || I.justPressed('space') || I.justPressed('enter')))) {
      restartRun(s, g);
    }
    return;
  }

  if (I.justPressed('r')) { restartRun(s, g); return; }
  if (s.swallow && !I.pointer.down) s.swallow = false;

  const intent = {
    pointer: {
      x: toWorldX(s.view, I.pointer.x),
      y: toWorldY(s.view, I.pointer.y),
      down: I.pointer.down && !s.swallow,
    },
    submit: false,
  };
  stepSim(s.sim, intent, dt);
  handleEvents(s, g);
}

// ---------------------------------------------------------------- render

function tileInk(letter) {
  if (VOWELS.includes(letter)) return Palette.accent2;
  if (RARE.includes(letter)) return Palette.violet;
  return Palette.dim;
}

function drawTile(ctx, t, state, tt) {
  // Drawn a touch smaller than the collision radius: a jammed pile overlaps by a
  // couple of units and this turns that into a clean seam instead of a smear.
  const R = t.r * 0.93;
  const sq = t.squash;
  const sel = state.selSet.has(t.id);
  const hint = state.hintId === t.id;
  const ink = tileInk(t.letter);

  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.scale(1 + sq * 0.24, 1 - sq * 0.24);

  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fillStyle = sel ? 'rgba(94,242,192,0.20)' : '#151b2a';
  ctx.fill();

  // top-lit rim
  ctx.beginPath();
  ctx.arc(0, 0, R - 2.2, Math.PI * 1.12, Math.PI * 1.88);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.lineWidth = sel ? 2.6 : 1.6;
  ctx.strokeStyle = sel ? Palette.accent : ink;
  ctx.globalAlpha = sel ? 1 : 0.75;
  if (sel) { ctx.shadowColor = Palette.accent; ctx.shadowBlur = 12; }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  if (hint) {
    const p = 0.5 + 0.5 * Math.sin(tt * 4.2);
    ctx.beginPath();
    ctx.arc(0, 0, R + 2 + p * 3.5, 0, TAU);
    ctx.strokeStyle = Palette.warm;
    ctx.globalAlpha = 0.16 + p * 0.42;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  text(ctx, t.letter.toUpperCase(), 0, 1, {
    size: R * 1.16, weight: 700, align: 'center', baseline: 'middle',
    color: sel ? Palette.accent : Palette.ink,
  });
  text(ctx, String(LETTER_VALUE[t.letter] || 1), R * 0.56, R * 0.5, {
    size: R * 0.4, weight: 600, align: 'center', baseline: 'middle',
    color: sel ? Palette.accent : ink, alpha: 0.8,
  });

  ctx.restore();
}

function drawJar(ctx, sim, tt) {
  ctx.fillStyle = Palette.bg2;
  roundRect(ctx, 0, 0, WORLD_W, WORLD_H, 10);
  ctx.fill();

  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let x = 60; x < WORLD_W; x += 60) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); }
  for (let y = 60; y < WORLD_H; y += 60) { ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // the top line
  const danger = clamp(sim.overflowT / 0.9, 0, 1);
  const pulse = 0.5 + 0.5 * Math.sin(tt * (danger > 0 ? 12 : 2.2));
  ctx.setLineDash([9, 8]);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = danger > 0 ? Palette.hot : Palette.grid;
  ctx.globalAlpha = danger > 0 ? 0.45 + pulse * 0.55 : 0.5 + pulse * 0.2;
  ctx.beginPath();
  ctx.moveTo(0, DANGER_Y);
  ctx.lineTo(WORLD_W, DANGER_Y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  text(ctx, 'TOP LINE', WORLD_W - 8, DANGER_Y - 12, {
    size: 9, color: danger > 0 ? Palette.hot : Palette.dim, align: 'right', alpha: 0.55 + danger * 0.45,
  });

  ctx.strokeStyle = Palette.grid;
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0.75, 0.75, WORLD_W - 1.5, WORLD_H - 1.5, 10);
  ctx.stroke();
}

function drawChain(ctx, sim, tt) {
  if (sim.sel.length === 0) return;
  const pts = [];
  for (const id of sim.sel) {
    const t = tileById(sim, id);
    if (t) pts.push(t);
  }
  if (!pts.length) return;
  const col = sim.valid ? Palette.accent : (sim.word.length >= MIN_WORD ? Palette.hot : Palette.accent2);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = col;
  ctx.shadowColor = col;
  ctx.shadowBlur = 16;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.stroke();
  ctx.restore();
}

function render(s, ctx, g) {
  const v = s.view;
  const sim = s.sim;
  const tt = s.t;

  // backdrop
  const grad = ctx.createLinearGradient(0, 0, 0, g.h);
  grad.addColorStop(0, Palette.bg);
  grad.addColorStop(1, '#05060a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, g.w, g.h);

  s.selSet = new Set(sim.sel);
  s.hintId = sim.hintIds.length ? sim.hintIds[0] : -1;

  ctx.save();
  ctx.translate(v.ox, v.oy);
  ctx.scale(v.scale, v.scale);

  drawJar(ctx, sim, tt);

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, 0, 0, WORLD_W, WORLD_H, 10);
  ctx.clip();
  for (const t of sim.tiles) drawTile(ctx, t, s, tt);
  drawChain(ctx, sim, tt);
  ctx.restore();

  // forming word, above the top line
  if (sim.word.length) {
    const col = sim.valid ? Palette.accent : Palette.ink;
    text(ctx, sim.word.toUpperCase().split('').join(' '), WORLD_W / 2, 44, {
      size: 30, weight: 700, align: 'center', baseline: 'middle', color: col,
      alpha: sim.valid ? 1 : 0.62,
    });
    if (sim.valid) {
      text(ctx, '+' + sim.preview, WORLD_W / 2, 74, {
        size: 15, weight: 700, align: 'center', baseline: 'middle', color: Palette.warm,
      });
    } else if (sim.word.length >= MIN_WORD) {
      text(ctx, 'NOT A WORD', WORLD_W / 2, 74, {
        size: 11, align: 'center', baseline: 'middle', color: Palette.dim, alpha: 0.7,
      });
    }
  } else if (sim.chainT > 0) {
    const m = chainMult(sim.chain);
    const a = clamp(sim.chainT / CHAIN_WINDOW, 0, 1);
    text(ctx, 'CHAIN ×' + m.toFixed(1), WORLD_W / 2, 46, {
      size: 24, weight: 700, align: 'center', baseline: 'middle', color: Palette.hot,
      alpha: 0.35 + a * 0.65,
    });
    ctx.fillStyle = Palette.hot;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(WORLD_W / 2 - 60 * a, 66, 120 * a, 3);
    ctx.globalAlpha = 1;
  } else if (sim.hintIds.length && !sim.over) {
    text(ctx, 'THERE IS A WORD IN THERE', WORLD_W / 2, 50, {
      size: 11, align: 'center', baseline: 'middle', color: Palette.warm,
      alpha: 0.25 + 0.25 * Math.sin(tt * 4.2),
    });
  }

  for (const p of s.pops) {
    const a = clamp(p.life / p.max, 0, 1);
    text(ctx, p.str, p.x, p.y, {
      size: p.size, weight: 700, align: 'center', baseline: 'middle',
      color: p.color, alpha: a * a,
    });
  }

  ctx.restore();

  FX.draw(ctx);

  // ---- HUD (screen space)
  const hy = Math.max(4, v.padTop * 0.28);
  const hs = clamp(g.w / 60, 10, 14);
  text(ctx, 'SCORE ' + sim.score, 14, hy, { size: hs, weight: 700, color: Palette.ink });
  text(ctx, 'BEST ' + Math.max(s.best, sim.score), g.w - 14, hy, { size: hs, color: Palette.dim, align: 'right' });
  if (g.h > 300) {
    text(ctx, 'WORDS ' + sim.wordsMade + (sim.longest ? '  ·  ' + sim.longest.toUpperCase() : ''),
      14, hy + hs + 4, { size: hs * 0.8, color: Palette.dim });
    text(ctx, 'TILES ' + sim.tiles.length + '/' + MAX_TILES, g.w - 14, hy + hs + 4,
      { size: hs * 0.8, color: Palette.dim, align: 'right', alpha: 0.8 });
  }

  // ---- flashes
  if (s.goodFlash > 0) {
    ctx.globalAlpha = s.goodFlash * 0.1;
    ctx.fillStyle = Palette.accent;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalAlpha = 1;
  }
  if (s.flash > 0) {
    ctx.globalAlpha = s.flash * 0.14;
    ctx.fillStyle = Palette.hot;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalAlpha = 1;
  }

  // ---- overlays
  if (s.phase === 'intro') {
    ctx.fillStyle = 'rgba(7,8,13,0.88)';
    ctx.fillRect(0, 0, g.w, g.h);
    const cx = g.w / 2, cy = g.h / 2;
    const k = clamp(g.w / 620, 0.62, 1.15);
    text(ctx, 'LEXICON', cx, cy - 78 * k, { size: 40 * k, weight: 700, align: 'center', color: Palette.accent });
    text(ctx, 'Letters rain. Words vaporize. The pile collapses.', cx, cy - 36 * k,
      { size: 14 * k, align: 'center', color: Palette.ink });
    text(ctx, 'DRAG THROUGH TOUCHING LETTERS', cx, cy + 2 * k,
      { size: 17 * k, weight: 700, align: 'center', color: Palette.warm });
    text(ctx, '3 letters minimum · release to submit · backtrack to undo', cx, cy + 28 * k,
      { size: 12 * k, align: 'center', color: Palette.dim });
    text(ctx, 'Spell again before the rubble settles for a CHAIN multiplier.', cx, cy + 48 * k,
      { size: 12 * k, align: 'center', color: Palette.dim });
    text(ctx, 'Let the pile rest above the top line and it is over.', cx, cy + 68 * k,
      { size: 12 * k, align: 'center', color: Palette.dim });
    const p = 0.5 + 0.5 * Math.sin(tt * 3);
    text(ctx, 'CLICK TO START', cx, cy + 104 * k, {
      size: 14 * k, weight: 700, align: 'center', color: Palette.accent2, alpha: 0.35 + p * 0.65,
    });
  }

  if (s.phase === 'over') {
    ctx.fillStyle = 'rgba(7,8,13,' + clamp(s.overT * 1.6, 0, 0.9) + ')';
    ctx.fillRect(0, 0, g.w, g.h);
    if (s.overT > 0.15) {
      const cx = g.w / 2, cy = g.h / 2;
      const k = clamp(g.w / 620, 0.62, 1.15);
      text(ctx, 'OVERFLOW', cx, cy - 62 * k, { size: 34 * k, weight: 700, align: 'center', color: Palette.hot });
      text(ctx, sim.score + ' POINTS', cx, cy - 22 * k, { size: 20 * k, weight: 700, align: 'center', color: Palette.ink });
      text(ctx, sim.wordsMade + ' words · longest ' + (sim.longest ? sim.longest.toUpperCase() : '—')
        + ' · best chain ×' + chainMult(sim.bestChain).toFixed(1),
        cx, cy + 6 * k, { size: 12 * k, align: 'center', color: Palette.dim });
      text(ctx, 'PERSONAL BEST ' + Math.max(s.best, sim.score)
        + (s.bestWord ? '  ·  ' + s.bestWord.toUpperCase() : ''),
        cx, cy + 30 * k, { size: 12 * k, align: 'center', color: Palette.accent, alpha: 0.85 });
      const p = 0.5 + 0.5 * Math.sin(tt * 3);
      text(ctx, 'CLICK OR PRESS R', cx, cy + 68 * k, {
        size: 13 * k, weight: 700, align: 'center', color: Palette.accent2, alpha: 0.35 + p * 0.65,
      });
    }
  }
}

// ---------------------------------------------------------------- boot

const game = boot({
  id: 'lexicon',
  title: 'Lexicon',
  seed: randomSeedString(),
  init, update, render,
});

// ---------------------------------------------------------------- self-test

const IDLE = { pointer: { x: -9999, y: -9999, down: false }, submit: false };

/** Lay a word out along the floor, left to right, tiles just touching. */
function layWord(sim, word, x0, y) {
  const out = [];
  for (let i = 0; i < word.length; i++) out.push(addTile(sim, word[i], x0 + i * 46, y));
  return out;
}

function drag(sim, tiles, dt) {
  const seen = [];
  for (const t of tiles) {
    stepSim(sim, { pointer: { x: t.x, y: t.y, down: true }, submit: false }, dt);
    stepSim(sim, { pointer: { x: t.x, y: t.y, down: true }, submit: false }, dt);
    seen.push(sim.sel.length);
  }
  const last = tiles[tiles.length - 1];
  stepSim(sim, { pointer: { x: last.x, y: last.y, down: false }, submit: false }, dt);
  return seen;
}

registerSelftest('lexicon', (check, log) => {
  const dt = 1 / 60;
  const FLOOR = WORLD_H - TILE_R;

  // 1. world initializes + dictionary is live
  const s0 = makeSim('LEX-INIT');
  check('world initializes with falling tiles', s0.tiles.length === 16 && s0.score === 0 && !s0.over,
    `tiles=${s0.tiles.length}`);
  check('dictionary loads', isWord('house') === true && isWord('zzzzq') === false && WORD_COUNT > 50000,
    `WORD_COUNT=${WORD_COUNT}`);
  check('letter distribution is playable', (() => {
    let ok = 0;
    for (let i = 0; i < 12; i++) {
      const p = makeSim('PLAY' + i, { prefill: 30, autoSpawn: false });
      settle(p, 700);
      if (findWord(p)) ok++;
    }
    log('piles containing a findable word: ' + ok + '/12');
    return ok >= 11;
  })(), 'random settled piles contain a word');

  // 2. injected drag grows the selection
  const s1 = makeSim('LEX-SEL', { prefill: 0, autoSpawn: false });
  const cat = layWord(s1, 'cat', 60, FLOOR);
  settle(s1, 200);
  const grew = drag(s1, cat, dt);
  check('drag grows the selection 1,2,3', grew.length === 3 && grew[0] === 1 && grew[1] === 2 && grew[2] === 3,
    `lengths=${grew.join(',')}`);

  // 3. a valid word scores and removes exactly those tiles
  check('valid word scores', s1.score === scoreFor('cat', 0) && s1.score > 0, `score=${s1.score}`);
  check('valid word removes its tiles', s1.tiles.length === 0, `tiles=${s1.tiles.length}`);
  check('longest word tracked', s1.longest === 'cat', s1.longest);

  // 9. an invalid word changes nothing
  const s2 = makeSim('LEX-BAD', { prefill: 0, autoSpawn: false });
  const junk = layWord(s2, 'qxj', 60, FLOOR);
  settle(s2, 200);
  drag(s2, junk, dt);
  check('invalid word is rejected', s2.score === 0 && s2.tiles.length === 3 && s2.wordsMade === 0,
    `score=${s2.score} tiles=${s2.tiles.length}`);

  // non-touching tiles cannot be chained
  const s3 = makeSim('LEX-GAP', { prefill: 0, autoSpawn: false });
  const gapped = [addTile(s3, 'c', 60, FLOOR), addTile(s3, 'a', 200, FLOOR), addTile(s3, 't', 340, FLOOR)];
  settle(s3, 200);
  drag(s3, gapped, dt);
  check('separated tiles cannot be chained', s3.tiles.length === 3 && s3.score === 0,
    `tiles=${s3.tiles.length}`);

  // 4. WIN-equivalent: a clear collapses the pile and the next clear chains
  const s4 = makeSim('LEX-CHAIN', { prefill: 0, autoSpawn: false });
  layWord(s4, 'cat', 60, FLOOR);
  layWord(s4, 'dog', 60, FLOOR - 46);
  settle(s4, 400);
  const topY = Math.min(...s4.tiles.filter((t) => 'dog'.includes(t.letter)).map((t) => t.y));
  drag(s4, s4.tiles.filter((t) => 'cat'.includes(t.letter)), dt);
  const afterFirst = s4.score;
  check('first clear removes 3 of 6 tiles', s4.tiles.length === 3 && afterFirst === scoreFor('cat', 0),
    `tiles=${s4.tiles.length} score=${afterFirst}`);
  settle(s4, 90);
  const fellY = Math.min(...s4.tiles.map((t) => t.y));
  check('the collapse actually drops the tiles above', fellY > topY + 20,
    `top ${topY.toFixed(1)} -> ${fellY.toFixed(1)}`);
  drag(s4, s4.tiles.slice(), dt);
  check('chain multiplier triggers on the follow-up clear',
    s4.chain === 1 && s4.lastMult > 1 && s4.lastGain === scoreFor('dog', 1) && s4.lastGain > scoreFor('dog', 0),
    `chain=${s4.chain} mult=${s4.lastMult} gain=${s4.lastGain} vs unchained ${scoreFor('dog', 0)}`);
  check('board is clear and scored', s4.tiles.length === 0 && s4.score === afterFirst + s4.lastGain,
    `score=${s4.score}`);

  // 5. LOSE is reachable — flood the jar and let it overflow the top line
  const s5 = makeSim('LEX-LOSE', { prefill: 20, spawnScale: 0.12 });
  let f = 0;
  for (; f < 2400 && !s5.over; f++) stepSim(s5, IDLE, dt);
  check('lose condition reachable (pile overflows the top line)', s5.over === true,
    `over=${s5.over} frames=${f} tiles=${s5.tiles.length}`);

  // 6. no NaN/Infinity after a long chaotic run
  const s6 = makeSim('LEX-NAN', { prefill: 24, spawnScale: 0.35 });
  for (let i = 0; i < 700; i++) {
    stepSim(s6, {
      pointer: { x: (i * 37) % WORLD_W, y: 260 + ((i * 71) % 300), down: i % 5 < 3 },
      submit: false,
    }, dt);
  }
  const fin = allFinite(s6);
  check('no NaN/Infinity after 700 frames of falling tiles', fin.ok, fin.bad.slice(0, 4).join(','));
  check('tile count is capped', s6.tiles.length <= MAX_TILES, `tiles=${s6.tiles.length}`);

  // 8. PHYSICS STABILITY — settled means settled
  let worstKE = 0, worstOv = 0, escaped = 0, unsettled = 0;
  for (let i = 0; i < 6; i++) {
    const p = makeSim('LEX-PHYS' + i, { prefill: 40, autoSpawn: false });
    if (settle(p, 900) >= 900) unsettled++;
    worstKE = Math.max(worstKE, totalKE(p));
    worstOv = Math.max(worstOv, maxOverlap(p));
    escaped += outOfBounds(p).length;
  }
  check('settled piles have ~zero kinetic energy (no eternal jitter)', worstKE < 1 && unsettled === 0,
    `maxKE=${worstKE.toFixed(4)} unsettled=${unsettled}`);
  check('no tile escapes the jar', escaped === 0, `escaped=${escaped}`);
  check('no tile overlaps another by more than a small tolerance', worstOv <= 3.5,
    `maxOverlap=${worstOv.toFixed(2)} of ${TILE_R * 2} diameter`);

  // determinism: same seed + same intents => identical run
  const dA = makeSim('LEX-DET', { prefill: 20 });
  const dB = makeSim('LEX-DET', { prefill: 20 });
  for (let i = 0; i < 240; i++) {
    const it = { pointer: { x: 90 + (i % 40) * 6, y: 430, down: i % 7 < 3 }, submit: false };
    stepSim(dA, it, dt); stepSim(dB, it, dt);
  }
  const fingerprint = (s) => s.tiles.map((t) => `${t.id}${t.letter}${t.x.toFixed(5)}${t.y.toFixed(5)}`).join('|') + s.score;
  check('same seed + same intents replay identically', fingerprint(dA) === fingerprint(dB));

  // hint search finds a real, connected, valid word
  const h = makeSim('LEX-HINT', { prefill: 40, autoSpawn: false });
  settle(h, 900);
  const hit = findWord(h);
  check('hint search returns a valid connected word', !!hit && isWord(hit.word) && (() => {
    for (let i = 1; i < hit.ids.length; i++) {
      const a = tileById(h, hit.ids[i - 1]), b = tileById(h, hit.ids[i]);
      if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r + 5.001) return false;
    }
    return true;
  })(), hit ? hit.word : 'no word found');

  // --- LIVE game, driven through the kit's own input path
  game.restart();
  game.state.phase = 'play';
  game.state.swallow = false;
  const live = game.state.sim;
  live.tiles.length = 0;
  live.autoSpawn = false;
  const word = layWord(live, 'pig', 70, FLOOR);
  game.step(180);
  const v = game.state.view;
  const before = live.score;
  const seen = [];
  for (const t of word) {
    game.input.pointDown(toScreenX(v, t.x), toScreenY(v, t.y));
    game.step(2);
    seen.push(live.sel.length);
  }
  game.input.pointUp(toScreenX(v, word[2].x), toScreenY(v, word[2].y));
  game.step(2);
  check('live game selects through kit pointer input', seen.join(',') === '1,2,3', `sel=${seen.join(',')}`);
  check('live game scores and clears the word', live.score > before && live.tiles.length === 0,
    `score ${before} -> ${live.score}, tiles=${live.tiles.length}`);
  check('live state stays finite', allFinite(game.state.sim).ok);

  game.restart();
  log(`words=${WORD_COUNT} jar=${WORLD_W}x${WORLD_H} r=${TILE_R} cap=${MAX_TILES}`);
});

// dev console handles
globalThis.__lexicon = { makeSim, stepSim, findWord, settle, addTile, scoreFor, game };

export default game;
