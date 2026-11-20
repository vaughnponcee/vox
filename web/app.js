// vox-chaos: push-to-talk, speech recognition, the brain, the audio queue,
// voices, stings and the mascot, wired together.
import { Brain } from "./brain.js";
import { AudioQueue, sentences } from "./queue.js";
import { Voice, VOICES, LANGS } from "./voice.js";
import { Face } from "./face.js";
import { LLM, MODELS, clean, webgpuAvailable } from "./llm.js";

const $ = (id) => document.getElementById(id);
const [corpus, data] = await Promise.all([
  fetch("data/corpus.json").then((r) => r.json()),
  fetch("data/brain.json").then((r) => r.json()),
]);

const brain = new Brain(corpus, data, { trapEvery: 0 });
const llm = new LLM();
const hasGPU = await webgpuAvailable();
// brain mode: "smart" / "fast" = on-device LLM, "lite" = instant joke engine
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
let mode = store.get("vox.mode");
let trapsOn = true, turnsSinceTrap = 0;
let generation = null; // AbortController for the reply being generated
let slowGPU = false;
const voice = new Voice();
const face = new Face($("face"));
let speaking = false;
const queue = new AudioQueue({ lookahead: 1, onState: (s) => { speaking = s.state === "playing"; refreshState(); } });
let lang = "en", preset = VOICES[0], thinking = false, holding = false;

// ---------------------------------------------------------------- state: idle / listening / thinking / talking
const STATUS = { idle: "Hold to talk", listening: "Listening...", thinking: "Contemplating...", talking: "Talking..." };
let loadingText = "";
function refreshState() {
  const s = holding ? "listening" : thinking ? "thinking" : speaking ? "talking" : "idle";
  document.body.dataset.state = s;
  $("status").textContent = s === "idle" && loadingText ? loadingText : STATUS[s];
  face.listening = s === "listening";
  face.thinking = s === "thinking";
}

// ---------------------------------------------------------------- the card + history
function show(text, _kind, you = "") {
  const line = $("line");
  line.classList.remove("fresh"); void line.offsetWidth; line.classList.add("fresh");
  line.textContent = text;
  $("you").hidden = !you;
  $("you").textContent = you ? `“${you}”` : "";
}
function history(text, who, tag = "") {
  const li = document.createElement("li");
  li.className = who;
  li.textContent = text;
  if (tag) { const s = document.createElement("span"); s.textContent = tag; li.prepend(s); }
  $("history").append(li);
  while ($("history").children.length > 40) $("history").firstChild.remove();
}

// ---------------------------------------------------------------- settings sheet
const openSheet = (on) => { $("sheet").classList.toggle("open", on); $("scrim").classList.toggle("open", on); };
$("close").onclick = () => openSheet(false);
$("cc").onclick = () => {
  const on = $("cc").getAttribute("aria-pressed") !== "true";
  $("cc").setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("cc-off", !on);
};
$("stop").onclick = () => { generation?.abort(); queue.interrupt(); voice.nativeLevel = 0; if ("speechSynthesis" in window) speechSynthesis.cancel(); };
$("menu").onclick = () => openSheet(!$("sheet").classList.contains("open"));
$("scrim").onclick = () => openSheet(false);
const nice = (s) => s.charAt(0) + s.slice(1).toLowerCase();

for (const [code, l] of Object.entries(LANGS)) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = nice(l.name);
  b.setAttribute("aria-pressed", String(code === lang));
  b.onclick = () => {
    lang = code;
    document.querySelectorAll("#langs .chip").forEach((k) => k.setAttribute("aria-pressed", String(k === b)));
    if (lang !== "en" && preset.engine === "kokoro") selectVoice(VOICES.find((v) => v.id === "polyglot"));
    $("lang-label").textContent = b.textContent;
    voice.preload(preset, lang);
    show(`Now in ${b.textContent}. Go on, say something.`, "sys");
  };
  $("langs").append(b);
}
function selectVoice(v) {
  preset = v;
  if (mode) voice.preload(v, lang);
  document.querySelectorAll("#voices .chip").forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.id === v.id)));
}
for (const v of VOICES) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = nice(v.label);
  b.dataset.id = v.id;
  b.onclick = () => { selectVoice(v); voice.unlock(); if (v.engine === "kokoro") void voice.loadKokoro(); voice.onStatus(); };
  $("voices").append(b);
}
selectVoice(preset);

$("pitch").oninput = (e) => { voice.pitch = +e.target.value; };
$("speed").oninput = (e) => { voice.speed = +e.target.value; };
$("sw-text").onchange = (e) => { document.body.classList.toggle("text-mode", e.target.checked); if (e.target.checked) { openSheet(false); $("text").focus(); } };
$("sw-traps").onchange = (e) => { trapsOn = e.target.checked; };
$("sw-llm").onchange = (e) => { brain.llmUrl = e.target.checked ? $("llm-url").value.trim() : null; };
$("llm-url").onchange = () => { if ($("sw-llm").checked) brain.llmUrl = $("llm-url").value.trim(); };
// ---------------------------------------------------------------- brain mode
function setMode(m) {
  mode = m;
  slowGPU = false;
  store.set("vox.mode", m);
  document.querySelectorAll("#modes .chip").forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.mode === m)));
  $("setup").hidden = true;
  voice.preload(preset, lang);
  if (m !== "lite") loadModel();
  else { loadingText = ""; refreshState(); }
  renderBrainNote();
}
function renderBrainNote() {
  $("brain-note").textContent = mode === "lite" ? "Instant joke engine: traps, roasts and riddles. No download."
    : !hasGPU ? "This browser has no WebGPU, so the AI can't run here. Using the joke engine. Try Chrome or Edge."
    : slowGPU ? "Your GPU is too slow for the AI to answer quickly, so the joke engine is answering. Try Fast AI."
    : llm.ready ? `Running ${llm.model.split("-q4")[0]} on your GPU.`
    : `Downloads ${MODELS[mode].size} once, then works offline.`;
}
function loadModel() {
  if (!hasGPU) { loadingText = ""; renderBrainNote(); return; }
  llm.onProgress = () => {
    loadingText = llm.ready ? "" : `Waking up... ${Math.round(llm.progress * 100)}%`;
    refreshState();
    renderBrainNote();
  };
  llm.load(mode).then(() => { loadingText = ""; refreshState(); renderBrainNote(); }).catch((e) => {
    console.warn("LLM failed to load:", e);
    loadingText = "";
    refreshState();
    $("brain-note").textContent = "The AI couldn't start on this device, so the joke engine is answering.";
  });
}
document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
document.querySelectorAll("[data-sting]").forEach((b) => (b.onclick = () => {
  voice.unlock();
  queue.push({ label: b.dataset.sting, play: (_p, s) => { face.punch(); return voice.sting(b.dataset.sting, s); } });
}));

voice.onStatus = () => {
  const s = voice.status;
  $("engine").textContent =
    preset.engine === "kokoro"
      ? (s === "loading" ? `Downloading the studio voice... ${Math.round(voice.progress * 100)}%`
        : s === "failed" ? "Studio voice unavailable here: using the fast voice"
        : voice.tooSlow ? `Studio voice too slow on this device (${voice.rtf?.toFixed(1)}x real time): using the fast voice`
        : s === "kokoro-webgpu" ? "Kokoro-82M on your GPU" : "Kokoro-82M on your CPU")
      : preset.engine === "native" ? "Your browser's built-in voice"
      : voice.piperOk === false ? "Neural voice unavailable: using your browser's voice"
      : "Piper neural voice, runs on your CPU";
};

// ---------------------------------------------------------------- speaking
const stat = { layer: "", ms: "", tts: "" };
function renderStats() {
  $("stats").innerHTML = "";
  for (const [k, v] of [["Brain layer", stat.layer], ["Think time", stat.ms], ["Voice", stat.tts]]) {
    if (!v) continue;
    const d = document.createElement("div");
    d.textContent = `${k}: `;
    const b = document.createElement("b"); b.textContent = v; d.append(b);
    $("stats").append(d);
  }
}

function speak(text, sfx) {
  const p = preset, l = lang;
  for (const part of sentences(text)) {
    queue.push({
      label: part,
      prepare: () => voice.prepare(part, p, l),
      play: (prep, signal) => { stat.tts = prep.kind === "kokoro" ? `${prep.engine === "piper" ? "Piper" : "Kokoro"}, ${Math.round(prep.synthMs)} ms to synthesize` : "browser voice"; renderStats(); return voice.play(prep, signal); },
    });
  }
  if (sfx) queue.push({ label: sfx, play: (_p, s) => { face.punch(sfx === "crickets" ? "shocked" : "smug"); return voice.sting(sfx, s); } });
}

/** Smart mode: stream the LLM reply, speaking each sentence as soon as it is complete. */
async function handleSmart(text) {
  generation?.abort();
  const ctrl = new AbortController();
  generation = ctrl;
  thinking = true; refreshState();
  history(text, "you");
  const t0 = performance.now();
  let buf = "", said = "", first = 0;
  const flush = (final) => {
    // speak whole sentences; keep the unfinished tail for the next chunk
    const m = final ? [buf, buf, ""] : /^([\s\S]*?(?:[.!?…]["')\]]*\s|[。！？]["'）」]*))([\s\S]*)$/.exec(buf);
    if (!m) return;
    const sentence = clean(m[1]);
    buf = final ? "" : m[2];
    if (!sentence) return;
    if (!first) { first = performance.now() - t0; thinking = false; refreshState(); }
    said += (said ? " " : "") + sentence;
    show(said, "llm", text);
    speak(sentence, null);
  };
  // a GPU too slow to start replying within 12 s would leave you hanging:
  // answer this turn with the joke engine instead
  let started = false;
  const slow = setTimeout(() => { if (!started) { ctrl.abort(); slowGPU = true; void handleLite(text, true); } }, 12000);
  try {
    for await (const piece of llm.reply(text, lang, ctrl.signal)) {
      started = true;
      if (ctrl.signal.aborted) return;
      buf += piece;
      while (buf && /[.!?…]["')\]]*\s|[。！？]/.test(buf)) { const before = buf; flush(false); if (buf === before) break; }
    }
    if (!ctrl.signal.aborted) flush(true);
    clearTimeout(slow);
  } catch (e) {
    clearTimeout(slow);
    console.warn("LLM reply failed, using the joke engine:", e);
    thinking = false;
    return handleLite(text, true);
  }
  thinking = false;
  if (said) {
    history(said, "vox", "AI");
    stat.layer = "on-device AI"; stat.ms = `${Math.round(first)} ms to first sentence`; renderStats();
  }
  refreshState();
}

async function handle(text) {
  text = text.trim();
  if (!text) return;
  const smart = mode !== "lite" && llm.ready && !brain.traps.active && !slowGPU;
  const wantsTrap = brain.intent(text, lang) === "trap" || (trapsOn && ++turnsSinceTrap >= 6);
  if (smart && !wantsTrap) return handleSmart(text);
  if (wantsTrap) turnsSinceTrap = 0;
  return handleLite(text);
}

async function handleLite(text, logged = false) {
  thinking = true; refreshState();
  if (!logged) history(text, "you");
  const r = brain.traps.active || brain.intent(text, lang) === "trap" ? brain.reply(text, lang)
    : (trapsOn && turnsSinceTrap === 0 && mode !== "lite") ? (brain.traps.start(lang, brain.rng), { text: brain.traps.active?.steps[0].say ?? "", sfx: null, layer: "trap", ms: 0 })
    : await brain.replyAsync(text, lang);
  // a short beat of "contemplating" reads better than an instant answer
  await new Promise((res) => setTimeout(res, 280));
  thinking = false;
  const kind = r.layer === "retrieval" ? (r.sfx === "boom" ? "roast" : r.text.includes(" ... ") ? "joke" : "retrieval") : r.layer;
  show(r.text.replace(" ... ", "\n"), kind, text);
  history(r.text, "vox", r.layer);
  stat.layer = r.layer; stat.ms = `${r.ms.toFixed(2)} ms`; renderStats();
  speak(r.text.replace(" ... ", ". "), r.sfx);
  refreshState();
}

const send = () => {
  voice.unlock();
  if (!voice.loading && $("sw-neural").checked) void voice.loadKokoro();
  queue.interrupt();
  void handle($("text").value);
  $("text").value = "";
};
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
$("send").onclick = send;

// ---------------------------------------------------------------- push to talk
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, heard = "", interim = "", recStart = 0, micStream = null, micAnalyser = null;

if (!SR) {
  $("note").textContent = "This browser has no speech recognition (Chrome and Edge do). Typing is on.";
  $("sw-text").checked = true;
  document.body.classList.add("text-mode");
} else {
  $("note").textContent = "Speech recognition: Chrome and Edge send your voice to their own speech service while you hold the button.";
}

async function openMic() {
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    voice.unlock();
    micAnalyser = voice.ctx.createAnalyser();
    micAnalyser.fftSize = 1024;
    voice.ctx.createMediaStreamSource(micStream).connect(micAnalyser);
  } catch { /* the ring just won't pulse */ }
}

function press() {
  if (holding) return;
  holding = true;
  voice.unlock();
  if ($("sw-neural").checked && !voice.loading) void voice.loadKokoro();
  queue.interrupt(); // you talk, it shuts up
  generation?.abort();
  $("ptt").classList.add("down");
  recStart = performance.now();
  heard = ""; interim = "";
  refreshState();
  if (!SR) return;
  void openMic();
  rec = new SR();
  rec.lang = LANGS[lang].bcp;
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e) => {
    interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) heard += e.results[i][0].transcript + " ";
      else interim += e.results[i][0].transcript;
    }
    const live = (heard + interim).trim();
    if (live) { $("you").hidden = false; $("you").textContent = `“${live}”`; }
  };
  rec.onerror = (e) => { if (e.error === "not-allowed") show("I need the microphone for that. Or switch on typing in the menu.", "sys"); };
  const session = ++turnId;
  // if the recognizer stops while the button is still held, wait for the release
  rec.onend = () => { rec = null; if (!holding) finish(session); };
  try { rec.start(); } catch { /* already running */ }
}

let turnId = 0, answered = 0;
/** Send what was heard to the brain, once per hold, whichever comes first: onend or the timeout. */
function finish(session) {
  if (answered >= session) return;
  answered = session;
  const said = (heard + interim).trim();
  if (said) void handle(said);
  else show("I didn't catch that. Hold the button while you talk.", "sys");
}

function release() {
  if (!holding) return;
  holding = false;
  $("ptt").classList.remove("down");
  $("timer").textContent = "";
  refreshState();
  const session = turnId, r = rec;
  setTimeout(() => r?.stop(), 250); // don't clip the last word
  // some recognizers never fire onend after stop(): answer anyway
  setTimeout(() => { if (rec === r) { try { r?.abort(); } catch { /* gone */ } rec = null; } finish(session); }, 1500);
}

const ptt = $("ptt");
ptt.addEventListener("pointerdown", (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); press(); });
ptt.addEventListener("pointerup", release);
ptt.addEventListener("pointercancel", release);
ptt.addEventListener("contextmenu", (e) => e.preventDefault());
const typing = (el) => el instanceof HTMLElement && el.closest("input, textarea, select, [contenteditable]") !== null;
addEventListener("keydown", (e) => {
  if (e.code !== "Space" || typing(e.target)) return;
  e.preventDefault();
  if (!e.repeat) press();
});
addEventListener("keyup", (e) => { if (e.code === "Space" && !typing(e.target)) { e.preventDefault(); release(); } });
addEventListener("blur", release);

// ---------------------------------------------------------------- render loop
const buf = new Float32Array(1024);
let last = performance.now(), mic = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let m = 0;
  if (micAnalyser && holding) {
    micAnalyser.getFloatTimeDomainData(buf);
    let s = 0; for (const x of buf) s += x * x;
    m = Math.min(1, Math.sqrt(s / buf.length) * 5);
  }
  mic += (m - mic) * (m > mic ? 0.5 : 0.1);
  $("ring").style.setProperty("--mic", String(1 + mic * 0.25));
  face.draw(voice.level(), dt);
  if (holding) $("timer").textContent = `${((now - recStart) / 1000).toFixed(1)}s`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
refreshState();
// first visit: choose a brain (the AI is a big download, so ask)
if (!mode) { $("setup").hidden = false; $("gpu-note").textContent = hasGPU ? "Your browser supports WebGPU." : "This browser has no WebGPU, so only the joke engine can run here (try Chrome or Edge)."; if (!hasGPU) document.querySelectorAll("#setup [data-mode='smart'], #setup [data-mode='fast']").forEach((b) => (b.disabled = true)); }
else setMode(mode);
voice.onStatus();
window.vox = { brain, voice, queue, handle, face, llm };
