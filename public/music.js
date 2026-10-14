'use strict';
/* Música de fondo generada en el navegador (Web Audio): un huayno corto en bucle.
   Quena (melodía), charango (rasgueo) y bombo. Sin archivos de audio ni derechos de autor. */
(function () {
  const KEY = 'rb_music';
  let on = true;
  try { on = localStorage.getItem(KEY) !== '0'; } catch (_) {}
  let ctx = null, master = null, timer = null, step = 0, nextT = 0, started = false;

  const BPM = 138, EIGHTH = 60 / BPM / 2;      // cada paso es una corchea
  const f = m => 440 * Math.pow(2, (m - 69) / 12);
  // Melodía de quena en La menor pentatónica: [paso, nota MIDI, duración en pasos]. 8 compases de 8 corcheas.
  const MEL = [
    [0, 76, 2], [2, 74, 1], [3, 72, 1], [4, 74, 2], [6, 76, 2],
    [8, 79, 2], [10, 76, 1], [11, 74, 1], [12, 76, 4],
    [16, 74, 2], [18, 72, 1], [19, 69, 1], [20, 72, 2], [22, 74, 2],
    [24, 76, 2], [26, 74, 1], [27, 72, 1], [28, 69, 4],
    [32, 81, 2], [34, 79, 1], [35, 76, 1], [36, 79, 2], [38, 81, 2],
    [40, 79, 2], [42, 76, 1], [43, 74, 1], [44, 76, 4],
    [48, 74, 2], [50, 76, 1], [51, 74, 1], [52, 72, 2], [54, 69, 2],
    [56, 67, 2], [58, 69, 1], [59, 72, 1], [60, 69, 4],
  ];
  const LEN = 64;
  const AM = [57, 60, 64], C = [60, 64, 67], G = [55, 59, 62], EM = [52, 55, 59];
  const CHORDS = [AM, C, G, AM, AM, C, EM, AM];   // un acorde por compás
  const STRUM = [0, 2, 3, 4, 6, 7];               // pasos con rasgueo dentro del compás

  function quena(t, freq, dur) {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
    const vib = ctx.createOscillator(), vg = ctx.createGain();
    o.type = 'sine'; o2.type = 'triangle'; o.frequency.value = freq; o2.frequency.value = freq;
    vib.frequency.value = 5.2; vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(freq * 0.006, t + Math.min(dur, 0.35));
    vib.connect(vg); vg.connect(o.frequency); vg.connect(o2.frequency);
    const mix = ctx.createGain(); mix.gain.value = 0.35; o2.connect(mix);
    o.connect(g); mix.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.05);
    g.gain.setValueAtTime(0.2, t + Math.max(0.06, dur - 0.08)); g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    g.connect(master);
    // soplido suave
    const n = ctx.createBufferSource(); n.buffer = noise; const nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = freq * 2; nf.Q.value = 3;
    ng.gain.setValueAtTime(0.03, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n.connect(nf); nf.connect(ng); ng.connect(master);
    [o, o2, vib].forEach(x => { x.start(t); x.stop(t + dur + 0.1); }); n.start(t); n.stop(t + 0.15);
  }
  function pluck(t, freq, vol, out) {
    const o = ctx.createOscillator(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = freq;
    fl.type = 'lowpass'; fl.frequency.setValueAtTime(3200, t); fl.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.32);
    o.connect(fl); fl.connect(g); g.connect(out || master); o.start(t); o.stop(t + 0.35);
  }
  function bombo(t, vol, out) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(out || master); o.start(t); o.stop(t + 0.4);
  }
  let noise = null;
  /* ---------- efectos: aparece un depredador ---------- */
  function hit(t) { // golpe de bombo grave + platillo corto
    bombo(t, 0.9, sfxOut); bombo(t + 0.09, 0.5, sfxOut);
    const n = ctx.createBufferSource(); n.buffer = noise; const hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 5000;
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    n.loop = true; n.connect(hp); hp.connect(g); g.connect(sfxOut); n.start(t); n.stop(t + 0.55);
  }
  function growl(t) { // rugido: diente de sierra grave con trémolo y caída de tono
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    const trem = ctx.createOscillator(), tg = ctx.createGain();
    o.type = 'sawtooth'; o2.type = 'square';
    o.frequency.setValueAtTime(150, t); o.frequency.linearRampToValueAtTime(95, t + 0.9);
    o2.frequency.setValueAtTime(152, t); o2.frequency.linearRampToValueAtTime(92, t + 0.9);
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(700, t); lp.frequency.linearRampToValueAtTime(1500, t + 0.25); lp.frequency.linearRampToValueAtTime(400, t + 1);
    trem.frequency.value = 26; tg.gain.value = 0.35; trem.connect(tg); tg.connect(g.gain);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.12); g.gain.linearRampToValueAtTime(0.35, t + 0.6); g.gain.linearRampToValueAtTime(0, t + 1.05);
    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(sfxOut);
    const n = ctx.createBufferSource(); n.buffer = noise; n.loop = true; const nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = 400; nf.Q.value = 1.2;
    ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.35, t + 0.1); ng.gain.linearRampToValueAtTime(0, t + 1);
    n.connect(nf); nf.connect(ng); ng.connect(sfxOut);
    [o, o2, trem, n].forEach(x => { x.start(t); x.stop(t + 1.1); });
  }
  function screech(t) { // chillido de ave: barrido agudo con vibrato rápido, dos veces
    [0, 0.32].forEach((d, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), bp = ctx.createBiquadFilter(), v = ctx.createOscillator(), vg = ctx.createGain();
      o.type = 'sawtooth'; const t0 = t + d;
      o.frequency.setValueAtTime(1500 + k * 200, t0); o.frequency.exponentialRampToValueAtTime(2700, t0 + 0.08); o.frequency.exponentialRampToValueAtTime(1100, t0 + 0.42);
      v.frequency.value = 38; vg.gain.value = 90; v.connect(vg); vg.connect(o.frequency);
      bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 2;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.32, t0 + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
      o.connect(bp); bp.connect(g); g.connect(sfxOut); [o, v].forEach(x => { x.start(t0); x.stop(t0 + 0.5); });
    });
  }
  let sfxOut = null;
  function chime(t) { // ¡tu turno!: arpegio ascendente de charango + campanita
    [69, 73, 76, 81].forEach((m, i) => pluck(t + i * 0.085, f(m + 12), 0.16, sfxOut));
    [88, 93].forEach((m, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = t + 0.34 + i * 0.12;
      o.type = 'sine'; o.frequency.value = f(m);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.38, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1);
      o.connect(g); g.connect(sfxOut); o.start(t0); o.stop(t0 + 1.2);
    });
  }
  function popSnd(t) { // burbuja de emote
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(1200, t + 0.08);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g); g.connect(sfxOut); o.start(t); o.stop(t + 0.18);
  }
  const BASE = () => (document.hidden ? 0 : 0.16);
  function sfx(kind) {
    if (!on || !ctx || !started) return;
    try {
      if (ctx.state !== 'running') ctx.resume();
      const t = ctx.currentTime + 0.02;
      // baja la música un momento para que se escuche el efecto
      master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(0.04, t, 0.05); master.gain.setTargetAtTime(BASE(), t + 1.4, 0.4);
      if (kind === 'turn') return chime(t);
      if (kind === 'pop') { master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(BASE(), t, 0.05); return popSnd(t); }
      hit(t);
      if (kind === 'condor' || kind === 'aguila') screech(t + 0.05); else growl(t + 0.05);
    } catch (_) {}
  }
  function play(s, t) {
    for (const [st, m, d] of MEL) if (st === s) quena(t, f(m), d * EIGHTH * 0.95);
    const inBar = s % 8, chord = CHORDS[Math.floor(s / 8)];
    if (STRUM.includes(inBar)) chord.forEach((m, i) => pluck(t + i * 0.012 * (inBar % 2 ? -1 : 1) + 0.02, f(m + 12), inBar === 0 ? 0.05 : 0.032));
    if (inBar === 0) bombo(t, 0.5); else if (inBar === 3 || inBar === 4) bombo(t, 0.22);
  }
  function tick() {
    while (nextT < ctx.currentTime + 0.25) { play(step, nextT); nextT += EIGHTH; step = (step + 1) % LEN; }
  }
  function start() {
    if (!on) return;
    try {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const comp = ctx.createDynamicsCompressor(); comp.connect(ctx.destination);
        master = ctx.createGain(); master.gain.value = 0; master.connect(comp);
        sfxOut = ctx.createGain(); sfxOut.gain.value = 0.35; sfxOut.connect(comp);
        noise = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
        const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      ctx.resume();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(0.16, ctx.currentTime, 0.4);
      if (!timer) { nextT = ctx.currentTime + 0.1; timer = setInterval(tick, 60); }
      started = true;
    } catch (_) { /* navegador sin Web Audio: se juega sin música */ }
    paint();
  }
  function stop() {
    if (ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    setTimeout(() => { if (!on) { clearInterval(timer); timer = null; ctx && ctx.suspend(); } }, 600);
    paint();
  }
  function paint() {
    const b = document.getElementById('musicBtn'); if (!b) return;
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Silenciar música y sonidos' : 'Activar música y sonidos';
    b.classList.toggle('off', !on);
  }
  function toggle() {
    on = !on; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (_) {}
    on ? start() : stop();
  }
  // Los navegadores solo permiten sonido después de una interacción: arranca con el primer toque o clic.
  const firstTouch = e => {
    if (e.target.closest && e.target.closest('#musicBtn')) return;
    if (on && !started) start();
  };
  document.addEventListener('pointerdown', firstTouch, true);
  document.addEventListener('keydown', firstTouch, true);
  document.addEventListener('visibilitychange', () => {
    if (!ctx || !on || !started) return;
    // en segundo plano se silencia la música, pero el audio sigue activo para avisar cuando es tu turno
    master.gain.setTargetAtTime(document.hidden ? 0 : 0.16, ctx.currentTime, 0.2);
    if (!document.hidden) ctx.resume();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('musicBtn'); if (b) b.addEventListener('click', toggle); paint();
  });
  window.RebanoMusic = { toggle, start, stop, sfx };
})();
