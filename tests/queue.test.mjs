import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioQueue } from "../web/queue.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A fake sound: records start/end times and honours the abort signal. */
function sound(log, name, ms) {
  return {
    label: name,
    play: (_p, signal) => new Promise((resolve, reject) => {
      log.push(["start", name]);
      const t = setTimeout(() => { log.push(["end", name]); resolve(); }, ms);
      signal.addEventListener("abort", () => { clearTimeout(t); log.push(["cut", name]); reject(new Error("aborted")); });
    }),
  };
}

test("jobs never overlap and play in order", async () => {
  const log = [], q = new AudioQueue();
  const done = await Promise.all([q.push(sound(log, "a", 20)), q.push(sound(log, "b", 5)), q.push(sound(log, "c", 10))]);
  assert.deepEqual(done, ["played", "played", "played"]);
  assert.deepEqual(log, [["start", "a"], ["end", "a"], ["start", "b"], ["end", "b"], ["start", "c"], ["end", "c"]]);
  assert.equal(q.stats.maxConcurrent, 1);
});

test("synthesis of the next line runs while the current one plays", async () => {
  const log = [], q = new AudioQueue({ lookahead: 2 });
  const job = (name, prepMs, playMs) => ({
    label: name,
    prepare: async () => { log.push(["prep", name]); await sleep(prepMs); log.push(["ready", name]); return name; },
    play: async (p) => { log.push(["start", p]); await sleep(playMs); log.push(["end", p]); },
  });
  await Promise.all([q.push(job("a", 5, 40)), q.push(job("b", 10, 5))]);
  // b was prepared before a finished playing
  const readyB = log.findIndex((e) => e[0] === "ready" && e[1] === "b"), endA = log.findIndex((e) => e[0] === "end" && e[1] === "a");
  assert.ok(readyB < endA, JSON.stringify(log));
});

test("interrupt cuts the current sound and drops the rest", async () => {
  const log = [], q = new AudioQueue();
  const a = q.push(sound(log, "a", 200)), b = q.push(sound(log, "b", 10));
  await sleep(20);
  q.interrupt();
  assert.deepEqual(await Promise.all([a, b]), ["interrupted", "dropped"]);
  assert.ok(log.some((e) => e[0] === "cut" && e[1] === "a"));
  assert.ok(!log.some((e) => e[1] === "b"));
  // the queue keeps working afterwards
  assert.equal(await q.push(sound(log, "c", 5)), "played");
});

test("a failing synthesis is skipped without stalling the queue", async () => {
  const log = [], q = new AudioQueue();
  const bad = { label: "bad", prepare: async () => { throw new Error("tts down"); }, play: async () => log.push("never") };
  assert.deepEqual(await Promise.all([q.push(bad), q.push(sound(log, "next", 5))]), ["failed", "played"]);
  assert.ok(!log.includes("never"));
});

test("state callback reports playing and idle", async () => {
  const states = [], q = new AudioQueue({ onState: (s) => states.push(s.state) });
  await q.push(sound([], "a", 5));
  await sleep(1);
  assert.deepEqual(states, ["playing", "idle"]);
});

test("sentences split for streaming, across scripts", async () => {
  const { sentences } = await import("../web/queue.js");
  assert.deepEqual(sentences("Why did the banana go to the doctor? It was not peeling well."), ["Why did the banana go to the doctor?", "It was not peeling well."]);
  assert.deepEqual(sentences("你好。快说点好笑的，不然我来。"), ["你好。", "快说点好笑的，不然我来。"]);
  assert.deepEqual(sentences("No period here"), ["No period here"]);
  assert.deepEqual(sentences("Wait... what?! \"Fine.\" Ok"), ["Wait...", "what?!", "\"Fine.\"", "Ok"]);
});
