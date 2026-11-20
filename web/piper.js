// Piper neural TTS: small VITS voices (20 to 110 MB) that synthesize several
// times faster than real time on an ordinary CPU. Synthesis runs in a worker
// (piper-worker.js) so the page never freezes; voices download once and are kept
// in the browser's private file storage.

/** Default Piper speaker per language; null means none exists (use the browser's voice). */
export const PIPER_LANG = {
  en: "en_US-ryan-medium", zh: "zh_CN-huayan-medium", es: "es_MX-ald-medium", fr: "fr_FR-siwis-medium",
  it: "it_IT-paola-medium", pt: "pt_BR-faber-medium", ja: null, hi: null, th: null,
};

let worker = null, nextId = 0;
const waiting = new Map();
const progressListeners = new Set();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./piper-worker.js?v=mwoh8r46", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.progress != null) { for (const f of progressListeners) f(m.progress, m.voiceId); return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error)) : w.resolve(m);
  };
  worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || "piper worker failed")); waiting.clear(); };
  return worker;
}

function call(msg) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

export function onPiperProgress(f) { progressListeners.add(f); }

/** Download and initialize a voice ahead of time. */
export function piperSession(voiceId) { return call({ voiceId, preload: true }); }

/** Text -> decoded AudioBuffer (synthesis happens in the worker). */
export async function piperSynth(ctx, voiceId, text) {
  const { wav } = await call({ voiceId, text });
  return ctx.decodeAudioData(wav);
}
