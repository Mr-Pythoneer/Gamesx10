// Gamesx10 — shared kit.
// The contract every game implements. Zero dependencies, ES module, no build step.
//
// Determinism rule: games MUST NOT call Math.random() or Date.now() inside simulation.
// All randomness comes from a seeded RNG, all timing from the fixed-step accumulator.
// Same seed + same inputs => identical run. That is what makes window.__selftest() meaningful.

export const Palette = {
  bg: '#07080d',
  bg2: '#0d1018',
  panel: '#111624',
  grid: '#171d2c',
  ink: '#e9edf7',
  dim: '#78849c',
  accent: '#5ef2c0',
  accent2: '#3ba7ff',
  hot: '#ff4d6d',
  warm: '#ffc857',
  violet: '#a06bff',
};

// ---------------------------------------------------------------- RNG (mulberry32)

export class RNG {
  constructor(seed = 1) {
    this.seed(seed);
  }
  seed(s) {
    this.s = (typeof s === 'string' ? RNG.hash(s) : s >>> 0) || 1;
    return this;
  }
  static hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(n) { return Math.floor(this.next() * n); }
  intRange(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

// Short shareable seed strings, e.g. "K7QP2M"
const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomSeedString(len = 6) {
  let out = '';
  const buf = new Uint8Array(len);
  (globalThis.crypto || { getRandomValues: (b) => b.forEach((_, i) => (b[i] = (Math.random() * 256) | 0)) })
    .getRandomValues(buf);
  for (let i = 0; i < len; i++) out += SEED_ALPHABET[buf[i] % SEED_ALPHABET.length];
  return out;
}

// ---------------------------------------------------------------- Input

const KEY_ALIASES = {
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  space: 'Space', esc: 'Escape', escape: 'Escape', enter: 'Enter',
  shift: 'ShiftLeft', ctrl: 'ControlLeft', alt: 'AltLeft', tab: 'Tab',
  backspace: 'Backspace', del: 'Delete',
};

function normKey(k) {
  if (!k) return '';
  if (KEY_ALIASES[k]) return KEY_ALIASES[k];
  const low = String(k).toLowerCase();
  if (KEY_ALIASES[low]) return KEY_ALIASES[low];
  if (/^[a-z]$/.test(low)) return 'Key' + low.toUpperCase();
  if (/^[0-9]$/.test(low)) return 'Digit' + low;
  return k; // already a KeyboardEvent.code
}

class InputSystem {
  constructor() {
    this.down = new Set();
    this.prev = new Set();
    this._taps = new Set();
    this.pointer = { x: 0, y: 0, down: false, prevDown: false, dx: 0, dy: 0, moved: false };
    this._pendingUp = false;
    this._attached = false;
    this.anyInputSeen = false;
  }

  norm(k) { return normKey(k); }
  isDown(k) { return this.down.has(normKey(k)); }
  justPressed(k) { const n = normKey(k); return this.down.has(n) && !this.prev.has(n); }
  justReleased(k) { const n = normKey(k); return !this.down.has(n) && this.prev.has(n); }
  get pointerPressed() { return this.pointer.down && !this.pointer.prevDown; }
  get pointerReleased() { return !this.pointer.down && this.pointer.prevDown; }

  /** Any of the given keys held. */
  anyDown(...keys) { return keys.some((k) => this.isDown(k)); }

  // --- virtual injection (used by self-tests; identical path to real events)
  press(k) { this.down.add(normKey(k)); this.anyInputSeen = true; }
  release(k) { this.down.delete(normKey(k)); }
  /** Held for exactly one simulation frame, so justPressed() fires once. */
  tap(k) { const n = normKey(k); this.down.add(n); this._taps.add(n); this.anyInputSeen = true; }
  pointTo(x, y) {
    this.pointer.dx = x - this.pointer.x;
    this.pointer.dy = y - this.pointer.y;
    this.pointer.x = x; this.pointer.y = y; this.pointer.moved = true;
  }
  pointDown(x, y) {
    if (x !== undefined) this.pointTo(x, y);
    this.pointer.down = true; this.anyInputSeen = true;
  }
  pointUp(x, y) {
    if (x !== undefined) this.pointTo(x, y);
    this.pointer.down = false;
  }
  /** Press + release across one frame boundary. */
  click(x, y) { this.pointDown(x, y); this._pendingUp = true; }

  clear() {
    this.down.clear(); this.prev.clear(); this._taps.clear();
    this.pointer.down = false; this.pointer.prevDown = false;
  }

  /** Called by the kit at the end of every fixed simulation step. */
  endFrame() {
    this.prev = new Set(this.down);
    this.pointer.prevDown = this.pointer.down;
    this.pointer.dx = 0; this.pointer.dy = 0; this.pointer.moved = false;
    if (this._taps.size) { for (const k of this._taps) this.down.delete(k); this._taps.clear(); }
    if (this._pendingUp) { this.pointer.down = false; this._pendingUp = false; }
  }

  attach(canvas) {
    if (this._attached) return;
    this._attached = true;

    const toLocal = (e) => {
      const r = canvas.getBoundingClientRect();
      const src = e.touches && e.touches[0] ? e.touches[0] : e;
      return {
        x: ((src.clientX - r.left) / r.width) * canvas._logicalW,
        y: ((src.clientY - r.top) / r.height) * canvas._logicalH,
      };
    };

    addEventListener('keydown', (e) => {
      // Never swallow browser chrome shortcuts or reload.
      if (e.metaKey || e.ctrlKey) return;
      this.down.add(e.code);
      this.anyInputSeen = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());

    canvas.addEventListener('pointermove', (e) => { const p = toLocal(e); this.pointTo(p.x, p.y); });
    canvas.addEventListener('pointerdown', (e) => {
      const p = toLocal(e); this.pointDown(p.x, p.y);
      canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    const up = (e) => { const p = toLocal(e); this.pointUp(p.x, p.y); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.style.touchAction = 'none';
  }
}

export const Input = new InputSystem();

// ---------------------------------------------------------------- Sound (WebAudio, no assets)

export const Sound = {
  ctx: null,
  master: null,
  muted: false,

  /** Lazily created on first user gesture — browsers block audio before that. */
  init() {
    if (this.ctx) return this.ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch { this.ctx = null; }
    return this.ctx;
  },
  ready() { return !!this.ctx && this.ctx.state === 'running'; },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.5; },
  get now() { return this.ctx ? this.ctx.currentTime : 0; },

  tone({ freq = 440, dur = 0.12, type = 'square', gain = 0.12, pan = 0, slide = 0, at = 0, attack = 0.005 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freq), t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = g;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p); node = p;
    }
    osc.connect(g); node.connect(this.master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  },

  noise({ dur = 0.15, gain = 0.1, type = 'lowpass', freq = 1200, at = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + at;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, Math.max(1, n), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  },

  // Convenience voices so all ten games share an audio identity.
  blip(f = 660) { this.tone({ freq: f, dur: 0.07, type: 'square', gain: 0.09 }); },
  ok() { this.tone({ freq: 520, dur: 0.09, type: 'triangle', gain: 0.12 }); this.tone({ freq: 780, dur: 0.12, type: 'triangle', gain: 0.09, at: 0.07 }); },
  bad() { this.tone({ freq: 200, dur: 0.22, type: 'sawtooth', gain: 0.12, slide: -120 }); },
  thud() { this.noise({ dur: 0.12, gain: 0.14, freq: 500 }); },
};

// ---------------------------------------------------------------- Store (namespaced localStorage)

export const Store = {
  _ns: 'gamesx10',
  ns(id) { this._ns = 'gx10:' + id; return this; },
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(this._ns + ':' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(this._ns + ':' + key, JSON.stringify(value)); } catch { /* private mode */ }
    return value;
  },
  best(key, value, higherIsBetter = true) {
    const cur = this.get(key, null);
    if (cur === null || (higherIsBetter ? value > cur : value < cur)) { this.set(key, value); return true; }
    return false;
  },
};

// ---------------------------------------------------------------- FX (shared juice)

export const FX = {
  _shake: 0,
  _rng: new RNG(1337),
  parts: [],

  reset() { this._shake = 0; this.parts.length = 0; this._rng.seed(1337); },
  shake(amount) { this._shake = Math.min(24, this._shake + amount); },

  burst(x, y, { count = 12, color = Palette.accent, speed = 120, life = 0.5, spread = Math.PI * 2, angle = 0, size = 2.5, drag = 0.9, gravity = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + this._rng.range(-spread / 2, spread / 2);
      const s = speed * this._rng.range(0.35, 1);
      this.parts.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: life * this._rng.range(0.6, 1.2), max: life, color, size, drag, gravity,
      });
    }
    if (this.parts.length > 900) this.parts.splice(0, this.parts.length - 900);
  },

  update(dt) {
    this._shake *= Math.pow(0.001, dt);
    if (this._shake < 0.05) this._shake = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) { this.parts.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      p.vx *= Math.pow(p.drag, dt * 60 / 60);
      p.vy *= Math.pow(p.drag, dt * 60 / 60);
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  },

  /** Wrap rendering in this to apply screen shake. */
  applyShake(ctx) {
    if (!this._shake) return;
    ctx.translate(this._rng.range(-this._shake, this._shake), this._rng.range(-this._shake, this._shake));
  },

  draw(ctx) {
    for (const p of this.parts) {
      const a = Math.max(0, Math.min(1, p.life / p.max));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.size * (0.4 + a * 0.6);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  },
};

// ---------------------------------------------------------------- helpers

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential approach. */
export const approach = (cur, target, rate, dt) => target + (cur - target) * Math.pow(1 - rate, dt * 60);

/** Deep scan for NaN / Infinity — used by every game's self-test. */
export function allFinite(value, maxDepth = 6, _seen = new Set()) {
  const bad = [];
  (function walk(v, path, depth) {
    if (depth > maxDepth || v === null || v === undefined) return;
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(path); return; }
    if (typeof v !== 'object') return;
    if (_seen.has(v)) return;
    _seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 400); i++) walk(v[i], path + '[' + i + ']', depth + 1);
    } else {
      for (const k of Object.keys(v)) walk(v[k], path + '.' + k, depth + 1);
    }
  })(value, '', 0);
  return { ok: bad.length === 0, bad };
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function text(ctx, str, x, y, { size = 14, color = Palette.ink, align = 'left', baseline = 'top', weight = 500, alpha = 1, font = 'ui-monospace, SFMono-Regular, Menlo, monospace' } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(str, x, y);
  ctx.restore();
}

// ---------------------------------------------------------------- boot

/**
 * boot({ id, title, seed, init, update, render })
 *
 *   init(game)            -> state          (called on start and on every restart)
 *   update(state, dt, game)                 (fixed dt, never variable)
 *   render(state, ctx, game)
 *
 * Returns the game handle: { canvas, ctx, w, h, rng, input, store, state, frame, t,
 *                            restart(seed), step(n), start(), stop(), paused }
 */
export function boot(cfg) {
  const {
    id, title = id, seed = 1,
    init, update, render,
    fixed = 1 / 60,
    maxSubSteps = 5,
    canvas: canvasOpt,
    autoStart = true,
    clear = true,
  } = cfg;

  Store.ns(id);

  const canvas = canvasOpt || document.getElementById('game') || (() => {
    const c = document.createElement('canvas');
    c.id = 'game';
    document.body.appendChild(c);
    return c;
  })();
  const ctx = canvas.getContext('2d');

  const game = {
    id, title, canvas, ctx,
    w: 960, h: 600,
    rng: new RNG(seed),
    seed,
    input: Input,
    store: Store,
    sound: Sound,
    fx: FX,
    state: null,
    frame: 0,
    t: 0,
    paused: false,
    running: false,
    dt: fixed,
  };

  function fit() {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const cw = Math.max(1, Math.round(rect.width)) || 960;
    const ch = Math.max(1, Math.round(rect.height)) || 600;
    game.w = cw; game.h = ch;
    canvas._logicalW = cw; canvas._logicalH = ch;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }
  fit();
  addEventListener('resize', fit);
  if (globalThis.ResizeObserver) new ResizeObserver(fit).observe(canvas);

  Input.attach(canvas);

  // Audio may only start after a real gesture.
  const wake = () => { Sound.init(); Sound.resume(); };
  addEventListener('pointerdown', wake, { once: false });
  addEventListener('keydown', wake, { once: false });

  game.restart = (newSeed) => {
    if (newSeed !== undefined) { game.seed = newSeed; }
    game.rng = new RNG(game.seed);
    FX.reset();
    game.frame = 0;
    game.t = 0;
    Input.clear();
    game.state = init(game);
    return game.state;
  };

  /** Advance the simulation deterministically. Used by the loop AND by self-tests. */
  game.step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      update(game.state, fixed, game);
      FX.update(fixed);
      Input.endFrame();
      game.frame++;
      game.t += fixed;
    }
    return game.state;
  };

  game.draw = () => {
    if (clear) {
      ctx.save();
      ctx.fillStyle = Palette.bg;
      ctx.fillRect(0, 0, game.w, game.h);
      ctx.restore();
    }
    ctx.save();
    FX.applyShake(ctx);
    render(game.state, ctx, game);
    ctx.restore();
  };

  let acc = 0;
  let last = 0;
  let raf = 0;
  let watchdog = 0;
  let lastRafAt = 0;

  /** Advance and draw. Safe to call from either clock — it works off elapsed time. */
  function tick(now) {
    if (!last) last = now;
    let delta = (now - last) / 1000;
    last = now;
    // Clamp so a tab restored after minutes away doesn't fast-forward through the sim.
    if (delta > 0.25) delta = 0.25;
    if (!game.paused) {
      acc += delta;
      let steps = 0;
      while (acc >= fixed && steps < maxSubSteps) { game.step(1); acc -= fixed; steps++; }
      if (steps === maxSubSteps) acc = 0;
    }
    game.draw();
  }

  function rafFrame(now) {
    raf = requestAnimationFrame(rafFrame);
    lastRafAt = now;
    tick(now);
  }

  game.start = () => {
    if (game.running) return game;
    game.running = true;
    last = 0; acc = 0;
    lastRafAt = performance.now();
    raf = requestAnimationFrame(rafFrame);

    // requestAnimationFrame is not always delivered: Chrome pauses it in unfocused
    // windows, and embedded webviews can report the document as hidden while still
    // painting. Timer throttling is visibility-based rather than focus-based, so a
    // watchdog interval keeps the game alive wherever rAF stalls. When rAF is healthy
    // this costs one comparison per tick and never double-steps, because tick()
    // integrates elapsed time rather than assuming a fixed cadence.
    clearInterval(watchdog);
    watchdog = setInterval(() => {
      const now = performance.now();
      if (now - lastRafAt > 200) tick(now);
    }, 1000 / 60);

    return game;
  };
  game.stop = () => {
    game.running = false;
    cancelAnimationFrame(raf);
    clearInterval(watchdog);
    return game;
  };

  game.state = init(game);
  if (autoStart) game.start();

  // Handy for debugging from the console and for verification tooling.
  globalThis.__game = game;
  return game;
}

// ---------------------------------------------------------------- self-test contract

/**
 * registerSelftest(name, fn) — fn(check, log) runs a scripted, headless, deterministic session.
 *
 * Every game must assert, at minimum:
 *   - world initializes
 *   - the player/entity responds to injected input
 *   - a scoring or progress event fires
 *   - win AND lose are both reachable from a scripted run
 *   - no NaN/Infinity in state after >=600 frames
 *   - nothing throws
 */
export function registerSelftest(name, fn) {
  globalThis.__selftest = async () => {
    const checks = [];
    const logs = [];
    const check = (n, pass, detail = '') => {
      checks.push({ name: n, pass: !!pass, detail: String(detail).slice(0, 300) });
      return !!pass;
    };
    const log = (...a) => logs.push(a.map(String).join(' '));
    const started = performance.now();
    try {
      await fn(check, log);
    } catch (e) {
      checks.push({ name: 'selftest threw', pass: false, detail: (e && (e.stack || e.message) || String(e)).slice(0, 500) });
    }
    const pass = checks.length > 0 && checks.every((c) => c.pass);
    return { name, pass, checks, logs, ms: Math.round(performance.now() - started) };
  };
  globalThis.__selftestName = name;
}
