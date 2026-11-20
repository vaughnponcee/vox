// JS brain tests. The golden cases are shared with tests/test_brain.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BM25, Brain, Grammar, Markov, Reflector, TrapRunner, containsPhrase, ratio, rng, tokenize } from "../web/brain.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const DATA = load("../web/data/brain.json"), CORPUS = load("../web/data/corpus.json"), GOLDEN = load("./golden.json");

test("tokenize matches the Python tokenizer", () => {
  assert.deepEqual(tokenize("Why don't EGGS tell jokes?"), ["why", "don't", "eggs", "tell", "jokes"]);
  assert.deepEqual(tokenize("你好世界", "zh"), ["你好", "好世", "世界"]);
  assert.deepEqual(tokenize("¿Qué tal, señor?", "es"), ["¿qué", "tal", "señor"].map((w) => w.replace("¿", "")));
});

test("ratio equals difflib's SequenceMatcher ratio", () => {
  // reference values computed with Python's difflib
  assert.equal(ratio("soy una pappa", "soy una papa"), 0.96);
  assert.equal(ratio("abcd", "bcde"), 0.75);
  assert.equal(ratio("kitten", "sitting"), 2 * 4 / 13);
});

test("fuzzy phrase containment", () => {
  assert.ok(containsPhrase("um I guess milk?", ["milk"]));
  assert.ok(containsPhrase("soy una pappa", ["soy una papa"]));
  assert.ok(!containsPhrase("silky smooth", ["milk"]));
  assert.ok(containsPhrase("フライパンです", ["フライパン"]));
});

test("BM25 ranks and filters by language and kind", () => {
  const docs = [
    { kind: "joke", lang: "en", prompt: "why did the banana go to the doctor", tags: ["fruit"] },
    { kind: "joke", lang: "en", prompt: "what do you call a fake noodle", tags: ["pasta"] },
    { kind: "roast", lang: "en", prompt: "roast my banana bread", tags: [] },
    { kind: "joke", lang: "es", prompt: "banana banana banana", tags: [] },
  ];
  const ix = new BM25(docs);
  assert.equal(ix.search("banana doctor", "en")[0][1], 0);
  assert.deepEqual(ix.search("banana", "en", new Set(["roast"])).map((h) => h[1]), [2]);
  assert.ok(ix.idf("noodle") > ix.idf("banana"));
  assert.deepEqual(ix.search("zzz"), []);
});

test("golden subjects and reflections (shared with Python)", () => {
  const r = new Reflector(DATA);
  for (const c of GOLDEN.subject) assert.equal(r.subject(c.text, c.lang), c.want, c.text);
  for (const c of GOLDEN.reflect) assert.equal(r.reflect(c.text, c.lang), c.want, c.text);
});

test("golden trap paths (shared with Python)", () => {
  for (const c of GOLDEN.traps) {
    const t = new TrapRunner(DATA);
    assert.ok(t.start(c.lang, rng(0), c.id));
    let line, sfx;
    for (const reply of c.replies) { assert.ok(t.active, `${c.id}: ended early`); [line, sfx] = t.reply(reply); }
    assert.ok(line.includes(c.final), `${c.id}: ${line}`);
    assert.equal(sfx, c.sfx, c.id);
    assert.equal(t.active, null);
  }
});

test("golden retrieval (shared with Python)", () => {
  const b = new Brain(CORPUS, DATA, { seed: 1, trapEvery: 0 });
  for (const c of GOLDEN.retrieval) {
    const r = b.reply(c.text, c.lang);
    assert.equal(r.layer, "retrieval", c.text);
    assert.ok(r.text.includes(c.contains), `${c.text} -> ${r.text}`);
  }
});

test("grammar: same combinatorial size as Python, subject always present", () => {
  const g = new Grammar(DATA.grammar.en);
  assert.equal(g.count(), 20785647);
  const r = rng(4);
  for (let i = 0; i < 300; i++) {
    const s = g.expand("start", "your cat", r);
    assert.ok(!s.includes("<") && s.toLowerCase().includes("your cat"), s);
  }
});

test("markov never copies a training line", () => {
  const lines = ["the cat sat on the mat today", "the cat sat on the hat today", "a dog sat on the mat again", "the cat sat on a log yesterday", "a dog sat on the hat tonight"];
  const m = new Markov(lines), r = rng(2);
  const made = Array.from({ length: 50 }, () => m.generate(r)).filter(Boolean);
  assert.ok(made.length);
  for (const s of made) assert.ok(!lines.some((l) => l.includes(s)), s);
});

test("router: traps take over, intents route, replies p95 under 5 ms", () => {
  const b = new Brain(CORPUS, DATA, { seed: 3, trapEvery: 0 });
  assert.equal(b.reply("roast me").sfx, "boom");
  assert.equal(b.reply("play a game").layer, "trap");
  for (let i = 0; i < 6 && b.traps.active; i++) assert.equal(b.reply("hmm").layer, "trap");
  assert.equal(b.traps.active, null);
  const lines = Array(30).fill(["my cat is lazy", "roast me", "hello", "why is my pizza cold", "I like trains", "tell me a riddle"]).flat();
  const ms = lines.map((l) => b.reply(l).ms).sort((x, y) => x - y);
  assert.ok(ms[Math.floor(ms.length * 0.95)] < 5, `p95 ${ms[Math.floor(ms.length * 0.95)]} ms`);
});

test("optional LLM: falls back to the hybrid brain when the server is down", async () => {
  const b = new Brain(CORPUS, DATA, { seed: 1, trapEvery: 0, llmUrl: "http://127.0.0.1:9/v1" });
  const r = await b.replyAsync("my grandma drives a forklift");
  assert.notEqual(r.layer, "llm");
});

test("detectLang: scripts are decisive, Latin languages by function words", async () => {
  const { detectLang } = await import("../web/brain.js");
  const cases = [
    ["我喜欢的类型是带芯片的美国人工智能", "zh"], ["你好", "zh"], ["こんにちは、元気ですか", "ja"], ["สวัสดีครับ คุณชื่ออะไร", "th"],
    ["नमस्ते, आप कैसे हैं", "hi"], ["what is your type baby", "en"], ["¿qué tal? me llamo Ana y no sé", "es"],
    ["je ne sais pas, c'est très bizarre", "fr"], ["ciao, come stai? io sono molto stanco", "it"], ["olá, eu não sei o que você quer", "pt"],
  ];
  for (const [text, want] of cases) assert.equal(detectLang(text, "en"), want, text);
  // no evidence: keep the current language
  assert.equal(detectLang("ok", "es"), "es");
  assert.equal(detectLang("pizza", "fr"), "fr");
});
