"""Brain latency: python bench/bench.py"""
import json, random, statistics, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain import Brain

LINES = ["my cat keeps knocking cups off the table", "roast me", "hello", "why is my pizza cold", "I like trains",
         "tell me a riddle", "what is the meaning of life", "my boss thinks I'm lazy", "I hate you", "pizza with pineapple"]
b = Brain(seed=1, trap_every=4)
for l in LINES: b.reply(l)  # warm
ms = [b.reply(random.Random(i).choice(LINES))["ms"] for i in range(2000)]
q = statistics.quantiles(ms, n=100)
t = time.perf_counter(); [b.bm25.search(l, "en") for l in LINES * 100]; bm = (time.perf_counter() - t) * 1000 / 1000
t = time.perf_counter(); Brain(seed=1); load = (time.perf_counter() - t) * 1000
print(json.dumps({"reply_p50_ms": round(q[49], 3), "reply_p95_ms": round(q[94], 3), "reply_p99_ms": round(q[98], 3),
                  "bm25_search_ms": round(bm, 3), "brain_load_ms": round(load, 1), "docs": len(b.docs),
                  "grammar_lines_per_subject": b.grammar.count()}, indent=1))
