// VOX-CHAOS front panel: wires push-to-talk, speech recognition, the brain,
// the audio queue, voices, stings, meters and the face together.
import { Brain } from "./brain.js";
import { AudioQueue, sentences } from "./queue.js";
import { Voice, VOICES, LANGS } from "./voice.js";
import { Face } from "./face.js";

const $ = (id) => document.getElementById(id);
const [corpus, data] = await Promise.all([
  fetch("data/corpus.json").then((r) => r.json()),
  fetch("data/brain.json").then((r) => r.json()),
]);

const brain = new Brain(corpus, data, { trapEvery: 4 });
const voice = new Voice();
const face = new Face($("face"));
const queue = new AudioQueue({ lookahead: 1, onState: () => {} });
let lang = "en", preset = VOICES[0];

// ---------------------------------------------------------------- transcript
function log(text, cls, tag = "") {
  const lcd = $("lcd"), p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  if (tag) { const t = document.createElement("span"); t.className = "tag"; t.textContent = tag; p.append(t); }
  lcd.append(p);
  while (lcd.children.length > 14) lcd.firstChild.remove();
}

// ---------------------------------------------------------------- language + voice keys
for (const [code, l] of Object.entries(LANGS)) {
  const b = document.createElement("button");
  b.className = "key"; b.textContent = code.toUpperCase(); b.title = l.name;
  b.setAttribute("aria-pressed", String(code === lang));
  b.onclick = () => {
    lang = code;
    document.querySelectorAll("#langs .key").forEach((k) => k.setAttribute("aria-pressed", String(k === b)));
    $("lang-read").textContent = l.name;
    if (lang !== "en" && preset.engine === "kokoro") selectVoice(VOICES.find((v) => v.id === "polyglot"));
    log(`language: ${l.name}`, "sys");
  };
  $("langs").append(b);
}
function selectVoice(v) {
  preset = v;
  document.querySelectorAll("#voices .key").forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.id === v.id)));
  $("voice-note").textContent = v.engine === "kokoro" ? "KOKORO-82M" : "NATIVE SPEECH";
}
for (const v of VOICES) {
  const b = document.createElement("button");
  b.className = "key"; b.textContent = v.label; b.dataset.id = v.id;
  b.onclick = () => { selectVoice(v); if (v.engine === "kokoro" && lang !== "en") log("kokoro voices speak English; other languages use the native voice", "sys"); };
  $("voices").append(b);
}
selectVoice(preset);

// ---------------------------------------------------------------- processor + switches
$("pitch").oninput = (e) => { voice.pitch = +e.target.value; $("pitch-v").textContent = `${voice.pitch > 0 ? "+" : ""}${voice.pitch} st`; };
$("speed").oninput = (e) => { voice.speed = +e.target.value; $("speed-v").textContent = `${voice.speed.toFixed(2)}x`; };
$("sw-text").onchange = (e) => { document.body.classList.toggle("text-mode", e.target.checked); if (e.target.checked) $("text").focus(); };
$("sw-traps").onchange = (e) => { brain.trapEvery = e.target.checked ? 4 : 0; };
$("sw-llm").onchange = (e) => { brain.llmUrl = e.target.checked ? $("llm-url").value.trim() : null; $("r-brain").textContent = e.target.checked ? "LLM+HYBRID" : "HYBRID"; };
$("llm-url").onchange = () => { if ($("sw-llm").checked) brain.llmUrl = $("llm-url").value.trim(); };
$("sw-neural").onchange = (e) => {
  if (e.target.checked) { voice.unlock(); void voice.loadKokoro(); if (voice.tooSlow) { voice.forceNeural(); log("neural voice forced on: expect pauses", "sys"); } }
  else { voice.tooSlow = true; voice.onStatus(); }
};
document.querySelectorAll("[data-sting]").forEach((b) => (b.onclick = () => { voice.unlock(); queue.push({ label: b.dataset.sting, play: (_p, s) => { face.punch(); return voice.sting(b.dataset.sting, s); } }); }));

voice.onStatus = () => {
  const s = voice.status, led = $("led-engine");
  $("r-engine").textContent = s === "loading" ? `LOADING ${Math.round(voice.progress * 100)}%` : s === "failed" ? "NATIVE (NO WASM)"
    : voice.tooSlow && s.startsWith("kokoro") ? "NATIVE (CPU TOO SLOW)" : s.toUpperCase();
  if (voice.tooSlow && s.startsWith("kokoro") && !voice.warned && $("sw-neural").checked) {
    voice.warned = true;
    log(`neural voice runs ${voice.rtf.toFixed(1)}x slower than real time here (${s === "kokoro-webgpu" ? "WebGPU" : "CPU / WASM"}). Switched to the native voice. Toggle NEURAL VOICE off and on to force it.`, "sys");
  }
  led.className = "led " + (s.startsWith("kokoro") ? "ok" : s === "loading" ? "amb" : "");
  if ((s === "kokoro-webgpu" || s === "kokoro-wasm") && !voice.announced) {
    voice.announced = true;
    log(`neural voice ready (${s === "kokoro-webgpu" ? "WebGPU" : "WASM"})`, "sys");
  }
};

// ---------------------------------------------------------------- speaking
function speak(text, sfx) {
  const p = preset, l = lang;
  for (const part of sentences(text)) {
    queue.push({
      label: part,
      prepare: () => voice.prepare(part, p, l),
      play: (prep, signal) => {
        $("r-tts").textContent = prep.kind === "kokoro" ? `${Math.round(prep.synthMs)} MS` : "NATIVE";
        return voice.play(prep, signal);
      },
    });
  }
  if (sfx) queue.push({ label: sfx, play: (_p, s) => { face.punch(sfx === "crickets" ? "shocked" : "smug"); return voice.sting(sfx, s); } });
}

async function handle(text) {
  text = text.trim();
  if (!text) return;
  log(text, "you");
  const r = await brain.replyAsync(text, lang);
  log(r.text, "vox", r.layer.toUpperCase());
  $("r-layer").textContent = r.layer.toUpperCase();
  $("r-ms").textContent = `${r.ms.toFixed(1)} MS`;
  speak(r.text, r.sfx);
}

$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { voice.unlock(); if (!voice.loading && $("sw-neural").checked) void voice.loadKokoro(); queue.interrupt(); void handle(e.target.value); e.target.value = ""; }
});

// ---------------------------------------------------------------- push to talk
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, heard = "", interim = "", recStart = 0, holding = false, micStream = null, micAnalyser = null;

if (!SR) {
  $("note").innerHTML = '<span class="note">This browser has no speech recognition (try Chrome or Edge). Text input is on.</span>';
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
  } catch { log("no microphone access: the meter stays flat, recognition may still work", "sys"); }
}

async function press() {
  if (holding) return;
  holding = true;
  voice.unlock();
  if ($("sw-neural").checked && !voice.loading) void voice.loadKokoro();
  queue.interrupt(); // you talk, it shuts up
  face.listening = true;
  $("ptt").classList.add("down");
  $("rec-state").textContent = "RECORDING";
  recStart = performance.now();
  heard = ""; interim = "";
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
    $("rec-state").textContent = (heard + interim).slice(-28).toUpperCase() || "RECORDING";
  };
  rec.onerror = (e) => { if (e.error !== "aborted" && e.error !== "no-speech") log(`recognizer: ${e.error}`, "sys"); };
  rec.onend = () => {
    rec = null;
    const said = (heard + interim).trim();
    $("rec-state").textContent = "STANDBY / SPACE";
    if (said) void handle(said);
    else if (!holding) log("(heard nothing)", "sys");
  };
  try { rec.start(); } catch { /* already started */ }
}

function release() {
  if (!holding) return;
  holding = false;
  face.listening = false;
  $("ptt").classList.remove("down");
  // keep listening a moment so the last word isn't clipped
  setTimeout(() => rec?.stop(), 250);
}

const ptt = $("ptt");
ptt.addEventListener("pointerdown", (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); void press(); });
ptt.addEventListener("pointerup", release);
ptt.addEventListener("pointercancel", release);
ptt.addEventListener("contextmenu", (e) => e.preventDefault());
const typing = (el) => el instanceof HTMLElement && (el.closest("input, textarea, select, [contenteditable]") !== null);
addEventListener("keydown", (e) => {
  if (e.code !== "Space" || typing(e.target)) return;
  e.preventDefault();
  if (!e.repeat) void press(); // key repeat would retrigger press: ignore it
});
addEventListener("keyup", (e) => { if (e.code === "Space" && !typing(e.target)) { e.preventDefault(); release(); } });
addEventListener("blur", release);

// ---------------------------------------------------------------- meters + face
function needle(canvas, level, label) {
  const g = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
  g.fillStyle = "#f3ead0"; g.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h * 1.05, r = h * 0.85;
  g.strokeStyle = "#1c1b18"; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, r, Math.PI * 1.22, Math.PI * 1.78); g.stroke();
  // red zone above 0 dB
  g.strokeStyle = "#d23b2b"; g.lineWidth = 6;
  g.beginPath(); g.arc(cx, cy, r - 4, Math.PI * 1.66, Math.PI * 1.78); g.stroke();
  g.fillStyle = "#1c1b18"; g.font = "bold 20px Consolas, monospace"; g.textAlign = "center";
  [-20, -10, -5, 0, 3].forEach((db, i) => {
    const a = Math.PI * (1.22 + 0.56 * (i / 4));
    g.fillText(String(db), cx + Math.cos(a) * (r + 18), cy + Math.sin(a) * (r + 18) + 6);
  });
  g.font = "bold 22px Consolas, monospace";
  g.fillText(label, cx, h * 0.62);
  const a = Math.PI * (1.22 + 0.56 * Math.min(1, level));
  g.strokeStyle = "#1c1b18"; g.lineWidth = 3;
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6)); g.stroke();
}

let inLvl = 0, outLvl = 0, last = performance.now();
const buf = new Float32Array(1024);
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let mic = 0;
  if (micAnalyser && holding) {
    micAnalyser.getFloatTimeDomainData(buf);
    let s = 0; for (const x of buf) s += x * x;
    mic = Math.min(1, Math.sqrt(s / buf.length) * 5);
  }
  const out = voice.level();
  // ballistics: fast attack, slow fall, like a real needle
  inLvl += (mic - inLvl) * (mic > inLvl ? 0.5 : 0.08);
  outLvl += (out - outLvl) * (out > outLvl ? 0.5 : 0.08);
  needle($("vu-in"), inLvl, "IN");
  needle($("vu-out"), outLvl, "OUT");
  $("mouth").textContent = "M" + face.draw(out, dt);
  if (holding) $("timer").textContent = ((now - recStart) / 1000).toFixed(1);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

log("VP-82 ready. Hold the red button or Space and talk. Say \"play a game\" if you dare.", "sys");
(window).vox = { brain, voice, queue, handle };
