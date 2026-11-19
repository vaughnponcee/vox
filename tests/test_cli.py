import io
import tempfile
import unittest
import wave
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from cli import vox


class CliTest(unittest.TestCase):
    def test_write_wav_is_valid_16bit_mono_and_clips(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.wav"
            vox.write_wav(p, [0.0, 0.5, -0.5, 2.0, -2.0], 24000)
            with wave.open(str(p)) as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 24000, 5))
                frames = w.readframes(5)
            import array
            a = array.array("h", frames)
            self.assertEqual(list(a), [0, 16383, -16383, 32767, -32767])

    def test_every_language_has_a_voice(self):
        for lang in ("en", "zh", "ja", "es", "fr", "hi", "it", "pt", "th"):
            kv, kl, ev = vox.VOICES[lang]
            self.assertTrue(ev, lang)  # edge-tts covers every language
            self.assertEqual(kv is None, kl is None)

    def test_text_mode_repl(self):
        out = io.StringIO()
        with mock.patch("builtins.input", side_effect=["hello", "/lang es", "hola", "/quit"]), redirect_stdout(out):
            vox.main(["--voice", "text", "--seed", "1", "--no-traps"])
        text = out.getvalue()
        self.assertIn("vox> Oh great, a human", text)
        self.assertIn("language: es", text)
        self.assertIn("vox> Hola. Di algo gracioso", text)


if __name__ == "__main__":
    unittest.main()
