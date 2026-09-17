"""Kokoro TTS engine backend."""
from pathlib import Path

import soundfile as sf

ROOT = Path(__file__).parent.parent
MODEL_PATH = ROOT / "models" / "kokoro-v1.0.onnx"
VOICES_PATH = ROOT / "models" / "voices-v1.0.bin"

DEFAULT_VOICE = "am_michael"

_kokoro = None


def _get_kokoro():
    global _kokoro
    if _kokoro is None:
        if not MODEL_PATH.exists() or not VOICES_PATH.exists():
            raise FileNotFoundError(
                f"Kokoro model files missing in {ROOT / 'models'}\n"
                "Download from https://github.com/thewh1teagle/kokoro-onnx/releases"
            )
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
    return _kokoro


def synthesize(text: str, voice: str, speed: float, out_path: Path) -> None:
    kokoro = _get_kokoro()
    samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
    sf.write(str(out_path), samples, sample_rate)
