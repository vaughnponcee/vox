// Piper synthesis off the main thread, so the mascot keeps animating while a
// sentence is being generated. Messages: {id, voiceId, text} -> {id, wav} | {id, error}
// and {id, voiceId, preload: true} -> {id, ready: true}. Progress: {progress, voiceId}.
const PIPER = "https://esm.sh/@mintplex-labs/piper-tts-web@1.0.5?deps=onnxruntime-web@1.20.1";
const PATHS = {
  onnxWasm: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/",
  piperData: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",
  piperWasm: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",
};

let lib = null;
const sessions = new Map();

function session(voiceId) {
  if (sessions.has(voiceId)) return sessions.get(voiceId);
  const p = (async () => {
    lib ??= await import(PIPER);
    // the library keeps one global session and ignores a second voice: clear it per voice
    lib.TtsSession._instance = null;
    return lib.TtsSession.create({
      voiceId,
      wasmPaths: PATHS,
      progress: (pr) => self.postMessage({ progress: pr.total ? pr.loaded / pr.total : 0, voiceId }),
    });
  })();
  sessions.set(voiceId, p);
  p.catch(() => sessions.delete(voiceId));
  return p;
}

// one synthesis at a time: the WASM runtime is single-threaded anyway
let chain = Promise.resolve();
self.onmessage = (e) => {
  const { id, voiceId, text, preload } = e.data;
  chain = chain.then(async () => {
    try {
      const s = await session(voiceId);
      if (preload) { self.postMessage({ id, ready: true }); return; }
      const wav = await (await s.predict(text)).arrayBuffer();
      self.postMessage({ id, wav }, [wav]);
    } catch (err) {
      self.postMessage({ id, error: String(err?.message ?? err) });
    }
  });
};
