// Whisper speech recognition off the main thread (transformers.js, WebGPU or WASM).
// Whisper hears every supported language without being told which one, which is
// what lets the bot switch language when you do.
// Messages: {type:"load", webgpu} -> {type:"ready"} | progress; {type:"run", id, audio} -> {id, text} | {id, error}
import { pipeline, Tensor } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm";

// base: about 80 to 150 MB and fast; small was accurate but took 30 s+ per sentence on a CPU
const MODEL = "onnx-community/whisper-base";
let asr = null;

// the languages the bot speaks; Whisper picks the likeliest of these
const LANGS = ["en", "zh", "ja", "es", "fr", "hi", "it", "pt", "th"];

// special-token ids are the same in every multilingual Whisper checkpoint
const ORDER = ["en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th"];
const FIXED = { "<|startoftranscript|>": 50258, ...Object.fromEntries(ORDER.map((l, i) => [`<|${l}|>`, 50259 + i])) };

/** Whisper's own language identification: one decoder step after <|startoftranscript|>. */
async function detect(audio) {
  const id = (t) => FIXED[t] ?? asr.tokenizer.model?.tokens_to_ids?.get(t);
  const { input_features } = await asr.processor(audio);
  const out = await asr.model({ input_features, decoder_input_ids: new Tensor("int64", [BigInt(id("<|startoftranscript|>"))], [1, 1]) });
  const logits = out.logits.data, V = out.logits.dims.at(-1);
  let best = "en", bestScore = -Infinity;
  for (const l of LANGS) { const sc = logits[logits.length - V + id(`<|${l}|>`)]; if (sc > bestScore) { bestScore = sc; best = l; } }
  return best;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "load") {
    try {
      const files = new Map();
      asr = await pipeline("automatic-speech-recognition", MODEL, {
                device: m.webgpu ? "webgpu" : "wasm",
        dtype: m.webgpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "q8", decoder_model_merged: "q8" },
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            let l = 0, t = 0;
            for (const [a, b] of files.values()) { l += a; t += b; }
            self.postMessage({ type: "progress", progress: l / t });
          }
        },
      });
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "failed", error: String(err?.message ?? err) });
    }
    return;
  }
  if (m.type === "run") {
    try {
      // the library assumes English unless told, which turns Chinese into an
      // English translation: identify the language first, then transcribe in it
      const language = m.lang || await detect(m.audio);
      const out = await asr(m.audio, { task: "transcribe", language, chunk_length_s: 30 });
      self.postMessage({ id: m.id, text: (out.text ?? "").trim(), lang: language });
    } catch (err) {
      self.postMessage({ id: m.id, error: String(err?.message ?? err) });
    }
  }
};
