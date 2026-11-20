# vox-chaos

A hold-to-talk comedy voice bot. You talk; a small LLM on your GPU answers in a fast neural voice, with traps, roasts and sting sound effects, and a lip-synced mascot. Without a GPU it falls back to an instant joke engine. It speaks nine languages.

Nothing runs on a server: the AI and the voices run in your browser. Two ways to run it:
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

## Two brains

On first visit you pick one. You can switch at any time in Settings.

**On-device AI (Smart or Fast).** Qwen2.5 (1.5B or 0.5B, 4-bit), run on your GPU by [WebLLM](https://github.com/mlc-ai/web-llm) 0.2.86 inside a Web Worker. It's free: there's no server and no API key. The weights download once (about 0.9 GB or 0.3 to 0.4 GB) and are cached by the browser.
- **Persona:** a system prompt makes it a playful, flirty, quick comedian on a phone call. Replies are short, it teases and calls back to earlier lines, and it usually ends with a question.
- **Streaming:** the reply streams token by token. Each sentence is handed to the voice the moment it ends, so speech starts while the rest is still being written. Small models sometimes slip in markdown or emoji; those are stripped before speaking.
- **f32 fallback:** GPUs without 16-bit float shaders (common on integrated and mobile GPUs) get the f32 build of the same model automatically.
- **Slow GPUs:** if a GPU can't start a reply within 12 s, that turn is answered by the joke engine instead of leaving you waiting.
- **Traps:** the trap state machine still runs in AI mode. Say "play a game", or one starts on its own every sixth turn.

**Joke engine.** The original four-layer brain, described below. It answers instantly and needs no download or GPU.

**Not verified on real hardware.** I couldn't test the AI's reply quality or speed here. The only GPU available was a software emulator. It loaded the model fine (download, cache, worker, f32 switch, streaming), but generated garbage text at 0.08 tokens/s, which is a known limitation of emulated WebGPU. On a real GPU, WebLLM's published numbers for these models are tens of tokens per second.

## The joke engine: four layers, no model

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

| voice | engine | speed | quality |
|---|---|---|---|
| Hazel, Ryan, Alba (default) | [Piper](https://github.com/rhasspy/piper) VITS voices, 20 to 60 MB each, via `@mintplex-labs/piper-tts-web` and ONNX Runtime Web (WASM) | about 3x faster than real time on a CPU (measured 1.25 s for 3.5 s of speech) | natural, slightly synthetic |
| Heart, George (studio) | Kokoro-82M via kokoro-js 1.2.1, WebGPU fp32 or WASM q8 | fast on WebGPU; about 3x *slower* than real time on CPU only | the most human |
| Browser voice | SpeechSynthesis | instant | depends on the system |

**Piper:**
- **Languages:** Piper voices exist for English, Mandarin, Spanish, French, Italian and Portuguese, and each language uses its own speaker. Japanese, Hindi and Thai have no Piper voice, so they use the browser's.
- **Preloading:** the voice for the current language starts downloading as soon as you pick a brain, so the first reply doesn't wait for it.
- **Fixed singleton bug:** the Piper library keeps one global session and silently ignores a second voice. The app clears that singleton so each voice gets its own session. Before the fix, Mandarin text was being read by the English voice.
- **Pinned runtime:** the ONNX runtime is pinned (esm.sh `?deps=onnxruntime-web@1.20.1`, with the WASM files from the same version), because the library's own default URL no longer exists.

**Kokoro:** it downloads only if you pick a studio voice. If the device synthesizes slower than real time, it hands over to Piper.

**Stings:** the boom, crickets and rimshot are synthesized with Web Audio; there are no audio files.

**CLI:** the CLI is unchanged. kokoro-onnx runs faster than real time on CPU in English, Spanish, French, Mandarin and Japanese:

| language | real-time factor |
|---|---:|
| English | 0.54 to 0.71 |
| British English | 0.57 |
| Spanish | 0.71 |
| French | 0.80 |
| Mandarin | 0.76 |
| Japanese | 0.63 |

## Look

Full window, a white page with a soft coloured glow behind the host. The glow follows the state: warm when idle, blue while listening, amber while thinking, mint while talking.

- **The host** is a glossy coral blob drawn on a canvas. It breathes when idle, widens its eyes and looks toward you while listening, wobbles while thinking, and opens its mouth with the loudness of the voice. Punchlines make it hop.
- **The status line** under the host reads Hold to talk, Listening, Contemplating or Talking.
- **Captions** below show what you said in grey and the reply in large type. The CC button hides them.
- **Bottom controls:** captions, the hold-to-talk mic (with a ring that pulses with your voice), settings, and a red button that cuts the bot off mid-line.
- **Settings** slide in from the right on desktop and up from the bottom on phones: language, voice, pitch, speed, stings, options and the conversation history.

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
