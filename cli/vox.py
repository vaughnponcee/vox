"""vox in the terminal: type a line, the brain answers, a voice says it.

    python -m cli.vox                 # chat (voice if kokoro-onnx or edge-tts is installed)
    python -m cli.vox --lang es       # Spanish
    python -m cli.vox --llm http://localhost:8080/v1
    python -m cli.vox --download-model

Voices, in order of preference:
  kokoro-onnx  local CPU synthesis with the Kokoro-82M int8 model (pip install kokoro-onnx)
  edge-tts     Microsoft's online neural voices (pip install edge-tts), used when Kokoro
               is missing or for languages Kokoro has no voice for (Thai)
  text only    when neither is installed
"""
from __future__ import annotations

import argparse
import asyncio
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from pathlib import Path

from brain import Brain

CACHE = Path(os.environ.get("VOX_CACHE", Path.home() / ".cache" / "vox"))
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

# language -> (kokoro voice, espeak language code, edge-tts voice)
VOICES = {
    "en": ("am_michael", "en-us", "en-US-GuyNeural"),
    "gb": ("bm_george", "en-gb", "en-GB-RyanNeural"),
    "es": ("ef_dora", "es", "es-ES-AlvaroNeural"),
    "fr": ("ff_siwis", "fr-fr", "fr-FR-HenriNeural"),
    "it": ("if_sara", "it", "it-IT-DiegoNeural"),
    "pt": ("pf_dora", "pt-br", "pt-BR-AntonioNeural"),
    "hi": ("hf_alpha", "hi", "hi-IN-MadhurNeural"),
    "ja": ("jf_alpha", "ja", "ja-JP-KeitaNeural"),
    "zh": ("zf_xiaobei", "cmn", "zh-CN-YunxiNeural"),
    "th": (None, None, "th-TH-NiwatNeural"),
}


def download_model(verbose: bool = True) -> tuple[Path, Path]:
    CACHE.mkdir(parents=True, exist_ok=True)
    out = []
    for url in (MODEL_URL, VOICES_URL):
        dest = CACHE / url.rsplit("/", 1)[1]
        if not dest.exists():
            if verbose:
                print(f"downloading {dest.name} ...", flush=True)
            tmp = dest.with_suffix(".part")
            urllib.request.urlretrieve(url, tmp)
            tmp.replace(dest)
        out.append(dest)
    return out[0], out[1]


def play_wav(path: Path) -> None:
    if sys.platform == "win32":
        import winsound
        winsound.PlaySound(str(path), winsound.SND_FILENAME)
        return
    for cmd in (["afplay"], ["aplay", "-q"], ["paplay"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd + [str(path)], check=False)
            return


def write_wav(path: Path, samples, rate: int) -> None:
    import array
    pcm = array.array("h", (int(max(-1.0, min(1.0, float(s))) * 32767) for s in samples))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


class Speaker:
    """Synthesizes on the caller's thread, plays on a worker thread: one line at a time, in order."""

    def __init__(self, engine: str = "auto", speed: float = 1.0):
        self.engine, self.speed = "text", speed
        self.kokoro = None
        self.jobs: queue.Queue = queue.Queue()
        if engine in ("auto", "kokoro"):
            try:
                from kokoro_onnx import Kokoro
                model, voices = download_model(verbose=True)
                self.kokoro = Kokoro(str(model), str(voices))
                self.engine = "kokoro"
            except ImportError:
                if engine == "kokoro":
                    raise SystemExit("kokoro-onnx is not installed: pip install kokoro-onnx")
        if self.engine == "text" and engine in ("auto", "edge"):
            try:
                import edge_tts  # noqa: F401
                self.engine = "edge"
            except ImportError:
                pass
        threading.Thread(target=self._worker, daemon=True).start()

    def _worker(self):
        while True:
            path = self.jobs.get()
            try:
                play_wav(path)
            finally:
                path.unlink(missing_ok=True)
                self.jobs.task_done()

    def synth(self, text: str, lang: str) -> tuple[Path | None, float]:
        kv, kl, ev = VOICES.get(lang, VOICES["en"])
        t0 = time.perf_counter()
        fd, name = tempfile.mkstemp(suffix=".wav")
        os.close(fd)  # mkstemp leaves it open; Windows can't reuse or delete an open file
        tmp = Path(name)
        if self.engine == "kokoro" and kv:
            samples, rate = self.kokoro.create(text, voice=kv, speed=self.speed, lang=kl)
            write_wav(tmp, samples, rate)
        elif self.engine in ("edge", "kokoro"):
            try:
                import edge_tts
            except ImportError:
                return None, 0.0
            mp3 = tmp.with_suffix(".mp3")
            asyncio.run(edge_tts.Communicate(text, ev).save(str(mp3)))
            if not shutil.which("ffmpeg"):
                print("  (edge-tts audio needs ffmpeg to play here)")
                return None, 0.0
            subprocess.run(["ffmpeg", "-loglevel", "quiet", "-y", "-i", str(mp3), str(tmp)], check=False)
            mp3.unlink(missing_ok=True)
        else:
            tmp.unlink(missing_ok=True)
            return None, 0.0
        return tmp, (time.perf_counter() - t0) * 1000

    def say(self, text: str, lang: str) -> float:
        path, ms = self.synth(text, lang)
        if path:
            self.jobs.put(path)
        return ms


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="vox comedy voice bot")
    ap.add_argument("--lang", default="en", choices=sorted(VOICES))
    ap.add_argument("--voice", default="auto", choices=["auto", "kokoro", "edge", "text"])
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--llm", help="OpenAI-compatible endpoint, e.g. http://localhost:8080/v1")
    ap.add_argument("--no-traps", action="store_true")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--download-model", action="store_true")
    a = ap.parse_args(argv)
    if a.download_model:
        m, v = download_model()
        print(f"model: {m}\nvoices: {v}")
        return
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    brain = Brain(seed=a.seed, llm_url=a.llm, trap_every=0 if a.no_traps else 4)
    speaker = Speaker(a.voice, a.speed) if a.voice != "text" else None
    lang = "en" if a.lang == "gb" else a.lang
    print(f"vox  [{lang}]  voice: {speaker.engine if speaker else 'text'}  brain: {'llm+hybrid' if a.llm else 'hybrid'}")
    print("talk to it. /lang xx switches language, /quit exits.\n")
    while True:
        try:
            line = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        if line in ("/quit", "/exit"):
            break
        if line.startswith("/lang "):
            lang = line.split()[1] if line.split()[1] in VOICES else lang
            print(f"  language: {lang}")
            continue
        r = brain.reply(line, lang)
        sting = {"boom": "  *BOOM*", "rimshot": "  *ba-dum tss*", "crickets": "  *crickets*"}.get(r["sfx"] or "", "")
        print(f"vox> {r['text']}{sting}   [{r['layer']} {r['ms']:.1f} ms]")
        if speaker:
            ms = speaker.say(r["text"], a.lang if a.lang == "gb" else lang)
            if ms:
                print(f"     (voice {speaker.engine}: {ms:.0f} ms)")
    if speaker:
        speaker.jobs.join()


if __name__ == "__main__":
    main()
