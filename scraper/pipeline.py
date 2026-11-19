"""ETL for the comedy corpus.

extract: local seed .jsonl files, plus optional remote open datasets fetched
         through a rate limiter (one request per `min_interval` seconds per host)
transform: normalize whitespace, drop over-long or blocked lines, detect the
           language from the script when unlabeled, tag topics, de-duplicate
load: web/data/corpus.json (what the browser loads) and data/corpus.sqlite
      (an FTS5 full-text index for the Python CLI and ad-hoc queries)
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import unicodedata
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Callable, Iterable

KINDS = ("joke", "riddle", "roast", "comeback", "qa")
LANGS = ("en", "zh", "ja", "es", "fr", "hi", "it", "pt", "th")

# words that disqualify an entry outright; the bot is rude, not hateful
BLOCKLIST = {
    "nigger", "faggot", "retard", "rape", "kike", "spic", "chink", "tranny",
}

TOPICS = {
    "food": ["food", "eat", "pizza", "cheese", "cake", "banana", "egg", "soup", "cook", "hungry", "pasta", "fruit"],
    "animal": ["dog", "cat", "bear", "frog", "fish", "bird", "cow", "duck", "pig", "animal", "mouse", "dinosaur"],
    "tech": ["computer", "code", "program", "phone", "bug", "robot", "internet", "wifi", "keyboard"],
    "school": ["school", "teacher", "student", "homework", "math", "test", "exam"],
    "work": ["job", "work", "boss", "office", "money", "salary"],
    "music": ["music", "song", "sing", "piano", "guitar", "band"],
}


@dataclass
class Entry:
    kind: str
    lang: str
    prompt: str
    response: str
    tags: list[str] = field(default_factory=list)
    source: str = "seed"


# ---------------------------------------------------------------- extract

def read_seed(path: Path) -> Iterable[Entry]:
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            yield Entry(d["kind"], d.get("lang", ""), d["prompt"], d["response"], list(d.get("tags", [])), f"seed:{path.name}")
        except (json.JSONDecodeError, KeyError) as e:
            raise ValueError(f"{path.name}:{n}: bad seed line ({e})") from None


class RateLimiter:
    """At most one call per `min_interval` seconds per key (host)."""

    def __init__(self, min_interval: float = 1.0, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.min_interval, self.clock, self.sleep = min_interval, clock, sleep
        self.last: dict[str, float] = {}

    def wait(self, key: str) -> float:
        now = self.clock()
        prev = self.last.get(key)
        waited = 0.0
        if prev is not None and now - prev < self.min_interval:
            waited = self.min_interval - (now - prev)
            self.sleep(waited)
            now += waited
        self.last[key] = now
        return waited


# Open datasets with permissive licenses. Each adapter turns the raw JSON into entries.
REMOTE_SOURCES = [
    {
        "name": "official_joke_api",
        "url": "https://raw.githubusercontent.com/15Dkatz/official_joke_api/master/jokes/index.json",
        "license": "MIT (github.com/15Dkatz/official_joke_api)",
        "adapter": lambda data: [Entry("joke", "en", d["setup"], d["punchline"], [d.get("type", "general")], "official_joke_api")
                                 for d in data if isinstance(d, dict) and "setup" in d and "punchline" in d],
    },
]


def fetch_json(url: str, limiter: RateLimiter, timeout: float = 20) -> object:
    host = urllib.parse.urlparse(url).netloc
    limiter.wait(host)
    req = urllib.request.Request(url, headers={"User-Agent": "vox-chaos-corpus-builder/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise IOError(f"{url}: HTTP {r.status}")
        return json.loads(r.read().decode("utf-8"))


def fetch_remote(limiter: RateLimiter, fetch: Callable[[str, RateLimiter], object] = fetch_json) -> tuple[list[Entry], list[str]]:
    """Returns (entries, problems). A failing source is reported, never fatal."""
    out, problems = [], []
    for src in REMOTE_SOURCES:
        try:
            out.extend(src["adapter"](fetch(src["url"], limiter)))
        except Exception as e:  # network, JSON, schema
            problems.append(f"{src['name']}: {e}")
    return out, problems


# ---------------------------------------------------------------- transform

def norm_text(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", " ", s).strip()


def detect_lang(text: str) -> str:
    """Script-based guess; good enough to route CJK, Devanagari and Thai."""
    kana = han = deva = thai = 0
    for ch in text:
        o = ord(ch)
        if 0x3040 <= o <= 0x30FF:
            kana += 1
        elif 0x4E00 <= o <= 0x9FFF:
            han += 1
        elif 0x0900 <= o <= 0x097F:
            deva += 1
        elif 0x0E00 <= o <= 0x0E7F:
            thai += 1
    if kana:
        return "ja"
    if han:
        return "zh"
    if deva:
        return "hi"
    if thai:
        return "th"
    return "en"


def topic_tags(text: str) -> list[str]:
    low = text.lower()
    return [t for t, words in TOPICS.items() if any(re.search(rf"\b{re.escape(w)}", low) for w in words)]


def blocked(text: str) -> bool:
    words = set(re.findall(r"[a-z]+", text.lower()))
    return bool(words & BLOCKLIST)


def clean(entries: Iterable[Entry], max_len: int = 220) -> tuple[list[Entry], dict[str, int]]:
    kept: list[Entry] = []
    seen: set[str] = set()
    dropped = {"blocked": 0, "too_long": 0, "empty": 0, "duplicate": 0, "bad_kind": 0}
    for e in entries:
        p, r = norm_text(e.prompt), norm_text(e.response)
        if not p or not r:
            dropped["empty"] += 1
            continue
        if e.kind not in KINDS:
            dropped["bad_kind"] += 1
            continue
        if len(p) > max_len or len(r) > max_len:
            dropped["too_long"] += 1
            continue
        if blocked(p) or blocked(r):
            dropped["blocked"] += 1
            continue
        key = re.sub(r"[^\w]", "", (p + "|" + r).lower())
        if key in seen:
            dropped["duplicate"] += 1
            continue
        seen.add(key)
        lang = e.lang if e.lang in LANGS else detect_lang(p + r)
        tags = sorted(set(t.lower() for t in e.tags) | set(topic_tags(p + " " + r)))
        kept.append(Entry(e.kind, lang, p, r, tags, e.source))
    return kept, dropped


# ---------------------------------------------------------------- load

def write_json(entries: list[Entry], path: Path) -> None:
    """Compact columnar-ish JSON: one small array per entry keeps the bundle tight."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [[e.kind, e.lang, e.prompt, e.response, e.tags] for e in entries]
    path.write_text(json.dumps({"version": 1, "fields": ["kind", "lang", "prompt", "response", "tags"], "rows": rows},
                               ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def write_sqlite(entries: list[Entry], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    with con:
        con.execute("CREATE TABLE entry (id INTEGER PRIMARY KEY, kind TEXT, lang TEXT, prompt TEXT, response TEXT, tags TEXT, source TEXT)")
        # trigram tokenizer handles CJK/Thai text that has no spaces
        con.execute("CREATE VIRTUAL TABLE entry_fts USING fts5(prompt, response, tags, content='entry', content_rowid='id', tokenize='trigram')")
        con.executemany("INSERT INTO entry (kind, lang, prompt, response, tags, source) VALUES (?,?,?,?,?,?)",
                        [(e.kind, e.lang, e.prompt, e.response, " ".join(e.tags), e.source) for e in entries])
        con.execute("INSERT INTO entry_fts (rowid, prompt, response, tags) SELECT id, prompt, response, tags FROM entry")
    con.close()


def build(seed_dir: Path, out_json: Path, out_db: Path, remote: bool = False,
          limiter: RateLimiter | None = None) -> dict:
    raw: list[Entry] = []
    for f in sorted(seed_dir.glob("*.jsonl")):
        raw.extend(read_seed(f))
    problems: list[str] = []
    if remote:
        got, problems = fetch_remote(limiter or RateLimiter(1.0))
        raw.extend(got)
    entries, dropped = clean(raw)
    write_json(entries, out_json)
    write_sqlite(entries, out_db)
    by_lang: dict[str, int] = {}
    for e in entries:
        by_lang[e.lang] = by_lang.get(e.lang, 0) + 1
    return {"raw": len(raw), "kept": len(entries), "dropped": dropped, "by_lang": by_lang, "problems": problems,
            "json_bytes": out_json.stat().st_size}


def search(db: Path, query: str, limit: int = 5) -> list[tuple[str, str, str]]:
    """FTS5 lookup used by the CLI's `--search`."""
    con = sqlite3.connect(db)
    q = '"' + query.replace('"', ' ') + '"'
    rows = con.execute("SELECT e.kind, e.prompt, e.response FROM entry_fts f JOIN entry e ON e.id = f.rowid "
                       "WHERE entry_fts MATCH ? ORDER BY rank LIMIT ?", (q, limit)).fetchall()
    con.close()
    return rows


if __name__ == "__main__":
    import argparse
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="Build the vox-chaos comedy corpus.")
    ap.add_argument("--remote", action="store_true", help="also fetch open datasets (rate limited, 1 request/s per host)")
    ap.add_argument("--search", help="query the built FTS5 index instead of building")
    a = ap.parse_args()
    if a.search:
        for kind, p, r in search(root / "data" / "corpus.sqlite", a.search):
            print(f"[{kind}] {p} -> {r}")
    else:
        stats = build(root / "seed", root / "web" / "data" / "corpus.json", root / "data" / "corpus.sqlite", remote=a.remote)
        print(json.dumps(stats, indent=1, ensure_ascii=False))
