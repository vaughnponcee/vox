"""Zero-LLM conversational brain: four layers, checked in order on every turn.

1. TrapRunner   multi-turn bait-and-switch state machine (fuzzy intent matching)
2. BM25         lexical retrieval over the scraped corpus (prompts + tags)
3. Reflector    pulls the subject out of what you said and flips pronouns
4. Grammar + Markov  CFG templates and a 3rd-order word chain generate fresh lines

Optional: an OpenAI-compatible local LLM endpoint replaces layers 2-4 when
enabled, with the hybrid brain as an automatic fallback on any error.

web/brain.js is a line-for-line port of this file; tests/golden.json is run by
both test suites so the two never drift apart.
"""
from __future__ import annotations

import json
import math
import random
import re
import time
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
CJK_LANGS = {"zh", "ja", "th"}


# ---------------------------------------------------------------- text

def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("’", "'")
    return re.sub(r"\s+", " ", text).strip()


def tokenize(text: str, lang: str = "en") -> list[str]:
    """Words for spaced languages; character bigrams for zh/ja/th (no spaces)."""
    t = norm(text)
    if lang in CJK_LANGS or re.search(r"[぀-ヿ一-鿿฀-๿]", t):
        chars = [c for c in t if c.isalnum()]
        return [chars[i] + chars[i + 1] for i in range(len(chars) - 1)] or chars
    return re.findall(r"[\w']+", t)


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, norm(a), norm(b)).ratio()


_NORM_CACHE: dict[str, str] = {}


def contains_phrase(text: str, phrases: list[str], threshold: float = 0.82) -> bool:
    """Fuzzy containment: exact substring, or a window of the same word length that is close enough."""
    t = norm(text)
    tw = t.split()
    for p in phrases:
        p = _NORM_CACHE.get(p) or _NORM_CACHE.setdefault(p, norm(p))
        if not p:
            continue
        if re.search(r"[぀-ヿ一-鿿฀-๿ऀ-ॿ]", p):
            if p in t:  # no word boundaries in these scripts
                return True
            continue
        if re.search(rf"(?<![\w']){re.escape(p)}(?![\w'])", t):
            return True
        if len(p) < 4:
            continue
        n = len(p.split())
        for i in range(max(1, len(tw) - n + 1)):
            w = " ".join(tw[i:i + n])
            # ratio can't reach the threshold when lengths differ too much: skip the slow compare
            if abs(len(w) - len(p)) > len(p) * (1 - threshold) * 2 or w[:1] != p[:1] and w[-1:] != p[-1:]:
                continue
            if SequenceMatcher(None, w, p).ratio() >= threshold:
                return True
    return False


# ---------------------------------------------------------------- layer 2: BM25

class BM25:
    """Okapi BM25 (k1=1.5, b=0.75) over prompt + tags, per language."""

    def __init__(self, docs: list[dict], k1: float = 1.5, b: float = 0.75):
        self.docs, self.k1, self.b = docs, k1, b
        self.tf: list[Counter] = []
        self.df: Counter = Counter()
        self.len: list[int] = []
        for d in docs:
            toks = tokenize(d["prompt"] + " " + " ".join(d.get("tags", [])), d["lang"])
            c = Counter(toks)
            self.tf.append(c)
            self.len.append(len(toks))
            self.df.update(c.keys())
        self.n = len(docs)
        self.avg = (sum(self.len) / self.n) if self.n else 1.0
        self.postings: dict[str, list[int]] = defaultdict(list)
        for i, c in enumerate(self.tf):
            for t in c:
                self.postings[t].append(i)

    def idf(self, term: str) -> float:
        n = self.df.get(term, 0)
        return math.log(1 + (self.n - n + 0.5) / (n + 0.5))

    def search(self, query: str, lang: str = "en", kinds: set[str] | None = None, k: int = 5) -> list[tuple[float, int]]:
        q = tokenize(query, lang)
        scores: dict[int, float] = defaultdict(float)
        for term in set(q):
            idf = self.idf(term)
            for i in self.postings.get(term, ()):
                d = self.docs[i]
                if d["lang"] != lang or (kinds and d["kind"] not in kinds):
                    continue
                f = self.tf[i][term]
                scores[i] += idf * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg))
        return sorted(((s, i) for i, s in scores.items()), reverse=True)[:k]


# ---------------------------------------------------------------- layer 3: reflection

class Reflector:
    def __init__(self, data: dict):
        self.stop = {lang: set(ws) for lang, ws in data["stopwords"].items()}
        self.verbs = {lang: set(ws) for lang, ws in data.get("verbs", {}).items()}
        self.flip = data["reflect"]

    def reflect(self, text: str, lang: str = "en") -> str:
        """'my cat hates me' -> 'your cat hates you' (English pronoun swap)."""
        table = self.flip.get(lang)
        if not table:
            return text.strip()
        if lang == "zh":  # no spaces: swap characters, longest keys first
            keys = sorted(table, key=len, reverse=True)
            return re.sub("|".join(map(re.escape, keys)), lambda m: table[m.group(0)], text.strip())
        words = re.findall(r"[\w']+|[^\w\s]", text.strip())
        out = [table.get(w.lower(), w) for w in words]
        s = " ".join(out)
        return re.sub(r"\s+([?.!,])", r"\1", s)

    def subject(self, text: str, lang: str = "en") -> str | None:
        """The phrase the user is talking about, with possessives flipped.

        Prefers what follows an anchor (my/your/the/about/of...), else the last run
        of content words. At most three words. None when nothing is left.
        """
        if lang in CJK_LANGS:
            chars = re.sub(r"[\s\W]", "", norm(text))
            if lang == "zh":
                chars = self.reflect(chars, "zh")
            for q in ("吗", "呢", "吧", "啊", "か", "ね", "よ", "ไหม", "ครับ", "ค่ะ"):
                chars = chars.rstrip(q)
            return chars[-6:] or None
        stop = self.stop.get(lang, set())
        verbs = self.verbs.get(lang, set())
        words = re.findall(r"[\w']+", norm(text))
        if not words:
            return None
        flip = self.flip.get(lang, {})

        def run_after(i: int) -> list[str]:
            run = []
            for w in words[i + 1:i + 4]:
                if w in stop or w in verbs or len(run) == 2:
                    break
                run.append(w)
            return run
        # possessives first, left to right: "my cat keeps knocking the cups" -> "your cat"
        for i, w in enumerate(words):
            if w in ("my", "your", "our") and (run := run_after(i)):
                return flip.get(w, w) + " " + " ".join(run)
        # then articles and prepositions, right to left: "about the moon" -> "moon"
        for i in range(len(words) - 1, -1, -1):
            if words[i] in ("the", "about", "of", "a", "an", "his", "her", "their") and (run := run_after(i)):
                return " ".join(run)
        # otherwise the last run of content words
        run: list[str] = []
        for w in reversed(words):
            if w in stop or w in verbs or len(w) < 2:
                if run:
                    break
                continue
            run.insert(0, w)
            if len(run) == 2:
                break
        return " ".join(run) or None


# ---------------------------------------------------------------- layer 4: CFG + Markov

class Grammar:
    """Context-free grammar: <rule> expands recursively, <subj>/<subj_cap> filled in."""

    def __init__(self, rules: dict[str, list[str]]):
        self.rules = rules

    def expand(self, symbol: str, subj: str, rng: random.Random, depth: int = 0) -> str:
        if depth > 8:
            return ""
        options = self.rules[symbol]
        text = rng.choice(options)

        def sub(m: re.Match) -> str:
            name = m.group(1)
            if name == "subj":
                return subj
            if name == "subj_cap":
                return subj[:1].upper() + subj[1:]
            return self.expand(name, subj, rng, depth + 1)
        return re.sub(r"<(\w+)>", sub, text)

    def count(self, symbol: str = "start", depth: int = 0) -> int:
        """Number of distinct expansions (subject held fixed): the combinatorial size."""
        if depth > 8:
            return 1
        total = 0
        for opt in self.rules[symbol]:
            n = 1
            for name in re.findall(r"<(\w+)>", opt):
                if name not in ("subj", "subj_cap"):
                    n *= self.count(name, depth + 1)
            total += n
        return total


class Markov:
    """Third-order word Markov chain trained on corpus punchlines."""

    def __init__(self, sentences: list[str], order: int = 3):
        self.order = order
        self.table: dict[tuple[str, ...], list[str]] = defaultdict(list)
        self.starts: list[tuple[str, ...]] = []
        # one string holding every training line, for a single fast substring check
        self.blob = "\n".join(norm(s) for s in sentences)
        for s in sentences:
            words = s.split()
            if len(words) <= order:
                continue
            self.starts.append(tuple(words[:order]))
            for i in range(len(words) - order):
                self.table[tuple(words[i:i + order])].append(words[i + order])

    def generate(self, rng: random.Random, max_words: int = 24, tries: int = 20) -> str | None:
        """A sentence that is not a verbatim copy of any training line."""
        if not self.starts:
            return None
        for _ in range(tries):
            state = rng.choice(self.starts)
            out = list(state)
            while len(out) < max_words:
                nxt = self.table.get(tuple(out[-self.order:]))
                if not nxt:
                    break
                out.append(rng.choice(nxt))
                if out[-1][-1:] in ".!?":
                    break
            s = " ".join(out)
            # must be new: not a copy of, or a piece of, any training line
            if len(out) > self.order + 1 and norm(s) not in self.blob:
                return s
        return None


# ---------------------------------------------------------------- layer 1: traps

class TrapRunner:
    """Multi-turn bait-and-switch. One trap active at a time.

    Step forms (from brain.json):
      {"say": ...}                       wait for any reply, then go on
      {"say": ..., "branch": {...}}      classify reply as yes / no / other, finish
      {"say": ..., "answer": {...}}      fuzzy-match reply: hit finishes with the sting;
                                         miss finishes (or continues if miss is null)
    """

    def __init__(self, data: dict):
        self.traps = data["traps"]
        self.yes, self.no = data["yes"], data["no"]
        self.active: dict | None = None
        self.step = 0
        self.played: set[str] = set()

    def classify(self, text: str, lang: str) -> str:
        if contains_phrase(text, self.no.get(lang, []) + self.no["en"], 0.9):
            return "no"
        if contains_phrase(text, self.yes.get(lang, []) + self.yes["en"], 0.9):
            return "yes"
        return "other"

    def available(self, lang: str) -> list[dict]:
        pool = [t for t in self.traps if t["lang"] == lang and t["id"] not in self.played]
        if not pool:  # everything played: allow repeats rather than go quiet
            self.played -= {t["id"] for t in self.traps if t["lang"] == lang}
            pool = [t for t in self.traps if t["lang"] == lang]
        return pool

    def start(self, lang: str, rng: random.Random, trap_id: str | None = None) -> tuple[str, None] | None:
        pool = [t for t in self.traps if t["id"] == trap_id] if trap_id else self.available(lang)
        if not pool:
            return None
        self.active = rng.choice(pool)
        self.played.add(self.active["id"])
        self.step = 0
        return self.active["steps"][0]["say"], None

    def reply(self, text: str, lang: str) -> tuple[str, str | None]:
        """Advance the active trap with the user's reply. Returns (line, sfx)."""
        t = self.active
        assert t is not None
        cur = t["steps"][self.step]
        if "branch" in cur:
            kind = self.classify(text, t["lang"])
            self.active = None
            return cur["branch"][kind], (t["sfx"] if kind == "yes" else "crickets" if kind == "other" else None)
        if "answer" in cur:
            a = cur["answer"]
            if contains_phrase(text, a["match"]):
                self.active = None
                return a["hit"], a.get("hitSfx", t["sfx"])
            if a.get("miss") is not None:
                self.active = None
                return a["miss"], a.get("missSfx")
        # plain step, or a miss that continues: move on
        self.step += 1
        if self.step >= len(t["steps"]):
            self.active = None
            return "Fine. You survived. This time.", "crickets"
        return t["steps"][self.step]["say"], None


# ---------------------------------------------------------------- the router

class Brain:
    def __init__(self, corpus: dict | None = None, data: dict | None = None, seed: int | None = None,
                 llm_url: str | None = None, trap_every: int = 4):
        corpus = corpus or json.loads((DATA / "corpus.json").read_text(encoding="utf-8"))
        self.data = data or json.loads((DATA / "brain.json").read_text(encoding="utf-8"))
        f = corpus["fields"]
        self.docs = [dict(zip(f, row)) for row in corpus["rows"]]
        self.bm25 = BM25(self.docs)
        self.reflector = Reflector(self.data)
        self.grammar = Grammar(self.data["grammar"]["en"])
        self.markov = Markov([d["response"] for d in self.docs if d["lang"] == "en"])
        self.traps = TrapRunner(self.data)
        self.rng = random.Random(seed)
        self.llm_url = llm_url
        self.trap_every = trap_every
        self.turns = 0
        self.history: list[dict] = []

    def _intent(self, text: str, lang: str) -> str | None:
        for name, by_lang in self.data["intents"].items():
            if contains_phrase(text, by_lang.get(lang, []) + (by_lang["en"] if lang != "en" else []), 0.88):
                return name
        return None

    def _pick(self, kind: str, lang: str, topic: str | None) -> dict | None:
        pool = [d for d in self.docs if d["kind"] == kind and d["lang"] == lang]
        if topic:
            hits = self.bm25.search(topic, lang, {kind}, k=8)
            if hits:
                return self.docs[self.rng.choice(hits)[1]]
        return self.rng.choice(pool) if pool else None

    def _coverage(self, text: str, doc: dict, lang: str) -> float:
        """Share of the user's content words the matched prompt also has. A single
        shared word ("cat") is not enough to answer with that joke."""
        stop = self.reflector.stop.get(lang, set())
        q = {t for t in tokenize(text, lang) if t not in stop}
        if not q:
            q = set(tokenize(text, lang))
        d = set(tokenize(doc["prompt"] + " " + " ".join(doc.get("tags", [])), lang))
        return len(q & d) / len(q) if q else 0.0

    def _llm(self, text: str, lang: str) -> str | None:
        """OpenAI-compatible chat completion; any failure falls back to the hybrid brain."""
        if not self.llm_url:
            return None
        body = json.dumps({
            "model": "local", "max_tokens": 80, "temperature": 1.0,
            "messages": [{"role": "system", "content": f"You are Vox, a rude, fast, PG-13 comedy soundboard. Reply in one or two short sentences in language '{lang}'. Never polite, never an assistant."}]
            + self.history[-6:] + [{"role": "user", "content": text}],
        }).encode()
        try:
            req = urllib.request.Request(self.llm_url.rstrip("/") + "/chat/completions", body, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=8) as r:
                return json.loads(r.read())["choices"][0]["message"]["content"].strip()
        except Exception:
            return None

    def reply(self, text: str, lang: str = "en") -> dict:
        t0 = time.perf_counter()
        out = self._reply(text.strip(), lang)
        out["ms"] = (time.perf_counter() - t0) * 1000
        self.history += [{"role": "user", "content": text}, {"role": "assistant", "content": out["text"]}]
        return out

    def _reply(self, text: str, lang: str) -> dict:
        self.turns += 1
        # layer 1: an active trap owns the conversation
        if self.traps.active:
            line, sfx = self.traps.reply(text, lang)
            return {"text": line, "sfx": sfx, "layer": "trap"}
        intent = self._intent(text, lang)
        subj = self.reflector.subject(text, lang)
        if intent == "trap" or (self.trap_every and self.turns % self.trap_every == 0 and not intent):
            started = self.traps.start(lang, self.rng)
            if started:
                return {"text": started[0], "sfx": None, "layer": "trap"}
        if intent in ("joke", "riddle", "roast"):
            d = self._pick(intent, lang, subj if intent != "roast" else None)
            if d:
                if intent == "roast":
                    return {"text": d["response"], "sfx": "boom", "layer": "retrieval"}
                return {"text": f"{d['prompt']} ... {d['response']}", "sfx": "rimshot", "layer": "retrieval"}
        llm = self._llm(text, lang)
        if llm:
            return {"text": llm, "sfx": None, "layer": "llm"}
        # layer 2: retrieval when the corpus has something close
        hits = self.bm25.search(text, lang, k=3)
        if hits and hits[0][0] >= 3.0 and self._coverage(text, self.docs[hits[0][1]], lang) >= 0.6:
            d = self.docs[hits[0][1]]
            if d["kind"] in ("joke", "riddle"):
                return {"text": f"{d['prompt']} ... {d['response']}", "sfx": "rimshot", "layer": "retrieval"}
            return {"text": d["response"], "sfx": "boom" if d["kind"] in ("roast", "comeback") else None, "layer": "retrieval"}
        # layers 3 + 4: reflect the subject into generated lines
        s = subj or self.data["fallback_subject"].get(lang, "that")
        if lang == "en":
            if self.rng.random() < 0.2:
                m = self.markov.generate(self.rng)
                if m:
                    return {"text": f"{self.reflector.reflect(text)}? {m}" if len(text) < 60 else m, "sfx": None, "layer": "markov"}
            line = self.grammar.expand("start", s, self.rng)
            return {"text": line, "sfx": "boom" if self.rng.random() < 0.3 else None, "layer": "grammar"}
        options = self.data["grammar"]["other"].get(lang) or self.data["grammar"]["other"]["es"]
        return {"text": self.rng.choice(options).replace("{subj}", s), "sfx": None, "layer": "grammar"}
