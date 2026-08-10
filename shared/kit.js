// Gamesx10 — shared kit.
// The contract every game implements. Zero dependencies, ES module, no build step.
//
// Determinism rule: games MUST NOT call Math.random() or Date.now() inside simulation.
// All randomness comes from a seeded RNG, all timing from the fixed-step accumulator.
// Same seed + same inputs => identical run. That is what makes window.__selftest() meaningful.

// Every game imports this module, so installing the collector here gives all ten pages
// error capture for free — including errors thrown before any game code runs. The runtime
// gate reads window.__errors to prove a page loaded clean, rather than trusting a screenshot.
if (typeof globalThis.addEventListener === 'function' && !globalThis.__errors) {
  globalThis.__errors = [];
  globalThis.addEventListener('error', (e) => {
    globalThis.__errors.push(String((e && (e.message || e.error)) || e));
  });
  globalThis.addEventListener('unhandledrejection', (e) => {
    globalThis.__errors.push('unhandled rejection: ' + String(e && e.reason));
  });
}

// ---------------------------------------------------------------- language (i18n)
//
// One toggle, shared across the hub and every game via localStorage. T(en, zh) is
// called at DRAW time (every frame), not once at init, so a mid-game toggle repaints
// immediately with no reload — the canvas is already being redrawn 60 times a second,
// translation just rides along. DOM chrome (the topbar's <h1>/.tag/.keys, which isn't
// canvas) is bound separately via [data-en][data-zh] attributes + mountLangToggle().

const LANG_KEY = 'gx10:lang';
const _langListeners = new Set();

function _detectLang() {
  if (typeof localStorage === 'undefined') return 'en';
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'en' || saved === 'zh') return saved;
  return (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) ? 'zh' : 'en';
}

let _lang = _detectLang();

export function currentLang() { return _lang; }

export function setLang(l) {
  if (l !== 'en' && l !== 'zh') return;
  _lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ }
  for (const fn of _langListeners) fn(l);
}

export function onLangChange(fn) { _langListeners.add(fn); return () => _langListeners.delete(fn); }

/** Pick a string for the active language. Call inline at draw time: T('Score', '分数'). */
export function T(en, zh) { return _lang === 'zh' ? zh : en; }

/**
 * Mounts a 中文/EN toggle button into `.topbar` (idempotent — safe to call every
 * frame or every boot) and binds every [data-en][data-zh] element in the DOM to swap
 * text on change. Games only need to add data-en/data-zh to their static topbar HTML;
 * this handles the button, the binding, and keeping <html lang> correct.
 */
export function mountLangToggle() {
  if (typeof document === 'undefined' || document.getElementById('gx10LangBtn')) return;
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;

  const applyDom = () => {
    document.documentElement.lang = _lang;
    for (const el of document.querySelectorAll('[data-en][data-zh]')) {
      el.textContent = _lang === 'zh' ? el.getAttribute('data-zh') : el.getAttribute('data-en');
    }
    const btn = document.getElementById('gx10LangBtn');
    if (btn) btn.textContent = _lang === 'zh' ? 'EN' : '中文';
  };

  const btn = document.createElement('button');
  btn.id = 'gx10LangBtn';
  btn.type = 'button';
  btn.className = 'lang-btn-inline';
  btn.setAttribute('aria-label', '切换语言 / switch language');
  btn.addEventListener('click', () => { setLang(_lang === 'zh' ? 'en' : 'zh'); applyDom(); });
  topbar.appendChild(btn);

  applyDom();
  onLangChange(applyDom);
}

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

// ---------------------------------------------------------------- presentation layer
//
// Shared chrome so all ten games read as one product rather than ten prototypes.
//
// The single biggest thing separating "prototype" from "shipped" here was HUD
// treatment: 9px labels floating in bare canvas corners look like debug output no
// matter how good the game under them is. These helpers impose one type scale, one
// panel language, and one way of drawing glowing entities.

/** One type scale for every game. Sizes are in CSS pixels. */
export const Type = {
  micro: 10,   // unit suffixes, footnotes
  label: 11,   // uppercase, letterspaced, dim — names a value
  small: 13,
  body: 15,
  value: 24,   // the number the label describes
  big: 34,
  huge: 54,    // title cards only
};

export const HUD_H = 56;

/** Wrap any drawing in a glow. Cheaper than drawing the shape three times. */
export function withGlow(ctx, color, blur, fn) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  fn();
  ctx.restore();
}

/**
 * A label/value pair — the atom of every HUD in the arcade.
 * Label sits above in small dim caps; the value below in a large bright figure.
 */
export function stat(ctx, x, y, label, value, {
  color = Palette.ink, labelColor = Palette.dim, align = 'left',
  valueSize = Type.value, labelSize = Type.label, mono = true,
} = {}) {
  const font = mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
                    : 'ui-serif, "New York", Palatino, Georgia, serif';
  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = labelColor;
  ctx.font = `600 ${labelSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const prev = ctx.letterSpacing;
  try { ctx.letterSpacing = '0.14em'; } catch { /* older engines */ }
  ctx.fillText(String(label).toUpperCase(), x, y);
  try { ctx.letterSpacing = prev || '0px'; } catch { /* ignore */ }
  ctx.fillStyle = color;
  ctx.font = `700 ${valueSize}px ${font}`;
  ctx.fillText(String(value), x, y + valueSize + 2);
  ctx.restore();
}

/** The top status strip. Gives the canvas a horizon line instead of floating text. */
export function hudStrip(ctx, g, { h = HUD_H, fill = 'rgba(13,16,24,0.92)', border = Palette.grid } = {}) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, g.w, h);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h + 0.5);
  ctx.lineTo(g.w, h + 0.5);
  ctx.stroke();
  ctx.restore();
  return h;
}

/** A framed surface. Use for draft cards, dossiers, palettes, end screens. */
export function panel(ctx, x, y, w, h, {
  fill = 'rgba(17,22,36,0.94)', border = Palette.grid, radius = 4,
  glowColor = null, glowBlur = 22, title = null, titleColor = Palette.dim,
} = {}) {
  ctx.save();
  if (glowColor) { ctx.shadowColor = glowColor; ctx.shadowBlur = glowBlur; }
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius);
  ctx.stroke();
  if (title) {
    ctx.fillStyle = titleColor;
    ctx.font = `600 ${Type.label}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(title).toUpperCase(), x + 13, y + 20);
  }
  ctx.restore();
}

/** A progress/health/resource bar with a proper track, cap and optional glow. */
export function meter(ctx, x, y, w, h, frac, {
  color = Palette.accent, track = 'rgba(255,255,255,0.07)', radius = null, glow = true,
} = {}) {
  const r = radius == null ? h / 2 : radius;
  const f = clamp(frac, 0, 1);
  ctx.save();
  ctx.fillStyle = track;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  if (f > 0.001) {
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
    ctx.fillStyle = color;
    roundRect(ctx, x, y, Math.max(h, w * f), h, r);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * An entity with actual depth: soft outer halo, solid core, bright rim.
 * Flat fillRect/arc circles are the main reason canvas games read as unfinished.
 */
export function orb(ctx, x, y, r, color, { glow = 1, rim = true, core = null } = {}) {
  ctx.save();
  if (glow > 0) {
    const grad = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * (2.2 + glow));
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.32 * glow;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r * (2.2 + glow), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = core || color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  if (rim) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.99, -1.9, 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

/** Darkens the edges so the eye lands on the middle. One call, big effect. */
export function vignette(ctx, g, strength = 0.5) {
  const grad = ctx.createRadialGradient(
    g.w / 2, g.h / 2, Math.min(g.w, g.h) * 0.32,
    g.w / 2, g.h / 2, Math.max(g.w, g.h) * 0.78,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${clamp(strength, 0, 1)})`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.restore();
}

/** Centred title card used by every intro/'game over' overlay. */
export function titleCard(ctx, g, { title, tagline, lines = [], prompt = null, t = 0, accent = Palette.accent }) {
  ctx.save();
  ctx.fillStyle = 'rgba(7,8,13,0.88)';
  ctx.fillRect(0, 0, g.w, g.h);
  const cx = g.w / 2;
  let y = g.h / 2 - 70;
  ctx.textAlign = 'center';
  withGlow(ctx, accent, 26, () => {
    ctx.fillStyle = accent;
    ctx.font = `700 ${Math.min(Type.huge, g.w * 0.09)}px ui-serif, "New York", Palatino, Georgia, serif`;
    ctx.fillText(title, cx, y);
  });
  y += 34;
  if (tagline) {
    ctx.fillStyle = Palette.ink;
    ctx.font = `500 ${Type.body}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText(tagline, cx, y);
    y += 26;
  }
  ctx.fillStyle = Palette.dim;
  ctx.font = `400 ${Type.small}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  for (const line of lines) { ctx.fillText(line, cx, y); y += 20; }
  if (prompt) {
    const pulse = 0.55 + 0.45 * Math.sin(t * 3);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = Palette.warm;
    ctx.font = `700 ${Type.small}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText(prompt, cx, y + 22);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
