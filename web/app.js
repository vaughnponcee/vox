// vox-chaos: push-to-talk, speech recognition, the brain, the audio queue,
// voices, stings and the mascot, wired together.
import { Brain, detectLang } from "./brain.js";
import { Whisper, Recorder } from "./stt.js";
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
let lastSaid = "";
let langLock = null; // a language picked by hand; null = follow whatever you speak // the last thing the bot said, to spot it echoing back through the mic
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
  // a first reply can wait on the one-time voice download: say so instead of going quiet
  const voiceLoading = voice.piperProgress != null && voice.piperProgress < 1 && voice.piperOk !== true;
  $("status").textContent = s === "idle" && loadingText ? loadingText
    : (s === "thinking" || queue.busy) && voiceLoading ? `Loading the voice... ${Math.round(voice.piperProgress * 100)}%`
    : STATUS[s];
  face.listening = s === "listening";
  face.thinking = s === "thinking";
}

// ---------------------------------------------------------------- the card + history
function show(text, _kind, you = "") {
  if (_kind !== "sys") lastSaid = text;
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
function hush() { generation?.abort(); queue.interrupt(); voice.nativeLevel = 0; if ("speechSynthesis" in window) speechSynthesis.cancel(); }
// the X ends the chat: stop everything, then choose a voice for the next one
$("stop").onclick = () => { release(); hush(); thinking = false; brain.traps.active = null; openPicker(); };
$("menu").onclick = () => openSheet(!$("sheet").classList.contains("open"));
$("scrim").onclick = () => openSheet(false);
const nice = (s) => s.charAt(0) + s.slice(1).toLowerCase();

{
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = "Auto"; b.dataset.lang = "auto";
  b.setAttribute("aria-pressed", "true");
  b.onclick = () => { langLock = null; markLang(); show("Auto: speak any language and I'll answer in it.", "sys"); };
  $("langs").append(b);
}
function markLang() {
  document.querySelectorAll("#langs .chip").forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.lang === (langLock ?? "auto"))));
  $("lang-label").textContent = langLock ? nice(LANGS[lang].name) : `Auto: ${nice(LANGS[lang].name)}`;
}
for (const [code, l] of Object.entries(LANGS)) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = nice(l.name);
  b.setAttribute("aria-pressed", String(code === lang));
  b.dataset.lang = code;
  b.onclick = () => { langLock = code; setLang(code); show(`Now in ${b.textContent}. Go on, say something.`, "sys"); };
  $("langs").append(b);
}
/** Switch the reply language: captions, voice and the AI all follow. */
function setLang(code) {
  if (!LANGS[code]) return;
  lang = code;
  if (lang !== "en" && preset.engine === "kokoro") selectVoice(VOICES.find((v) => v.id === "polyglot") ?? VOICES[0]);
  markLang();
  voice.preload(preset, lang);
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

// ---------------------------------------------------------------- choose a voice
let pickIdx = 0, prevVoice = null;
const vname = (v) => v.label.replace(/\s*\(.*\)$/, "");
function renderPicker() {
  const n = VOICES.length, at = (d) => VOICES[(pickIdx + d + n) % n];
  const fill = (id, v) => { $(id).innerHTML = ""; $(id).append(vname(v)); const sm = document.createElement("small"); sm.textContent = v.desc ?? ""; $(id).append(sm); };
  $("pv-name").textContent = vname(at(0));
  $("pv-desc").textContent = at(0).desc ?? "";
  fill("pv-prev-name", at(-1)); fill("pv-next-name", at(1));
}
function stepPicker(d) {
  pickIdx = (pickIdx + d + VOICES.length) % VOICES.length;
  renderPicker();
  // hear it: a short line in the chosen voice
  hush();
  const v = VOICES[pickIdx];
  selectVoice(v); voice.unlock();
  if (v.engine === "kokoro") void voice.loadKokoro();
  speak(`Hi, I'm ${vname(v)}. Pick me.`, null);
}
function openPicker() {
  prevVoice = preset;
  pickIdx = Math.max(0, VOICES.indexOf(preset));
  renderPicker();
  document.body.classList.add("picking");
  refreshState();
}
function closePicker() { hush(); document.body.classList.remove("picking"); refreshState(); }
$("pv-prev").onclick = $("pv-prev-name").onclick = () => stepPicker(-1);
$("pv-next").onclick = $("pv-next-name").onclick = () => stepPicker(1);
$("pv-cancel").onclick = () => { selectVoice(prevVoice ?? preset); closePicker(); };
$("pv-start").onclick = () => {
  selectVoice(VOICES[pickIdx]);
  $("history").innerHTML = ""; turnsSinceTrap = 0; llm.forget();
  closePicker();
  show(`${vname(preset)} here. Hold the button and say something. I dare you.`, "sys");
};
addEventListener("keydown", (e) => {
  if (!document.body.classList.contains("picking")) return;
  if (e.key === "ArrowLeft") stepPicker(-1);
  else if (e.key === "ArrowRight") stepPicker(1);
  else if (e.key === "Enter") $("pv-start").click();
  else if (e.key === "Escape") $("pv-cancel").click();
});

$("pitch").oninput = (e) => { voice.pitch = +e.target.value; };
$("speed").oninput = (e) => { voice.speed = +e.target.value; };
$("sw-text").onchange = (e) => { document.body.classList.toggle("text-mode", e.target.checked); if (e.target.checked) { openSheet(false); $("text").focus(); } };
$("sw-traps").onchange = (e) => { trapsOn = e.target.checked; };
$("sw-llm").onchange = (e) => { brain.llmUrl = e.target.checked ? $("llm-url").value.trim() : null; };
$("llm-url").onchange = () => { if ($("sw-llm").checked) brain.llmUrl = $("llm-url").value.trim(); };
// ---------------------------------------------------------------- brain mode
function setMode(m) {
  mode = m;
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
  llm.load(mode).then(async () => {
    // the first generation compiles GPU shaders; do it now, not on your first question
    loadingText = "Warming up..."; refreshState();
    try { for await (const _ of llm.reply("hi", "en")) { /* discard */ } } catch { /* fine */ }
    llm.forget();
    loadingText = ""; refreshState(); renderBrainNote();
  }).catch((e) => {
    console.warn("LLM failed to load:", e);
    llm.failed = true;
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
  refreshState();
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
  if (sfx) face.punch(sfx === "crickets" ? "shocked" : "smug"); // a face, not a sound effect
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
    const m = final ? [buf, buf, ""] : /^([\s\S]*?(?:[.!?…]["')\]]*\s|[。！？]["'）」]*))([\s\S]*)$/.exec(buf)
      ?? (!said && /^(\S+(?:\s+\S+){5,}?[,;:]\s|[^，]{6,}，)([\s\S]*)$/.exec(buf));
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
  try {
    for await (const piece of llm.reply(text, lang, ctrl.signal)) {
      if (ctrl.signal.aborted) return;
      buf += piece;
      while (buf && (/[.!?…]["')\]]*\s|[。！？]/.test(buf) || (!said && /(\S+\s+){6}\S*[,;:]\s|[^，]{6,}，/.test(buf)))) { const before = buf; flush(false); if (buf === before) break; }
    }
    if (!ctrl.signal.aborted) flush(true);

  } catch (e) {
    console.warn("LLM reply failed:", e);
    thinking = false; refreshState();
    if (!ctrl.signal.aborted) show("My brain glitched on that one. Try again, or pick another brain in settings.", "sys", text);
    return;
  }
  thinking = false;
  if (said) {
    history(said, "vox", "AI");
    stat.layer = "on-device AI"; stat.ms = `${Math.round(first)} ms to first sentence`; renderStats();
  }
  refreshState();
}

/** True when the mic mostly picked up the bot itself. */
function isEcho(t) {
  const w = (x) => x.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const mine = w(t), bot = new Set(w(lastSaid));
  return mine.length > 2 && mine.filter((x) => bot.has(x)).length / mine.length > 0.7;
}
async function handle(text) {
  text = text.trim();
  if (!text) return;
  const heardLang = langLock ?? detectLang(text, lang);
  if (heardLang !== lang) setLang(heardLang);
  // the brain you picked is the brain that answers: no silent switching
  // while the AI is still downloading, the joke engine answers this turn only;
  // your choice stays, and the AI takes over the moment it is ready
  const smart = mode !== "lite" && llm.ready && !brain.traps.active;
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
  if (preset.engine === "kokoro" && !voice.loading) void voice.loadKokoro();
  queue.interrupt();
  void handle($("text").value);
  $("text").value = "";
};
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
$("send").onclick = send;

// ---------------------------------------------------------------- push to talk
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, heard = "", interim = "", recStart = 0, micStream = null, micAnalyser = null;
// Whisper hears any language without being told which; browser recognition is
// the fallback while it downloads (and it only hears the selected language)
const whisper = new Whisper();
let recorder = null, usingWhisper = false;
whisper.onStatus = () => {
  if (whisper.state === "loading" && !loadingText) $("note").textContent = `Downloading on-device speech recognition... ${Math.round(whisper.progress * 100)}%`;
  else if (whisper.state === "ready") $("note").textContent = "Speech recognition runs on your device (Whisper). Speak any language and it answers in that language.";
};

if (!SR && !window.AudioContext) {
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
    recorder = new Recorder(voice.ctx, micStream);
    whisper.load(hasGPU);
  } catch { /* the ring just won't pulse */ }
}

function press() {
  if (holding) return;
  holding = true;
  voice.unlock();
  if (preset.engine === "kokoro" && !voice.loading) void voice.loadKokoro();
  queue.interrupt(); // you talk, it shuts up
  generation?.abort();
  $("ptt").classList.add("down");
  recStart = performance.now();
  heard = ""; interim = "";
  refreshState();
  void openMic();
  usingWhisper = whisper.state === "ready" && !!recorder;
  if (usingWhisper) { recorder.start(); return; }
  if (!SR) return;
  rec = new SR();
  rec.lang = LANGS[lang].bcp;
  rec.interimResults = true;
  rec.continuous = true;
  const me = rec;
  rec.onresult = (e) => {
    if (rec !== me || answered >= turnId) return; // a stale recognizer hearing the bot's own voice
    interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) heard += e.results[i][0].transcript + " ";
      else interim += e.results[i][0].transcript;
    }
    const live = (heard + interim).trim();
    if (live && holding) { $("you").hidden = false; $("you").textContent = `“${live}”`; }
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
  if (said && !isEcho(said)) void handle(said);
  else show("I didn't catch that. Hold the button while you talk.", "sys");
}

function release() {
  if (!holding) return;
  holding = false;
  $("ptt").classList.remove("down");
  $("timer").textContent = "";
  refreshState();
  if (usingWhisper) {
    usingWhisper = false;
    const session = ++turnId;
    thinking = true; refreshState();
    // keep recording a moment so the last word isn't clipped
    setTimeout(async () => {
      let said = "";
      try {
        const audio = await recorder.stop();
        if (audio.length > 16000 * 0.3) said = await whisper.transcribe(audio, langLock);
      } catch (e) { console.warn("Whisper failed:", e); }
      thinking = false;
      if (session !== turnId) return;
      answered = session;
      // Whisper invents filler like "Thank you." on silence; ignore bracketed noise tags
      said = said.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();
      if (said && !isEcho(said)) void handle(said);
      else { refreshState(); show("I didn't catch that. Hold the button while you talk.", "sys"); }
    }, 200);
    return;
  }
  const session = turnId, r = rec;
  setTimeout(() => { try { r?.stop(); } catch { /* gone */ } }, 250); // don't clip the last word
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
  if (e.code !== "Space" || typing(e.target) || document.body.classList.contains("picking")) return;
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
// start the multilingual recognizer now so it is ready by your first sentence
whisper.load(hasGPU);
window.vox = { brain, voice, queue, handle, face, llm, whisper };
