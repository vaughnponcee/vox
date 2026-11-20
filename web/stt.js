// Hold-to-talk recording + Whisper transcription.
// While the button is held, microphone audio is collected as raw samples; on
// release it is resampled to 16 kHz mono and sent to the Whisper worker.

export class Whisper {
  constructor() {
    this.worker = null;
    this.state = "off"; // off | loading | ready | failed
    this.progress = 0;
    this.onStatus = () => {};
    this.waiting = new Map();
    this.nextId = 0;
  }

  load(webgpu) {
    if (this.worker) return;
    this.state = "loading";
    this.worker = new Worker(new URL("./stt-worker.js?v=mwoewrpl", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") { this.progress = m.progress; this.onStatus(); return; }
      if (m.type === "ready") { this.state = "ready"; this.onStatus(); return; }
      if (m.type === "failed") { this.state = "failed"; console.warn("Whisper failed:", m.error); this.onStatus(); return; }
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error)) : w.resolve(m.text);
    };
    this.worker.onerror = (e) => { this.state = "failed"; console.warn("Whisper worker error:", e.message); this.onStatus(); };
    this.worker.postMessage({ type: "load", webgpu });
    this.onStatus();
  }

  /** lang: force a language code, or null to detect it. */
  transcribe(audio16k, lang = null) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: "run", id, audio: audio16k, lang }, [audio16k.buffer]);
    });
  }
}

/** Records raw microphone samples between start() and stop(). */
export class Recorder {
  constructor(ctx, stream) {
    this.ctx = ctx;
    this.src = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but universally available and needs no extra file
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.on = false;
    this.node.onaudioprocess = (e) => { if (this.on) this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    this.src.connect(this.node);
    // a silent sink keeps the processor running without echoing the mic
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(ctx.destination);
  }

  start() { this.chunks = []; this.on = true; }

  /** Stop and return 16 kHz mono samples. */
  async stop() {
    this.on = false;
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    if (!n) return new Float32Array(0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    return resampleTo16k(all, this.ctx.sampleRate);
  }
}

export async function resampleTo16k(samples, rate) {
  if (rate === 16000) return samples;
  const len = Math.ceil((samples.length * 16000) / rate);
  const off = new OfflineAudioContext(1, len, 16000);
  const buf = off.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}
