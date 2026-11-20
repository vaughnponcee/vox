// Whisper speech recognition off the main thread (transformers.js, WebGPU or WASM).
// Whisper hears every supported language without being told which one, which is
// what lets the bot switch language when you do.
// Messages: {type:"load", webgpu} -> {type:"ready"} | progress; {type:"run", id, audio} -> {id, text} | {id, error}
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm";

const MODEL = "onnx-community/whisper-base";
let asr = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "load") {
    try {
      const files = new Map();
      asr = await pipeline("automatic-speech-recognition", MODEL, {
        device: m.webgpu ? "webgpu" : "wasm",
        // fp32 encoder keeps accuracy; the decoder is small enough to quantize
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
      const out = await asr(m.audio, { task: "transcribe", chunk_length_s: 30 });
      self.postMessage({ id: m.id, text: (out.text ?? "").trim() });
    } catch (err) {
      self.postMessage({ id: m.id, error: String(err?.message ?? err) });
    }
  }
};
