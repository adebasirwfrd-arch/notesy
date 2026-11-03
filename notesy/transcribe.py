import bisect
import threading
from functools import lru_cache

import numpy as np

from . import config
from .glossary import Glossary

_lock = threading.Lock()

MERGE_GAP = 1.5
PAD = 0.2
TURN_GAP = 0.6
GAP_TOLERANCE = 0.2
RECHECK_MIN_SECONDS = 0.8
RECHECK_QUALITY = 0.72
RECHECK_MARGIN = 0.05


@lru_cache(maxsize=1)
def model_path() -> str:
    """Local snapshot path, so transcription never touches the network."""
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(config.WHISPER_MODEL, local_files_only=True)
    except Exception:
        return config.WHISPER_MODEL


def _whisper(samples: np.ndarray, glossary: Glossary, language: str | None,
             word_timestamps: bool) -> dict:
    import mlx_whisper

    with _lock:
        return mlx_whisper.transcribe(
            samples,
            path_or_hf_repo=model_path(),
            language=language,
            initial_prompt=glossary.prompt(),
            word_timestamps=word_timestamps,
            hallucination_silence_threshold=2.0 if word_timestamps else None,
            verbose=None,
        )


def text_only(samples: np.ndarray, glossary: Glossary, language: str | None = None) -> str:
    result = _whisper(samples, glossary, language, word_timestamps=False)
    text = " ".join(s["text"].strip() for s in result["segments"]).strip()
    return glossary.correct_text(text)


def _words(segments: list[dict]) -> list[dict]:
    words = []
    for seg in segments:
        if seg.get("words"):
            words.extend(
                {"word": w["word"], "start": float(w["start"]), "end": float(w["end"]),
                 "probability": float(w.get("probability", 1.0))}
                for w in seg["words"]
            )
        elif seg["text"].strip():
            words.append({"word": " " + seg["text"].strip(), "start": float(seg["start"]),
                          "end": float(seg["end"]), "probability": 1.0})
    return words


def _chunks(turns, duration: float) -> list[tuple[float, float, str]]:
    merged: list[list] = []
    for t in sorted(turns, key=lambda t: t.start):
        if merged and merged[-1][2] == t.speaker and t.start - merged[-1][1] <= MERGE_GAP:
            merged[-1][1] = max(merged[-1][1], t.end)
        else:
            merged.append([t.start, t.end, t.speaker])
    return [(max(0.0, s - PAD), min(duration, e + PAD), spk) for s, e, spk in merged]


def transcribe_turns(samples: np.ndarray, turns, glossary: Glossary,
                     language: str | None = None, progress=None) -> list[dict]:
    """Transcribe each speaker's speech as one stitched stream.

    Whisper detects language once per stream, so stitching per speaker gives
    every speaker their own language (code-switched meetings are not
    translated into one language) while keeping encoder windows full.
    Word timestamps are mapped back to the original timeline.
    """
    sr = config.SAMPLE_RATE
    if not turns:
        result = _whisper(samples, glossary, language, word_timestamps=True)
        return [{**w, "speaker": "spk0", "language": result.get("language")}
                for w in _words(result["segments"])]

    by_spk: dict[str, list[tuple[float, float]]] = {}
    for s, e, spk in _chunks(turns, len(samples) / sr):
        by_spk.setdefault(spk, []).append((s, e))

    gap = np.zeros(int(TURN_GAP * sr), np.float32)
    words: list[dict] = []
    pending: list[tuple[str, float, float, list[dict], str | None]] = []
    meeting_langs: set[str] = set()
    for i, (spk, spans) in enumerate(by_spk.items()):
        if progress:
            progress(i + 1, len(by_spk))
        pieces, starts, ends, origins, pos = [], [], [], [], 0.0
        for s, e in spans:
            piece = samples[int(s * sr): int(e * sr)]
            starts.append(pos)
            ends.append(pos + len(piece) / sr)
            origins.append(s)
            pieces += [piece, gap]
            pos += (len(piece) + len(gap)) / sr
        stream = np.concatenate(pieces)
        result = _whisper(stream, glossary, language, word_timestamps=True)
        stream_lang = result.get("language")
        if stream_lang:
            meeting_langs.add(stream_lang)

        per_span: dict[int, list[dict]] = {}
        for w in _words(result["segments"]):
            mid = (w["start"] + w["end"]) / 2
            k = max(0, bisect.bisect_right(starts, mid) - 1)
            if mid > ends[k]:
                if k + 1 < len(starts) and starts[k + 1] - mid < mid - ends[k]:
                    k += 1
                elif k == len(starts) - 1 and mid - ends[k] > GAP_TOLERANCE:
                    continue
            shift = origins[k] - starts[k]
            lo, hi = origins[k], origins[k] + ends[k] - starts[k]
            per_span.setdefault(k, []).append({
                **w,
                "start": min(max(w["start"] + shift, lo), hi),
                "end": min(max(w["end"] + shift, lo), hi),
                "speaker": spk, "language": stream_lang,
            })

        for k, (s, e) in enumerate(spans):
            pending.append((spk, s, e, per_span.get(k, []), stream_lang))

    for spk, s, e, ws, stream_lang in pending:
        if e - s >= RECHECK_MIN_SECONDS and _suspicious(ws, glossary):
            candidates = [language] if language else \
                [None] + sorted(meeting_langs - {stream_lang})
            ws = _recheck(samples[int(s * sr): int(e * sr)], s, ws, spk, glossary, candidates)
        words.extend(ws)
    words.sort(key=lambda w: w["start"])
    return words


def _quality(ws: list[dict], glossary: Glossary) -> float:
    """Mean Whisper confidence, penalised by out-of-dictionary words.

    Words the dictionary can repair (berafa -> berapa) cost a quarter of an
    unrecoverable one, so a turn decoded in the right language wins even when
    a strong accent leaves small misspellings.
    """
    from .glossary import is_known

    if not ws:
        return 0.0
    prob = float(np.mean([w["probability"] for w in ws]))
    tokens = [w["word"].strip().strip(".,!?;:\"'()") for w in ws]
    tokens = [t for t in tokens if t.isalpha() and len(t) >= 3]
    penalty = 0.0
    for t in tokens:
        if not is_known(t):
            penalty += 0.25 if glossary.correctable(t) else 1.0
    return prob * (1 - penalty / max(len(tokens), 1))


def _suspicious(ws: list[dict], glossary: Glossary) -> bool:
    return _quality(ws, glossary) < RECHECK_QUALITY


def _recheck(piece: np.ndarray, origin: float, ws: list[dict], spk: str,
             glossary: Glossary, candidates: list[str | None]) -> list[dict]:
    """Re-transcribe one turn on its own, trying auto-detection and every other
    language heard in this meeting, and keep the most plausible result.

    Catches a speaker switching language mid-meeting (their stitched stream was
    decoded in their dominant language, and accents can fool auto-detection)
    and words lost at stream boundaries.
    """
    dur = len(piece) / config.SAMPLE_RATE
    best, best_q = ws, _quality(ws, glossary) + RECHECK_MARGIN
    for lang in candidates:
        result = _whisper(piece, glossary, lang, word_timestamps=True)
        fresh = [{**w, "start": min(w["start"] + origin, origin + dur),
                  "end": min(w["end"] + origin, origin + dur),
                  "speaker": spk, "language": result.get("language")}
                 for w in _words(result["segments"])]
        q = _quality(fresh, glossary)
        if q > best_q:
            best, best_q = fresh, q
    return best
