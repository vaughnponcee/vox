import json
import random
import statistics
import time
import unittest
from pathlib import Path

from brain import BM25, Brain, Grammar, Markov, Reflector, TrapRunner, tokenize
from brain.core import contains_phrase

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "web" / "data" / "brain.json").read_text(encoding="utf-8"))
GOLDEN = json.loads((ROOT / "tests" / "golden.json").read_text(encoding="utf-8"))


class TokenizeTest(unittest.TestCase):
    def test_words_and_cjk_bigrams(self):
        self.assertEqual(tokenize("Why don't EGGS tell jokes?"), ["why", "don't", "eggs", "tell", "jokes"])
        self.assertEqual(tokenize("你好世界", "zh"), ["你好", "好世", "世界"])
        self.assertEqual(tokenize("Hello  　 world"), ["hello", "world"])  # NFKC + whitespace

    def test_fuzzy_phrase(self):
        self.assertTrue(contains_phrase("um I guess milk?", ["milk"]))
        self.assertTrue(contains_phrase("soy una pappa", ["soy una papa"]))  # one typo
        self.assertFalse(contains_phrase("silky smooth", ["milk"]))
        self.assertTrue(contains_phrase("フライパンです", ["フライパン"]))


class BM25Test(unittest.TestCase):
    docs = [
        {"kind": "joke", "lang": "en", "prompt": "why did the banana go to the doctor", "tags": ["fruit"]},
        {"kind": "joke", "lang": "en", "prompt": "what do you call a fake noodle", "tags": ["pasta"]},
        {"kind": "roast", "lang": "en", "prompt": "roast my banana bread", "tags": []},
        {"kind": "joke", "lang": "es", "prompt": "banana banana banana", "tags": []},
    ]

    def test_ranking_and_language_filter(self):
        ix = BM25(self.docs)
        hits = ix.search("banana doctor", "en")
        self.assertEqual(hits[0][1], 0)
        self.assertTrue(all(self.docs[i]["lang"] == "en" for _, i in hits))
        self.assertEqual(ix.search("noodle", "en")[0][1], 1)
        self.assertEqual(ix.search("zzz", "en"), [])

    def test_kind_filter_and_idf(self):
        ix = BM25(self.docs)
        self.assertEqual([i for _, i in ix.search("banana", "en", {"roast"})], [2])
        self.assertGreater(ix.idf("noodle"), ix.idf("banana"))  # rarer term weighs more

    def test_under_5ms_on_the_real_corpus(self):
        b = Brain(seed=1)
        queries = ["my cat is lazy", "why is the sky blue", "pizza", "roast my cooking", "what do you call a cow"] * 40
        times = []
        for q in queries:
            t = time.perf_counter()
            b.bm25.search(q, "en")
            times.append((time.perf_counter() - t) * 1000)
        self.assertLess(statistics.quantiles(times, n=20)[18], 5.0)  # p95


class ReflectorTest(unittest.TestCase):
    def test_golden_subjects(self):
        r = Reflector(DATA)
        for c in GOLDEN["subject"]:
            with self.subTest(c["text"]):
                self.assertEqual(r.subject(c["text"], c["lang"]), c["want"])

    def test_golden_reflections(self):
        r = Reflector(DATA)
        for c in GOLDEN["reflect"]:
            with self.subTest(c["text"]):
                self.assertEqual(r.reflect(c["text"], c["lang"]), c["want"])


class GeneratorTest(unittest.TestCase):
    def test_grammar_fills_subject_and_never_leaves_symbols(self):
        g = Grammar(DATA["grammar"]["en"])
        rng = random.Random(4)
        for _ in range(300):
            s = g.expand("start", "your cat", rng)
            self.assertNotIn("<", s)
            self.assertTrue("your cat" in s.lower())

    def test_combinatorial_size(self):
        n = Grammar(DATA["grammar"]["en"]).count()
        self.assertGreater(n, 10_000_000)

    def test_grammar_is_deterministic_per_seed(self):
        g = Grammar(DATA["grammar"]["en"])
        a = [g.expand("start", "x", random.Random(9)) for _ in range(3)]
        b = [g.expand("start", "x", random.Random(9)) for _ in range(3)]
        self.assertEqual(a, b)

    def test_markov_order3_produces_new_lines_only(self):
        lines = ["the cat sat on the mat today", "the cat sat on the hat today", "a dog sat on the mat again",
                 "the cat sat on a log yesterday", "a dog sat on the hat tonight"]
        m = Markov(lines)
        self.assertEqual(m.order, 3)
        rng = random.Random(2)
        made = [m.generate(rng) for _ in range(50)]
        made = [x for x in made if x]
        self.assertTrue(made, "should find some recombination")
        for s in made:
            self.assertFalse(any(s in l for l in lines), s)
            words = s.split()
            for i in range(len(words) - 3):  # every 4-gram transition came from training
                self.assertTrue(any(" ".join(words[i:i + 4]) in l for l in lines))


class TrapTest(unittest.TestCase):
    def run_trap(self, case):
        t = TrapRunner(DATA)
        first, _ = t.start(case["lang"], random.Random(0), case["id"])
        self.assertTrue(first)
        line, sfx = None, None
        for r in case["replies"]:
            self.assertIsNotNone(t.active, f"trap ended early before {r!r}")
            line, sfx = t.reply(r, case["lang"])
        return t, line, sfx

    def test_golden_trap_paths(self):
        for c in GOLDEN["traps"]:
            with self.subTest(f"{c['id']} {c['replies']}"):
                t, line, sfx = self.run_trap(c)
                self.assertIn(c["final"], line)
                self.assertEqual(sfx, c["sfx"])
                self.assertIsNone(t.active, "trap should be finished")

    def test_yes_no_classifier(self):
        t = TrapRunner(DATA)
        self.assertEqual(t.classify("yeah obviously", "en"), "yes")
        self.assertEqual(t.classify("nah not really", "en"), "no")
        self.assertEqual(t.classify("purple", "en"), "other")
        self.assertEqual(t.classify("不喜欢", "zh"), "no")  # the 'no' check runs first
        self.assertEqual(t.classify("claro que sí", "es"), "yes")

    def test_every_trap_is_well_formed(self):
        for trap in DATA["traps"]:
            self.assertIn(trap["lang"], DATA["yes"])
            for st in trap["steps"]:
                self.assertTrue(st["say"])
                if "branch" in st:
                    self.assertEqual(set(st["branch"]), {"yes", "no", "other"})


class RouterTest(unittest.TestCase):
    def test_golden_retrieval(self):
        b = Brain(seed=1, trap_every=0)
        for c in GOLDEN["retrieval"]:
            with self.subTest(c["text"]):
                r = b.reply(c["text"], c["lang"])
                self.assertEqual(r["layer"], "retrieval")
                self.assertIn(c["contains"], r["text"])

    def test_off_script_uses_the_users_subject(self):
        b = Brain(seed=2, trap_every=0)
        r = b.reply("my grandma drives a forklift")
        self.assertIn(r["layer"], ("grammar", "markov"))
        if r["layer"] == "grammar":
            self.assertIn("your grandma", r["text"].lower())

    def test_intents_route_to_the_right_kind(self):
        b = Brain(seed=3, trap_every=0)
        self.assertEqual(b.reply("roast me")["sfx"], "boom")
        self.assertIn(" ... ", b.reply("tell me a joke")["text"])
        self.assertEqual(b.reply("play a game")["layer"], "trap")

    def test_trap_takes_over_until_it_ends(self):
        b = Brain(seed=1, trap_every=0)
        b.reply("trap me")
        for _ in range(6):
            if not b.traps.active:
                break
            self.assertEqual(b.reply("hmm")["layer"], "trap")
        self.assertIsNone(b.traps.active)

    def test_traps_start_on_their_own_every_n_turns(self):
        b = Brain(seed=1, trap_every=3)
        layers = [b.reply(t)["layer"] for t in ["my dog is weird", "pizza", "the moon"]]
        self.assertEqual(layers[2], "trap")

    def test_llm_failure_falls_back(self):
        b = Brain(seed=1, trap_every=0, llm_url="http://127.0.0.1:9/v1")  # nothing listens on port 9
        r = b.reply("my grandma drives a forklift")
        self.assertNotEqual(r["layer"], "llm")

    def test_reply_latency_p95_under_5ms(self):
        b = Brain(seed=5, trap_every=0)
        lines = ["my cat is lazy", "roast me", "hello", "why is my pizza cold", "I like trains", "tell me a riddle"] * 30
        ms = [b.reply(l)["ms"] for l in lines]
        self.assertLess(statistics.quantiles(ms, n=20)[18], 5.0)


if __name__ == "__main__":
    unittest.main()
