import subprocess
from pathlib import Path

import numpy as np

from .config import SAMPLE_RATE


def load(path: str | Path) -> np.ndarray:
    """Decode any audio/video file to 16 kHz mono float32 via ffmpeg."""
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
        "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-",
    ]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def save_wav(samples: np.ndarray, path: str | Path) -> None:
    import soundfile as sf

    sf.write(str(path), samples, SAMPLE_RATE)


def record(seconds: float) -> np.ndarray:
    import sounddevice as sd

    data = sd.rec(int(seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    sd.wait()
    return data[:, 0]
