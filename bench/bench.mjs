// Brain latency in Node (same engine as the browser): node bench/bench.mjs
import { readFileSync } from "node:fs";
import { Brain } from "../web/brain.js";
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const t0 = performance.now();
const b = new Brain(load("../web/data/corpus.json"), load("../web/data/brain.json"), { seed: 1, trapEvery: 4 });
const loadMs = performance.now() - t0;
const LINES = ["my cat keeps knocking cups off the table", "roast me", "hello", "why is my pizza cold", "I like trains",
  "tell me a riddle", "what is the meaning of life", "my boss thinks I'm lazy", "I hate you", "pizza with pineapple"];
for (const l of LINES) b.reply(l);
const ms = Array.from({ length: 2000 }, (_, i) => b.reply(LINES[i % LINES.length]).ms).sort((x, y) => x - y);
const q = (p) => ms[Math.floor(ms.length * p)];
let t = performance.now();
for (let i = 0; i < 1000; i++) b.bm25.search(LINES[i % LINES.length], "en");
const bm = (performance.now() - t) / 1000;
console.log(JSON.stringify({ reply_p50_ms: +q(0.5).toFixed(3), reply_p95_ms: +q(0.95).toFixed(3), reply_p99_ms: +q(0.99).toFixed(3), bm25_search_ms: +bm.toFixed(3), brain_load_ms: +loadMs.toFixed(1) }, null, 1));
