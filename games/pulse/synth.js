// Pulse — the synth.
//
// Takes the note table produced by compose.js and plays it with WebAudio using
// LOOKAHEAD SCHEDULING: a 25ms setInterval walks the table and schedules every note
// that falls inside the next ~150ms directly onto the audio clock. No setTimeout per
// note, no rAF in the timing path — the AudioContext clock is the only clock.
//
// Everything is synthesised: no samples, no files, no network. Six voices —
// kick, snare, hat, bass, lead, pad — plus a tempo-synced delay on the lead.
//
// The game must stay fully playable with this module never instantiated, so nothing
// here is imported by compose.js or sim.js.

const TICK_MS = 25;
const LOOKAHEAD = 0.15;   // schedule this far ahead of the playhead, in seconds
const LEAD_IN = 0.12;     // let the scheduler get a head start before t=0

/** Tiny deterministic LCG — keeps Math.random() out of the whole game. */
function noiseBuffer(ctx, seconds = 2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 22222;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = (s / 2147483648) - 1;
  }
  return buf;
}

export class Sequencer {
  /** @param sound the shared kit Sound object (provides ctx + master). */
  constructor(sound) {
    this.sound = sound;
    this.ctx = null;
    this.notes = [];
    this.idx = 0;
    this.origin = 0;
    this.playing = false;
    this._timer = 0;
    this._live = [];
    this._noise = null;
    this.gainScale = 1;
  }

  // ---------------------------------------------------------------- graph

  _build() {
    const ctx = this.sound.ctx;
    if (!ctx || this.ctx === ctx) return !!ctx;
    this.ctx = ctx;
    this._noise = noiseBuffer(ctx);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    this.out = ctx.createGain();
    this.out.gain.value = 0.92;
    this.out.connect(comp);
    comp.connect(this.sound.master || ctx.destination);

    this.drums = ctx.createGain(); this.drums.gain.value = 0.95; this.drums.connect(this.out);
    this.music = ctx.createGain(); this.music.gain.value = 0.85; this.music.connect(this.out);

    // tempo-synced feedback delay, fed by the lead
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.24;
    this.fb = ctx.createGain(); this.fb.gain.value = 0.3;
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass'; this.damp.frequency.value = 2400;
    this.wet = ctx.createGain(); this.wet.gain.value = 0.5;
    this.delay.connect(this.damp);
    this.damp.connect(this.fb);
    this.fb.connect(this.delay);
    this.damp.connect(this.wet);
    this.wet.connect(this.out);
    return true;
  }

  // ---------------------------------------------------------------- transport

  /** Start `song` from the top. Safe to call when audio is unavailable — it no-ops. */
  play(song) {
    this.stop();
    if (!this.sound.ctx) return false;
    if (!this._build()) return false;
    const ctx = this.ctx;
    this.notes = song.notes;
    this.idx = 0;
    this.origin = ctx.currentTime + LEAD_IN;
    this.delay.delayTime.setValueAtTime(Math.min(1.4, song.s16 * 3), ctx.currentTime);
    this.playing = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), TICK_MS);
    return true;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = 0; }
    this.playing = false;
    const ctx = this.ctx;
    if (ctx) {
      for (const n of this._live) { try { n.stop(ctx.currentTime); } catch { /* already done */ } }
    }
    this._live.length = 0;
    this.idx = 0;
  }

  /** Seconds since the top of the song. Negative during the lead-in. */
  get songTime() {
    if (!this.ctx || !this.playing) return 0;
    return this.ctx.currentTime - this.origin;
  }

  get running() {
    return !!(this.playing && this.ctx && this.ctx.state === 'running');
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // ---------------------------------------------------------------- the lookahead loop

  _tick() {
    if (!this.playing || !this.ctx) return;
    const horizon = this.songTime + LOOKAHEAD;
    const notes = this.notes;
    let guard = 0;
    while (this.idx < notes.length && notes[this.idx].time <= horizon && guard++ < 256) {
      const n = notes[this.idx++];
      const at = this.origin + n.time;
      if (at < this.ctx.currentTime - 0.05) continue;     // tab was asleep — drop, don't pile up
      this._voice(n, at);
    }
    // retire finished nodes
    const now = this.ctx.currentTime;
    if (this._live.length > 220) {
      this._live = this._live.filter((n) => (n._endsAt || 0) > now);
    }
  }

  _keep(node, endsAt) {
    node._endsAt = endsAt;
    this._live.push(node);
    return node;
  }

  _voice(n, at) {
    switch (n.kind) {
      case 'kick': return this._kick(at, n.velocity);
      case 'snare': return this._snare(at, n.velocity);
      case 'hat': return this._hat(at, n.velocity);
      case 'bass': return this._bass(at, n.dur, n.freq, n.velocity);
      case 'lead': return this._lead(at, n.dur, n.freq, n.velocity);
      case 'pad': return this._pad(at, n.dur, n.freq, n.velocity);
      default: return undefined;
    }
  }

  _noiseSrc(at, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    src.playbackRate.value = 1;
    src.start(at, (at * 7.13) % 1.5, dur + 0.02);
    this._keep(src, at + dur + 0.05);
    return src;
  }

  _kick(at, v = 1) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(168, at);
    o.frequency.exponentialRampToValueAtTime(44, at + 0.1);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.02, 0.95 * v * this.gainScale), at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    o.connect(g); g.connect(this.drums);
    o.start(at); o.stop(at + 0.34);
    this._keep(o, at + 0.34);

    const click = this._noiseSrc(at, 0.02);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.18 * v * this.gainScale, at);
    cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.02);
    click.connect(hp); hp.connect(cg); cg.connect(this.drums);
  }

  _snare(at, v = 1) {
    const ctx = this.ctx;
    const dur = 0.17;
    const src = this._noiseSrc(at, dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1750; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.42 * v * this.gainScale, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp); bp.connect(g); g.connect(this.drums);

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(196, at);
    o.frequency.exponentialRampToValueAtTime(150, at + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, at);
    og.gain.exponentialRampToValueAtTime(0.2 * v * this.gainScale, at + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    o.connect(og); og.connect(this.drums);
    o.start(at); o.stop(at + 0.12);
    this._keep(o, at + 0.12);
  }

  _hat(at, v = 0.4) {
    const ctx = this.ctx;
    const dur = 0.045;
    const src = this._noiseSrc(at, dur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22 * v * this.gainScale, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(hp); hp.connect(g); g.connect(this.drums);
  }

  _bass(at, dur, freq, v = 0.8) {
    const ctx = this.ctx;
    const d = Math.max(0.06, dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 7;
    lp.frequency.setValueAtTime(Math.min(6000, freq * 7 + 180), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(90, freq * 1.6 + 60), at + Math.min(0.14, d));
    const g = ctx.createGain();
    const peak = 0.3 * v * this.gainScale;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.01);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.6), at + d * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, at + d + 0.05);
    lp.connect(g); g.connect(this.music);
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(lp);
      o.start(at); o.stop(at + d + 0.09);
      this._keep(o, at + d + 0.09);
    }
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, at);
    sg.gain.exponentialRampToValueAtTime(0.22 * v * this.gainScale, at + 0.012);
    sg.gain.exponentialRampToValueAtTime(0.0001, at + d + 0.04);
    sub.connect(sg); sg.connect(this.music);
    sub.start(at); sub.stop(at + d + 0.08);
    this._keep(sub, at + d + 0.08);
  }

  _lead(at, dur, freq, v = 1) {
    const ctx = this.ctx;
    const d = Math.max(0.05, dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 3.2;
    lp.frequency.setValueAtTime(Math.min(11000, freq * 5 + 900), at);
    lp.frequency.exponentialRampToValueAtTime(Math.min(9000, freq * 1.7 + 320), at + Math.min(0.22, d + 0.05));
    const g = ctx.createGain();
    const peak = 0.17 * v * this.gainScale;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.006);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.55), at + d * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + d + 0.07);
    lp.connect(g);
    g.connect(this.music);
    const send = ctx.createGain();
    send.gain.value = 0.3 * v;
    g.connect(send); send.connect(this.delay);

    const a = ctx.createOscillator();
    a.type = 'square'; a.frequency.value = freq; a.detune.value = -5;
    const b = ctx.createOscillator();
    b.type = 'sawtooth'; b.frequency.value = freq; b.detune.value = 8;
    const bg = ctx.createGain(); bg.gain.value = 0.55;
    a.connect(lp); b.connect(bg); bg.connect(lp);
    a.start(at); a.stop(at + d + 0.12);
    b.start(at); b.stop(at + d + 0.12);
    this._keep(a, at + d + 0.12); this._keep(b, at + d + 0.12);
  }

  _pad(at, dur, freq, v = 0.3) {
    const ctx = this.ctx;
    const d = Math.max(0.2, dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(4000, freq * 3 + 500); lp.Q.value = 0.8;
    const g = ctx.createGain();
    const peak = 0.075 * v * this.gainScale;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.3, d * 0.35));
    g.gain.setValueAtTime(peak, at + d * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, at + d + 0.12);
    lp.connect(g); g.connect(this.music);
    for (const det of [-9, 6]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(lp);
      o.start(at); o.stop(at + d + 0.16);
      this._keep(o, at + d + 0.16);
    }
  }
}

export default Sequencer;
