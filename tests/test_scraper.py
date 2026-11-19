import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from scraper.pipeline import Entry, RateLimiter, build, clean, detect_lang, fetch_remote, read_seed, search, topic_tags


class FakeClock:
    def __init__(self):
        self.t = 100.0
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


class ScraperTest(unittest.TestCase):
    def test_rate_limiter_spaces_requests_per_host(self):
        c = FakeClock()
        lim = RateLimiter(1.0, c.now, c.sleep)
        self.assertEqual(lim.wait("a.com"), 0.0)
        c.t += 0.3
        self.assertAlmostEqual(lim.wait("a.com"), 0.7)
        self.assertEqual(lim.wait("b.com"), 0.0)  # other hosts are independent
        c.t += 5
        self.assertEqual(lim.wait("a.com"), 0.0)
        self.assertEqual(len(c.slept), 1)
        self.assertAlmostEqual(c.slept[0], 0.7)

    def test_clean_dedupes_blocks_and_detects_language(self):
        raw = [
            Entry("joke", "en", "Why  did the\tchicken cross?", "To get to the other side.", []),
            Entry("joke", "en", "why did the chicken cross?", "to get to the other side!", []),  # duplicate
            Entry("joke", "", "什么东西越洗越脏？", "水。", []),
            Entry("joke", "", "パンはパンでも？", "フライパン", []),
            Entry("joke", "en", "x" * 300, "too long", []),
            Entry("joke", "en", "a kike walks in", "no", []),
            Entry("meme", "en", "bad kind", "x", []),
            Entry("joke", "en", "   ", "empty prompt", []),
        ]
        kept, dropped = clean(raw)
        self.assertEqual([e.lang for e in kept], ["en", "zh", "ja"])
        self.assertEqual(kept[0].prompt, "Why did the chicken cross?")
        self.assertEqual(dropped, {"blocked": 1, "too_long": 1, "empty": 1, "duplicate": 1, "bad_kind": 1})

    def test_language_and_topic_detection(self):
        self.assertEqual(detect_lang("नमस्ते"), "hi")
        self.assertEqual(detect_lang("สวัสดี"), "th")
        self.assertEqual(detect_lang("hello"), "en")
        self.assertEqual(topic_tags("My dog ate the pizza"), ["food", "animal"])

    def test_bad_seed_line_reports_file_and_line(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.jsonl"
            p.write_text('{"kind":"joke","prompt":"a","response":"b"}\nnot json\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "x.jsonl:2"):
                list(read_seed(p))

    def test_remote_failures_are_reported_not_fatal(self):
        def boom(url, lim):
            raise IOError("offline")
        entries, problems = fetch_remote(RateLimiter(0), boom)
        self.assertEqual(entries, [])
        self.assertIn("offline", problems[0])

    def test_remote_adapter_maps_records(self):
        fake = [{"setup": "Why?", "punchline": "Because.", "type": "general"}, {"bad": 1}]
        entries, problems = fetch_remote(RateLimiter(0), lambda url, lim: fake)
        self.assertEqual(problems, [])
        self.assertEqual((entries[0].prompt, entries[0].response, entries[0].source), ("Why?", "Because.", "official_joke_api"))

    def test_build_writes_json_and_searchable_fts5(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "seed").mkdir()
            (d / "seed" / "a.jsonl").write_text(
                '{"kind":"joke","lang":"en","prompt":"Why did the banana go to the doctor?","response":"It was not peeling well."}\n'
                '{"kind":"riddle","lang":"zh","prompt":"什么东西越洗越脏？","response":"水。"}\n', encoding="utf-8")
            stats = build(d / "seed", d / "web" / "corpus.json", d / "corpus.sqlite")
            self.assertEqual(stats["kept"], 2)
            bundle = json.loads((d / "web" / "corpus.json").read_text(encoding="utf-8"))
            self.assertEqual(bundle["fields"], ["kind", "lang", "prompt", "response", "tags"])
            self.assertEqual(len(bundle["rows"]), 2)
            self.assertEqual(search(d / "corpus.sqlite", "banana")[0][2], "It was not peeling well.")
            self.assertEqual(search(d / "corpus.sqlite", "越洗越")[0][2], "水。")  # trigram index handles CJK
            con = sqlite3.connect(d / "corpus.sqlite")
            n = con.execute("select count(*) from entry").fetchone()[0]
            con.close()  # Windows can't delete the temp folder while it's open
            self.assertEqual(n, 2)

    def test_shipped_bundle_exists_and_covers_every_language(self):
        root = Path(__file__).resolve().parent.parent
        bundle = json.loads((root / "web" / "data" / "corpus.json").read_text(encoding="utf-8"))
        langs = {row[1] for row in bundle["rows"]}
        self.assertTrue({"en", "zh", "ja", "es", "fr", "hi", "it", "pt", "th"} <= langs)


if __name__ == "__main__":
    unittest.main()
