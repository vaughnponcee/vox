// Dev tool: drives the app with REAL mouse input over the DevTools protocol (Edge on Windows)
// and traces the audio queue. Usage: node tools/repro.mjs <url>
// Drive the live app with REAL mouse input (user gestures) over CDP and trace audio.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = process.argv[2];
const exe = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const port = 9400 + Math.floor(Math.random() * 300);
const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "rp-"))}`, "--window-size=1280,900", "--autoplay-policy=user-gesture-required", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets; for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)); if (m.method === "Runtime.exceptionThrown") logs.push("EXC: " + m.params.exceptionDetails.exception?.description?.slice(0, 300)); };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const click = async (sel) => {
  const r = await ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r[0], y: r[1], button: "left", clickCount: 1 });
};
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(5000);
await click("#setup [data-mode=lite]");
await sleep(500);
await ev(`document.getElementById('sw-text').click()`);
await ev(`document.getElementById('text').value='my cat keeps knocking cups off the table'`);
await click("#send");
for (let t = 0; t < 30; t += 2) {
  await sleep(2000);
  const v = await ev(`[document.getElementById('line').textContent.slice(0,40), 'played=' + vox.queue.stats.played, 'busy=' + vox.queue.busy, 'playing=' + (vox.queue.playing ? vox.queue.playing.job.label.slice(0,25) : '-'), 'ctx=' + (vox.voice.ctx && vox.voice.ctx.state), 'piperOk=' + vox.voice.piperOk, 'prog=' + vox.voice.piperProgress, document.getElementById('stats').innerText].join(' ; ')`);
  logs.push("t" + t + " " + v);
}
console.log(logs.join("\n"));
ws.close(); proc.kill();
