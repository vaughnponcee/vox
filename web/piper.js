// Piper neural TTS in the browser: small VITS voices (20 to 60 MB) that
// synthesize several times faster than real time on an ordinary CPU.
// Voices download once and are kept in the browser's private file storage.

// esm.sh lets us pin the ONNX runtime the library is built against; the WASM
// files must come from that exact same version.
const PIPER = "https://esm.sh/@mintplex-labs/piper-tts-web@1.0.5?deps=onnxruntime-web@1.20.1";
const PATHS = {
  onnxWasm: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/",
  piperData: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",
  piperWasm: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",
};

/** Piper voice per language; null means no Piper voice exists (use the browser's). */
export const PIPER_LANG = {
  en: "en_US-hfc_female-medium", zh: "zh_CN-huayan-medium", es: "es_ES-davefx-medium", fr: "fr_FR-siwis-medium",
  it: "it_IT-paola-medium", pt: "pt_BR-faber-medium", ja: null, hi: null, th: null,
};

let lib = null;
const sessions = new Map();

export async function piperSession(voiceId, onProgress) {
  if (sessions.has(voiceId)) return sessions.get(voiceId);
  const p = (async () => {
    lib ??= await import(PIPER);
    // TtsSession is a singleton that loads its model only once, so asking it for a
    // second voice silently keeps the first. Clear it to get a real session per voice.
    lib.TtsSession._instance = null;
    return lib.TtsSession.create({
      voiceId,
      wasmPaths: PATHS,
      progress: (pr) => onProgress?.(pr.total ? pr.loaded / pr.total : 0),
    });
  })();
  sessions.set(voiceId, p);
  p.catch(() => sessions.delete(voiceId));
  return p;
}

/** Text -> decoded AudioBuffer. */
export async function piperSynth(ctx, voiceId, text, onProgress) {
  const s = await piperSession(voiceId, onProgress);
  const wav = await s.predict(text);
  return ctx.decodeAudioData(await wav.arrayBuffer());
}
