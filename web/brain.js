// Zero-LLM conversational brain, browser edition. A direct port of brain/core.py:
// same four layers, same data file (data/brain.json), and tests/golden.json is run
// against both implementations so they can't drift apart.
//
//   1. TrapRunner  multi-turn bait-and-switch state machine
//   2. BM25        lexical retrieval over the corpus
//   3. Reflector   subject extraction + pronoun flipping
//   4. Grammar + Markov  CFG templates and a 3rd-order word chain

const CJK_LANGS = new Set(["zh", "ja", "th"]);
const CJK_RE = /[぀-ヿ一-鿿฀-๿]/;
const NOSPACE_RE = /[぀-ヿ一-鿿฀-๿ऀ-ॿ]/;
const WORD = "[\\p{L}\\p{N}\\p{M}_']";

export function norm(text) {
  return text.normalize("NFKC").toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
}

export function tokenize(text, lang = "en") {
  const t = norm(text);
  if (CJK_LANGS.has(lang) || CJK_RE.test(t)) {
    const chars = [...t].filter((c) => /[\p{L}\p{N}]/u.test(c));
    const out = [];
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
    return out.length ? out : chars;
  }
  return t.match(new RegExp(WORD + "+", "gu")) ?? [];
}

/** difflib.SequenceMatcher(None, a, b).ratio(): Ratcliff/Obershelp, no autojunk for short strings. */
export function ratio(a, b) {
  const A = [...a], B = [...b];
  if (!A.length && !B.length) return 1;
  const matches = (alo, ahi, blo, bhi) => {
    let best = 0, bi = alo, bj = blo;
    let prev = new Map();
    for (let i = alo; i < ahi; i++) {
      const cur = new Map();
      for (let j = blo; j < bhi; j++) {
        if (A[i] !== B[j]) continue;
        const k = (prev.get(j - 1) ?? 0) + 1;
        cur.set(j, k);
        if (k > best) { best = k; bi = i - k + 1; bj = j - k + 1; }
      }
      prev = cur;
    }
    if (!best) return 0;
    return best + matches(alo, bi, blo, bj) + matches(bi + best, ahi, bj + best, bhi);
  };
  return (2 * matches(0, A.length, 0, B.length)) / (A.length + B.length);
}

const normCache = new Map();
export function containsPhrase(text, phrases, threshold = 0.82) {
  const t = norm(text), tw = t.split(" ");
  for (const raw of phrases) {
    let p = normCache.get(raw);
    if (p === undefined) { p = norm(raw); normCache.set(raw, p); }
    if (!p) continue;
    if (NOSPACE_RE.test(p)) { if (t.includes(p)) return true; continue; }
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<!${WORD})${esc}(?!${WORD})`, "u").test(t)) return true;
    if (p.length < 4) continue;
    const n = p.split(" ").length;
    for (let i = 0; i < Math.max(1, tw.length - n + 1); i++) {
      const w = tw.slice(i, i + n).join(" ");
      if (Math.abs(w.length - p.length) > p.length * (1 - threshold) * 2 || (w[0] !== p[0] && w.at(-1) !== p.at(-1))) continue;
      if (ratio(w, p) >= threshold) return true;
    }
  }
  return false;
}

/** Seeded PRNG so a session can be replayed. */
export function rng(seed = Date.now()) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.choice = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}

// ---------------------------------------------------------------- layer 2: BM25
export class BM25 {
  constructor(docs, k1 = 1.5, b = 0.75) {
    Object.assign(this, { docs, k1, b });
    this.tf = []; this.len = []; this.df = new Map(); this.postings = new Map();
    docs.forEach((d, i) => {
      const toks = tokenize(d.prompt + " " + (d.tags ?? []).join(" "), d.lang);
      const c = new Map();
      for (const t of toks) c.set(t, (c.get(t) ?? 0) + 1);
      this.tf.push(c); this.len.push(toks.length);
      for (const t of c.keys()) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
        if (!this.postings.has(t)) this.postings.set(t, []);
        this.postings.get(t).push(i);
      }
    });
    this.n = docs.length;
    this.avg = this.n ? this.len.reduce((a, b) => a + b, 0) / this.n : 1;
  }
  idf(term) { const n = this.df.get(term) ?? 0; return Math.log(1 + (this.n - n + 0.5) / (n + 0.5)); }
  search(query, lang = "en", kinds = null, k = 5) {
    const scores = new Map();
    for (const term of new Set(tokenize(query, lang))) {
      const idf = this.idf(term);
      for (const i of this.postings.get(term) ?? []) {
        const d = this.docs[i];
        if (d.lang !== lang || (kinds && !kinds.has(d.kind))) continue;
        const f = this.tf[i].get(term);
        scores.set(i, (scores.get(i) ?? 0) + idf * f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avg)));
      }
    }
    return [...scores].map(([i, s]) => [s, i]).sort((x, y) => y[0] - x[0] || y[1] - x[1]).slice(0, k);
  }
}

// ---------------------------------------------------------------- layer 3: reflection
export class Reflector {
  constructor(data) {
    this.stop = Object.fromEntries(Object.entries(data.stopwords).map(([k, v]) => [k, new Set(v)]));
    this.verbs = Object.fromEntries(Object.entries(data.verbs ?? {}).map(([k, v]) => [k, new Set(v)]));
    this.flip = data.reflect;
  }
  reflect(text, lang = "en") {
    const table = this.flip[lang];
    if (!table) return text.trim();
    if (lang === "zh") {
      const keys = Object.keys(table).sort((a, b) => b.length - a.length);
      return text.trim().replace(new RegExp(keys.join("|"), "g"), (m) => table[m]);
    }
    const words = text.trim().match(new RegExp(`${WORD}+|[^\\p{L}\\p{N}\\p{M}_'\\s]`, "gu")) ?? [];
    return words.map((w) => table[w.toLowerCase()] ?? w).join(" ").replace(/\s+([?.!,])/g, "$1");
  }
  subject(text, lang = "en") {
    if (CJK_LANGS.has(lang)) {
      let chars = norm(text).replace(/[\s\p{P}\p{S}]/gu, "");
      if (lang === "zh") chars = this.reflect(chars, "zh");
      for (const q of ["吗", "呢", "吧", "啊", "か", "ね", "よ", "ไหม", "ครับ", "ค่ะ"]) while (chars.endsWith(q)) chars = chars.slice(0, -q.length);
      return [...chars].slice(-6).join("") || null;
    }
    const stop = this.stop[lang] ?? new Set(), verbs = this.verbs[lang] ?? new Set(), flip = this.flip[lang] ?? {};
    const words = norm(text).match(new RegExp(WORD + "+", "gu")) ?? [];
    if (!words.length) return null;
    const runAfter = (i) => {
      const run = [];
      for (const w of words.slice(i + 1, i + 4)) { if (stop.has(w) || verbs.has(w) || run.length === 2) break; run.push(w); }
      return run;
    };
    for (let i = 0; i < words.length; i++) {
      if (["my", "your", "our"].includes(words[i])) { const run = runAfter(i); if (run.length) return (flip[words[i]] ?? words[i]) + " " + run.join(" "); }
    }
    for (let i = words.length - 1; i >= 0; i--) {
      if (["the", "about", "of", "a", "an", "his", "her", "their"].includes(words[i])) { const run = runAfter(i); if (run.length) return run.join(" "); }
    }
    const run = [];
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (stop.has(w) || verbs.has(w) || [...w].length < 2) { if (run.length) break; continue; }
      run.unshift(w);
      if (run.length === 2) break;
    }
    return run.join(" ") || null;
  }
}

// ---------------------------------------------------------------- layer 4: CFG + Markov
export class Grammar {
  constructor(rules) { this.rules = rules; }
  expand(symbol, subj, r, depth = 0) {
    if (depth > 8) return "";
    return r.choice(this.rules[symbol]).replace(/<(\w+)>/g, (_, name) =>
      name === "subj" ? subj : name === "subj_cap" ? subj.charAt(0).toUpperCase() + subj.slice(1) : this.expand(name, subj, r, depth + 1));
  }
  count(symbol = "start", depth = 0) {
    if (depth > 8) return 1;
    let total = 0;
    for (const opt of this.rules[symbol]) {
      let n = 1;
      for (const [, name] of opt.matchAll(/<(\w+)>/g)) if (name !== "subj" && name !== "subj_cap") n *= this.count(name, depth + 1);
      total += n;
    }
    return total;
  }
}

export class Markov {
  constructor(sentences, order = 3) {
    this.order = order; this.table = new Map(); this.starts = [];
    this.blob = sentences.map(norm).join("\n");
    for (const s of sentences) {
      const w = s.split(" ");
      if (w.length <= order) continue;
      this.starts.push(w.slice(0, order));
      for (let i = 0; i + order < w.length; i++) {
        const key = w.slice(i, i + order).join(" ");
        if (!this.table.has(key)) this.table.set(key, []);
        this.table.get(key).push(w[i + order]);
      }
    }
  }
  generate(r, maxWords = 24, tries = 20) {
    if (!this.starts.length) return null;
    for (let t = 0; t < tries; t++) {
      const out = [...r.choice(this.starts)];
      while (out.length < maxWords) {
        const nxt = this.table.get(out.slice(-this.order).join(" "));
        if (!nxt) break;
        out.push(r.choice(nxt));
        if (/[.!?]$/.test(out.at(-1))) break;
      }
      const s = out.join(" ");
      if (out.length > this.order + 1 && !this.blob.includes(norm(s))) return s;
    }
    return null;
  }
}

// ---------------------------------------------------------------- layer 1: traps
export class TrapRunner {
  constructor(data) { this.traps = data.traps; this.yes = data.yes; this.no = data.no; this.active = null; this.step = 0; this.played = new Set(); }
  classify(text, lang) {
    if (containsPhrase(text, [...(this.no[lang] ?? []), ...this.no.en], 0.9)) return "no";
    if (containsPhrase(text, [...(this.yes[lang] ?? []), ...this.yes.en], 0.9)) return "yes";
    return "other";
  }
  start(lang, r, trapId = null) {
    let pool = trapId ? this.traps.filter((t) => t.id === trapId) : this.traps.filter((t) => t.lang === lang && !this.played.has(t.id));
    if (!trapId && !pool.length) {
      for (const t of this.traps) if (t.lang === lang) this.played.delete(t.id);
      pool = this.traps.filter((t) => t.lang === lang);
    }
    if (!pool.length) return null;
    this.active = r.choice(pool);
    this.played.add(this.active.id);
    this.step = 0;
    return this.active.steps[0].say;
  }
  reply(text) {
    const t = this.active, cur = t.steps[this.step];
    if (cur.branch) {
      const kind = this.classify(text, t.lang);
      this.active = null;
      return [cur.branch[kind], kind === "yes" ? t.sfx : kind === "other" ? "crickets" : null];
    }
    if (cur.answer) {
      const a = cur.answer;
      if (containsPhrase(text, a.match)) { this.active = null; return [a.hit, a.hitSfx ?? t.sfx]; }
      if (a.miss != null) { this.active = null; return [a.miss, a.missSfx ?? null]; }
    }
    this.step++;
    if (this.step >= t.steps.length) { this.active = null; return ["Fine. You survived. This time.", "crickets"]; }
    return [t.steps[this.step].say, null];
  }
}

// ---------------------------------------------------------------- the router
export class Brain {
  /** corpus: {fields, rows}; data: brain.json; opts: {seed, trapEvery, llmUrl} */
  constructor(corpus, data, { seed, trapEvery = 4, llmUrl = null } = {}) {
    this.data = data;
    this.docs = corpus.rows.map((row) => Object.fromEntries(corpus.fields.map((f, i) => [f, row[i]])));
    this.bm25 = new BM25(this.docs);
    this.reflector = new Reflector(data);
    this.grammar = new Grammar(data.grammar.en);
    this.markov = new Markov(this.docs.filter((d) => d.lang === "en").map((d) => d.response));
    this.traps = new TrapRunner(data);
    this.rng = rng(seed ?? Date.now());
    this.trapEvery = trapEvery;
    this.llmUrl = llmUrl;
    this.turns = 0;
    this.history = [];
  }

  intent(text, lang) {
    for (const [name, byLang] of Object.entries(this.data.intents))
      if (containsPhrase(text, [...(byLang[lang] ?? []), ...(lang !== "en" ? byLang.en : [])], 0.88)) return name;
    return null;
  }

  pick(kind, lang, topic) {
    if (topic) {
      const hits = this.bm25.search(topic, lang, new Set([kind]), 8);
      if (hits.length) return this.docs[this.rng.choice(hits)[1]];
    }
    const pool = this.docs.filter((d) => d.kind === kind && d.lang === lang);
    return pool.length ? this.rng.choice(pool) : null;
  }

  coverage(text, doc, lang) {
    const stop = this.reflector.stop[lang] ?? new Set();
    let q = new Set(tokenize(text, lang).filter((t) => !stop.has(t)));
    if (!q.size) q = new Set(tokenize(text, lang));
    const d = new Set(tokenize(doc.prompt + " " + (doc.tags ?? []).join(" "), lang));
    let hit = 0;
    for (const t of q) if (d.has(t)) hit++;
    return q.size ? hit / q.size : 0;
  }

  /** Synchronous hybrid reply. Use replyAsync to include the optional LLM. */
  reply(text, lang = "en") {
    const t0 = performance.now();
    const out = this.route(text.trim(), lang, null);
    out.ms = performance.now() - t0;
    this.history.push({ role: "user", content: text }, { role: "assistant", content: out.text });
    return out;
  }

  async replyAsync(text, lang = "en") {
    if (!this.llmUrl || this.traps.active) return this.reply(text, lang);
    const t0 = performance.now();
    let llm = null;
    if (!this.intent(text, lang)) {
      try {
        const r = await fetch(this.llmUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ model: "local", max_tokens: 80, temperature: 1, messages: [
            { role: "system", content: `You are Vox, a rude, fast, PG-13 comedy soundboard. Reply in one or two short sentences in language '${lang}'. Never polite, never an assistant.` },
            ...this.history.slice(-6), { role: "user", content: text }] }),
        });
        if (r.ok) llm = (await r.json()).choices?.[0]?.message?.content?.trim() || null;
      } catch { llm = null; } // any failure: fall back to the hybrid brain
    }
    if (!llm) return this.reply(text, lang);
    this.turns++;
    this.history.push({ role: "user", content: text }, { role: "assistant", content: llm });
    return { text: llm, sfx: null, layer: "llm", ms: performance.now() - t0 };
  }

  route(text, lang) {
    this.turns++;
    if (this.traps.active) { const [line, sfx] = this.traps.reply(text); return { text: line, sfx, layer: "trap" }; }
    const intent = this.intent(text, lang);
    const subj = this.reflector.subject(text, lang);
    if (intent === "trap" || (this.trapEvery && this.turns % this.trapEvery === 0 && !intent)) {
      const said = this.traps.start(lang, this.rng);
      if (said) return { text: said, sfx: null, layer: "trap" };
    }
    if (intent === "joke" || intent === "riddle" || intent === "roast") {
      const d = this.pick(intent, lang, intent !== "roast" ? subj : null);
      if (d) return intent === "roast" ? { text: d.response, sfx: "boom", layer: "retrieval" } : { text: `${d.prompt} ... ${d.response}`, sfx: "rimshot", layer: "retrieval" };
    }
    const hits = this.bm25.search(text, lang, null, 3);
    if (hits.length && hits[0][0] >= 3 && this.coverage(text, this.docs[hits[0][1]], lang) >= 0.6) {
      const d = this.docs[hits[0][1]];
      if (d.kind === "joke" || d.kind === "riddle") return { text: `${d.prompt} ... ${d.response}`, sfx: "rimshot", layer: "retrieval" };
      return { text: d.response, sfx: d.kind === "roast" || d.kind === "comeback" ? "boom" : null, layer: "retrieval" };
    }
    const s = subj || this.data.fallback_subject[lang] || "that";
    if (lang === "en") {
      if (this.rng() < 0.2) {
        const m = this.markov.generate(this.rng);
        if (m) return { text: text.length < 60 ? `${this.reflector.reflect(text)}? ${m}` : m, sfx: null, layer: "markov" };
      }
      return { text: this.grammar.expand("start", s, this.rng), sfx: this.rng() < 0.3 ? "boom" : null, layer: "grammar" };
    }
    const options = this.data.grammar.other[lang] ?? this.data.grammar.other.es;
    return { text: this.rng.choice(options).replace("{subj}", s), sfx: null, layer: "grammar" };
  }
}
