// Voice output: Kokoro-82M neural TTS in the browser (ONNX via transformers.js,
// WebGPU when available, else WASM), with the browser's own SpeechSynthesis as
// the fallback and for languages Kokoro's browser build doesn't phonemize.
// All Kokoro audio goes through one AnalyserNode so the face can lip-sync.

const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Voice presets. Kokoro's browser package speaks American and British English;
// everything else goes to a native voice for that language.
export const VOICES = [
  { id: "host", label: "AMERICAN HOST", engine: "kokoro", voice: "am_michael", lang: "en-US", pitch: 0, rate: 1.05 },
  { id: "deadpan", label: "BRITISH DEADPAN", engine: "kokoro", voice: "bm_george", lang: "en-GB", pitch: -2, rate: 0.92 },
  { id: "diva", label: "DRAMA QUEEN", engine: "kokoro", voice: "af_heart", lang: "en-US", pitch: 2, rate: 1.1 },
  { id: "posh", label: "POSH NARRATOR", engine: "kokoro", voice: "bf_emma", lang: "en-GB", pitch: 0, rate: 0.95 },
  { id: "polyglot", label: "POLYGLOT", engine: "native", voice: null, lang: "auto", pitch: 0, rate: 1 },
];

export const LANGS = {
  en: { name: "ENGLISH", bcp: "en-US" }, zh: { name: "MANDARIN", bcp: "zh-CN" }, ja: { name: "JAPANESE", bcp: "ja-JP" },
  es: { name: "SPANISH", bcp: "es-ES" }, fr: { name: "FRENCH", bcp: "fr-FR" }, hi: { name: "HINDI", bcp: "hi-IN" },
  it: { name: "ITALIAN", bcp: "it-IT" }, pt: { name: "PORTUGUESE", bcp: "pt-BR" }, th: { name: "THAI", bcp: "th-TH" },
};

export class Voice {
  constructor() {
    this.ctx = null;
    this.out = null;       // analyser for lip-sync and the output meter
    this.kokoro = null;
    this.loading = null;
    this.status = "native"; // native | loading | kokoro-webgpu | kokoro-wasm | failed
    this.progress = 0;
    this.pitch = 0;        // semitones
    this.speed = 1;
    this.nativeLevel = 0;  // fake amplitude while SpeechSynthesis talks (no audio stream access)
    this.rtf = null;       // real-time factor of the last neural synthesis (synth time / audio time)
    this.tooSlow = false;  // set when the device can't synthesize in real time; cleared by forceNeural()
    this.onStatus = () => {};
  }

  /** The user insists on the neural voice even on a slow device. */
  forceNeural() { this.tooSlow = false; this.forced = true; this.onStatus(); }

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.out = this.ctx.createAnalyser();
      this.out.fftSize = 1024;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Download (first time) or load from the browser cache, then keep the model in memory. */
  loadKokoro() {
    if (this.loading) return this.loading;
    if (typeof WebAssembly === "undefined") { this.status = "failed"; this.onStatus(); return Promise.resolve(false); }
    this.status = "loading";
    this.onStatus();
    this.loading = (async () => {
      try {
        const { KokoroTTS } = await import(KOKORO_URL);
        const webgpu = "gpu" in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null));
        const files = new Map();
        this.kokoro = await KokoroTTS.from_pretrained(MODEL, {
          dtype: webgpu ? "fp32" : "q8",
          device: webgpu ? "webgpu" : "wasm",
          progress_callback: (p) => {
            if (p.status === "progress" && p.total) {
              files.set(p.file, [p.loaded, p.total]);
              let l = 0, t = 0;
              for (const [a, b] of files.values()) { l += a; t += b; }
              this.progress = l / t;
              this.onStatus();
            }
          },
        });
        this.status = webgpu ? "kokoro-webgpu" : "kokoro-wasm";
        this.onStatus();
        return true;
      } catch (e) {
        console.warn("Kokoro unavailable, using native speech:", e);
        this.status = "failed";
        this.onStatus();
        return false;
      }
    })();
    return this.loading;
  }

  /** Synthesize ahead of time. Returns something play() understands. */
  async prepare(text, preset, lang) {
    const kokoroOk = preset.engine === "kokoro" && lang === "en" && this.kokoro && !this.tooSlow;
    if (!kokoroOk) return { kind: "native", text, preset, lang };
    const t0 = performance.now();
    const audio = await this.kokoro.generate(text, { voice: preset.voice, speed: 1 });
    const buf = this.ctx.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buf.copyToChannel(audio.audio, 0);
    const synthMs = performance.now() - t0;
    this.rtf = synthMs / (buf.duration * 1000);
    // slower than real time (allowing for first-run warm-up): the bot would go silent
    // between lines, so hand over to the native voice and say so
    this.synths = (this.synths ?? 0) + 1;
    // the first synthesis pays one-time warm-up costs, so judge speed from the second on
    if (this.synths > 1 && this.rtf > 1.5 && !this.forced) { this.tooSlow = true; this.onStatus(); }
    return { kind: "kokoro", buf, synthMs, text };
  }

  play(prepared, signal) {
    return prepared.kind === "kokoro" ? this.playBuffer(prepared.buf, signal) : this.speakNative(prepared, signal);
  }

  playBuffer(buf, signal) {
    return new Promise((resolve, reject) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      // pitch and speed independently: playbackRate changes both, detune corrects pitch back
      src.playbackRate.value = this.speed;
      src.detune.value = this.pitch * 100 - 1200 * Math.log2(this.speed);
      src.connect(this.out);
      src.onended = () => resolve();
      signal?.addEventListener("abort", () => { try { src.stop(); } catch { /* not started */ } reject(new Error("aborted")); });
      src.start();
    });
  }

  speakNative({ text, preset, lang }, signal) {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(text);
      const bcp = preset.lang === "auto" || lang !== "en" ? LANGS[lang]?.bcp ?? "en-US" : preset.lang;
      u.lang = bcp;
      const v = speechSynthesis.getVoices().find((x) => x.lang.replace("_", "-").toLowerCase().startsWith(bcp.toLowerCase().slice(0, 2)) && x.lang.toLowerCase().includes(bcp.slice(3).toLowerCase()))
        ?? speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(bcp.slice(0, 2).toLowerCase()));
      if (v) u.voice = v;
      u.pitch = Math.max(0, Math.min(2, 1 + (preset.pitch + this.pitch) / 12));
      u.rate = Math.max(0.5, Math.min(2, preset.rate * this.speed));
      // no audio stream to analyse: animate the mouth from word boundaries
      let timer = 0;
      u.onboundary = () => { this.nativeLevel = 0.7 + Math.random() * 0.3; };
      u.onstart = () => { timer = setInterval(() => { this.nativeLevel *= 0.82; if (Math.random() < 0.25) this.nativeLevel = Math.max(this.nativeLevel, 0.4 + Math.random() * 0.5); }, 50); };
      const done = () => { clearInterval(timer); this.nativeLevel = 0; };
      u.onend = () => { done(); resolve(); };
      u.onerror = (e) => { done(); e.error === "interrupted" || e.error === "canceled" ? reject(new Error("aborted")) : resolve(); };
      signal?.addEventListener("abort", () => { speechSynthesis.cancel(); done(); reject(new Error("aborted")); });
      speechSynthesis.speak(u);
    });
  }

  /** Current output loudness 0..1 for the face and the output VU meter. */
  level() {
    if (this.nativeLevel > 0.01) return this.nativeLevel;
    if (!this.out) return 0;
    const d = new Float32Array(this.out.fftSize);
    this.out.getFloatTimeDomainData(d);
    let s = 0;
    for (const x of d) s += x * x;
    return Math.min(1, Math.sqrt(s / d.length) * 4);
  }

  // ---------------------------------------------------------------- stings, synthesized
  sting(name, signal) {
    this.unlock();
    const c = this.ctx, t = c.currentTime, out = this.out;
    const g = (v) => { const n = c.createGain(); n.gain.value = v; n.connect(out); return n; };
    const noise = (dur) => {
      const b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = c.createBufferSource(); s.buffer = b; return s;
    };
    let dur = 0;
    if (name === "boom") {
      // the deep, bass-heavy hit: sine sweeping down plus a thump of filtered noise
      const o = c.createOscillator(), og = g(0.9);
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(32, t + 1.4);
      og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.9, t + 0.01); og.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(og); o.start(t); o.stop(t + 1.7);
      const n = noise(0.25), f = c.createBiquadFilter(), ng = g(0.6);
      f.type = "lowpass"; f.frequency.value = 180; ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      n.connect(f).connect(ng); n.start(t);
      dur = 1.7;
    } else if (name === "rimshot") {
      // ba-dum-tss: two tom hits and a cymbal
      for (const [at, hz] of [[0, 180], [0.18, 140]]) {
        const o = c.createOscillator(), og = g(0.6);
        o.frequency.setValueAtTime(hz, t + at); o.frequency.exponentialRampToValueAtTime(hz * 0.5, t + at + 0.18);
        og.gain.setValueAtTime(0.6, t + at); og.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.2);
        o.connect(og); o.start(t + at); o.stop(t + at + 0.22);
      }
      const n = noise(0.7), f = c.createBiquadFilter(), ng = g(0.35);
      f.type = "highpass"; f.frequency.value = 6000;
      ng.gain.setValueAtTime(0.35, t + 0.4); ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
      n.connect(f).connect(ng); n.start(t + 0.4);
      dur = 1.1;
    } else if (name === "crickets") {
      // pulsed high tones in irregular chirps
      for (let k = 0; k < 9; k++) {
        const at = k * 0.28 + (k % 3) * 0.05;
        const o = c.createOscillator(), og = g(0);
        o.frequency.value = 4400 + (k % 2) * 300;
        for (let p = 0; p < 3; p++) { og.gain.setValueAtTime(0.12, t + at + p * 0.04); og.gain.setValueAtTime(0, t + at + p * 0.04 + 0.02); }
        o.connect(og); o.start(t + at); o.stop(t + at + 0.15);
      }
      dur = 2.7;
    } else return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, dur * 1000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
    });
  }
}
