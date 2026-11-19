# vox-chaos

A hold-to-talk comedy voice bot. You talk; it answers with bait-and-switch traps, roasts, riddles and generated nonsense in a neural voice, with sting sound effects and a lip-synced pixel host. It speaks nine languages.

There's no LLM: the conversation comes from a four-layer brain that replies in well under a millisecond. Two ways to run it:
- **Web:** static files, on GitHub Pages.
- **CLI:** a Python program.

**Live:** https://vaughnponcee.github.io/vox-chaos/

```bash
python -m scraper.pipeline --remote      # rebuild the corpus (seeds + open datasets)
python -m cli.vox                        # terminal chat with voice
python -m unittest discover -s tests -t .   # 32 Python tests
node --test "tests/*.test.mjs"              # 17 JavaScript tests
python bench/bench.py && node bench/bench.mjs
```

The scraper, brain and tests use the Python and Node standard libraries only. Voice output in the CLI is optional: `pip install kokoro-onnx`, or `pip install edge-tts`.

## The brain: four layers, no model

Every turn runs through the layers in order. The first one that has something to say answers.

| layer | what it does | file |
|---|---|---|
| 1. Trap state machine | Multi-turn bait-and-switch: say silk five times, then "what do cows drink?"; the 28-days trivia; "answer without saying yes"; "how do you say I am a potato in Spanish". Replies are classified by fuzzy matching against yes/no lexicons and answer lists, per language. Traps also start on their own every fourth turn. | `TrapRunner` |
| 2. BM25 retrieval | Okapi BM25 (k1 = 1.5, b = 0.75) over the prompts and tags of 530 corpus entries, filtered by language. Uses word tokens for spaced languages and character bigrams for Chinese, Japanese and Thai. A hit must score at least 3.0 *and* cover 60% of your content words, so one shared word ("cat") isn't enough to fire an unrelated cat joke. | `BM25` |
| 3. Subject reflector | Finds what you're talking about (possessives first, then nouns after articles, stopping at verbs) and flips pronouns. "my boss thinks I'm lazy" gives the subject "your boss" and the reflection "your boss thinks you're lazy". Chinese gets 我 ↔ 你 swaps. | `Reflector` |
| 4. Generators | A context-free grammar puts the subject into roasts, fake news, fake facts and deflections, each optionally followed by a tag sentence: 20,786,688 distinct lines per subject. A third-order word Markov chain recombines corpus punchlines and rejects any output that is a substring of a training line. | `Grammar`, `Markov` |

**Optional local LLM.** Point the brain at any OpenAI-compatible server, such as llama.cpp's `llama-server` on `http://localhost:8080/v1`. Off-script lines then go to the model, while traps and explicit joke, roast and riddle requests stay in the hybrid brain. Any error or 8-second timeout falls back to the hybrid brain silently.

**One brain, two languages.** The brain exists twice: `brain/core.py` for the CLI, and `web/brain.js`, a direct port, for the browser. Both read the same `web/data/brain.json`, which holds the traps, grammar, lexicons and pronoun tables. Both run the same `tests/golden.json`, covering subject extraction, reflection, retrieval and every trap path. The JavaScript port reimplements `difflib`'s Ratcliff-Obershelp ratio, so fuzzy matching gives identical results in both.

### Latency

Windows 11, one thread, 2,000 mixed turns, `bench/`:

| | Python 3.14 | Node 24 (same engine as Chrome) |
|---|---:|---:|
| reply p50 | 0.13 ms | 0.06 ms |
| reply p95 | 0.76 ms | 0.35 ms |
| reply p99 | 0.95 ms | 0.81 ms |
| BM25 search | 0.12 ms | 0.05 ms |
| load corpus and build index | 11 ms | 13 ms |

## The corpus

`scraper/pipeline.py` is a small ETL:

1. **Extract.**
   - Hand-written seed files (`seed/*.jsonl`): jokes, riddles, roasts, comebacks and small talk in English, Mandarin, Japanese, Spanish, French, Hindi, Italian, Portuguese and Thai.
   - With `--remote`, open datasets fetched through a per-host rate limiter (one request per second). Today that's the MIT-licensed [official_joke_api](https://github.com/15Dkatz/official_joke_api) set.
   - A source that fails is reported in the build stats, never fatal.
2. **Transform.** It:
   - normalizes text (NFKC, whitespace);
   - drops empty, over-long, slur-containing and duplicate entries;
   - detects language from the script when unlabeled (kana → ja, han → zh, Devanagari → hi, Thai → th);
   - tags topics.
3. **Load.**
   - `web/data/corpus.json`: 54 KB, what the browser downloads.
   - `data/corpus.sqlite`: an FTS5 index with the trigram tokenizer, so Chinese and Japanese text is searchable. `python -m scraper.pipeline --search banana` queries it.

The current build kept 530 of 541 entries (11 duplicates dropped).

## Voice

**Browser.**
- [kokoro-js](https://github.com/hexgrad/kokoro) 1.2.1 runs Kokoro-82M (`onnx-community/Kokoro-82M-v1.0-ONNX`, Apache-2.0) in the tab:
  - **WebGPU:** used when available, with the fp32 weights.
  - **WASM:** the fallback, with the q8 weights.
  - The weights download once and are cached by the browser.
- Each reply is split into sentences. The next sentence is synthesized while the current one plays.
- The audio goes through a Web Audio `AnalyserNode` that drives the VU meter and the mouth.
- Pitch and speed are independent: `playbackRate` sets speed, and `detune` compensates so pitch only moves when you ask.
- The stings (deep boom, crickets, rimshot) are synthesized with oscillators and filtered noise. There are no audio files.

**Measured in headless Edge, CPU only (no GPU):**
- The model loaded in 13 s.
- WASM synthesis ran about 3× *slower* than real time.

A slow device would leave long silences, so the app measures every neural line. After the warm-up line, if synthesis is more than 1.5× slower than real time, it switches to the browser's native voice and says so on the display. The NEURAL VOICE switch forces Kokoro back. With WebGPU this doesn't trigger.

**Language coverage.** The kokoro-js browser package phonemizes English only (American and British voices). Mandarin, Japanese, Spanish, French, Hindi, Italian, Portuguese and Thai use the browser's SpeechSynthesis voices for those languages.

**CLI.** [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) with the int8 model (92 MB plus 28 MB of voices, downloaded on first run to `~/.cache/vox-chaos`) speaks all of those except Thai with Kokoro's own voices. Thai, and any machine without kokoro-onnx, falls back to edge-tts.

Measured on CPU after warm-up (real-time factor below 1 means faster than real time):

| language | rtf |
|---|---:|
| English | 0.54 to 0.71 |
| British English | 0.57 |
| Spanish | 0.71 |
| French | 0.80 |
| Mandarin | 0.76 |
| Japanese | 0.63 |

## Push to talk

- **Holding:** hold the red button (pointer capture, so sliding off doesn't drop it) or hold **Space**. Key repeat is ignored, and Space does nothing while a text field has focus.
- **While you hold:**
  - the bot stops talking: the audio queue is interrupted and pending lines are dropped;
  - speech recognition listens in the selected language;
  - the input VU meter and a timer run.
- **On release:** recognition keeps going for 250 ms so the last word isn't clipped. Then the transcript goes to the brain.
- **Audio queue (`web/queue.js`):**
  - plays strictly one item at a time;
  - prepares the next item during playback;
  - skips failed syntheses without stalling;
  - reports state.
- **Text mode:** switches the microphone off. It turns on automatically in browsers without speech recognition (Firefox).

Speech recognition uses the browser's own recognizer. In Chrome and Edge that means your voice goes to Google's or Microsoft's speech service while you hold the button; the page says so. Everything else (the brain, the voice and the stings) runs in the tab.

## Layout

```
scraper/pipeline.py   extract / clean / tag / bundle, rate limiter, FTS5 search
seed/*.jsonl          hand-written multilingual seed corpus
brain/core.py         the four-layer brain (Python)
cli/vox.py            terminal bot: kokoro-onnx -> edge-tts -> text
web/                  the static app (GitHub Pages serves the repo root; index.html redirects here)
  brain.js            the four-layer brain (browser port)
  queue.js            audio queue + sentence splitter
  voice.js            Kokoro / native TTS, pitch and speed, synthesized stings
  face.js             pixel host with amplitude lip-sync, blinks, brows
  app.js              push-to-talk, recognition, meters, wiring
  data/               corpus.json, brain.json
tests/                golden.json (shared), Python unittest, node:test
bench/                latency benchmarks
```

## Limits

- **Browser neural voice is English only;** the other languages use whatever voices the browser has. Hindi and Thai voices are missing on some systems, and then speech falls back to the default voice.
- **Kokoro on CPU-only browsers is slower than real time,** so the app falls back to native speech. WebGPU (Chrome, Edge) is the intended path.
- **The corpus is small:** 530 entries, 501 of them English. Non-English replies lean on traps and short templates.
- **The CLI has no hold-to-talk microphone input;** you type and it speaks.
- **Roasts are PG-13 by design.** The cleaner drops slurs from scraped data, but the bot is rude, and that's the point.
