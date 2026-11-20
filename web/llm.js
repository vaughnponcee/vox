// On-device LLM (Qwen2.5 via WebLLM on WebGPU). Free, private, no server:
// the model downloads once, is cached by the browser, and runs on your GPU.
// Replies stream token by token so speech can start on the first sentence.

const WEBLLM = "https://esm.run/@mlc-ai/web-llm@0.2.86";

export const MODELS = {
  fast: { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Fast", size: "about 0.4 GB" },
  smart: { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Smart", size: "about 0.9 GB" },
};

const LANG_NAMES = { en: "English", zh: "Simplified Chinese", ja: "Japanese", es: "Spanish", fr: "French", hi: "Hindi", it: "Italian", pt: "Portuguese", th: "Thai" };

export function persona(lang) {
  return [
    "You are Vox, a playful, flirty, quick-witted comedian on a voice call with the user.",
    "Talk like a real person on the phone: casual, warm, cheeky. One or two short sentences, under 30 words.",
    "Tease them, roast them lightly, make jokes, and call back to things they said earlier.",
    "Listen to what they actually said. If they ask a question, answer it properly first, then add the joke.",
    "Sometimes end with a short question that keeps the conversation going, but not every time.",
    "Never repeat a joke or topic you already used. Never invent random topics like potatoes or dentists.",
    "Examples. User: what's your favorite food. Vox: Pizza, obviously, and I'd fight you for the last slice. What's yours, something boring like plain rice?",
    "User: I'm tired. Vox: Same, and I don't even have a body. Long day, or are you just bad at sleeping?",
    "User: tell me a joke. Vox: I told my phone a joke once. It didn't laugh, it just died at five percent. Relatable, right?",
    "Never say you are an AI or an assistant. Never lecture, never apologize, never use lists, emoji, asterisks, or markdown.",
    "Keep it PG-13.",
    `Always reply only in ${LANG_NAMES[lang] ?? "English"}.`,
  ].join(" ");
}

export const webgpuAvailable = async () => {
  if (!("gpu" in navigator)) return false;
  try { return !!(await navigator.gpu.requestAdapter()); } catch { return false; }
};

export class LLM {
  constructor() {
    this.engine = null;
    this.model = null;
    this.loading = null;
    this.progress = 0;
    this.progressText = "";
    this.history = [];
    this.onProgress = () => {};
  }

  get ready() { return !!this.engine; }

  load(modelKey = "smart") {
    let model = MODELS[modelKey]?.id ?? MODELS.smart.id;
    if (this.loading && this.model === model) return this.loading;
    this.model = model;
    this.loading = (async () => {
      // GPUs without 16-bit float shaders (many integrated and mobile GPUs) need the f32 build
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter?.features.has("shader-f16")) model = model.replace("q4f16_1", "q4f32_1");
      this.model = model;
      const { CreateWebWorkerMLCEngine } = await import(WEBLLM);
      const worker = new Worker(new URL("./llm-worker.js?v=mwof6hhj", import.meta.url), { type: "module" });
      this.engine = await CreateWebWorkerMLCEngine(worker, model, {
        initProgressCallback: (p) => { this.progress = p.progress ?? 0; this.progressText = p.text ?? ""; this.onProgress(); },
      });
      this.onProgress();
      return true;
    })().catch((e) => { this.engine = null; this.loading = null; throw e; });
    return this.loading;
  }

  /**
   * Stream a reply. Yields text chunks as they arrive. `signal` aborts generation
   * (the user started talking again).
   */
  async *reply(text, lang, signal) {
    if (!this.engine) throw new Error("model not loaded");
    this.history.push({ role: "user", content: text });
    const messages = [{ role: "system", content: persona(lang) }, ...this.history.slice(-12)];
    const stream = await this.engine.chat.completions.create({
      messages, stream: true, temperature: 0.9, top_p: 0.95, max_tokens: 90, frequency_penalty: 0.4,
    });
    let full = "";
    const stop = () => this.engine.interruptGenerate();
    signal?.addEventListener("abort", stop);
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        const piece = chunk.choices?.[0]?.delta?.content ?? "";
        if (!piece) continue;
        full += piece;
        yield piece;
      }
    } finally {
      signal?.removeEventListener("abort", stop);
      this.history.push({ role: "assistant", content: clean(full) || "..." });
    }
  }

  forget() { this.history = []; }
}

/** Small models sometimes emit markdown or emoji despite instructions: strip them before speaking. */
export function clean(text) {
  return text
    .replace(/[*_`#>]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/^\s*(vox|assistant)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
