import json
import re
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from . import config

MATCH_THRESHOLD = 0.45
MERGE_THRESHOLD = 0.60
MIN_SEGMENT_FOR_EMBEDDING = 1.0
MAX_EMBEDDING_SECONDS = 90.0
REFINE_MIN_SECONDS = 1.0
REFINE_MARGIN = 0.08


@dataclass
class Turn:
    start: float
    end: float
    speaker: str


@lru_cache(maxsize=1)
def _extractor():
    import sherpa_onnx

    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(config.EMBEDDING_MODEL), num_threads=4
    )
    return sherpa_onnx.SpeakerEmbeddingExtractor(cfg)


def embed(samples: np.ndarray) -> np.ndarray:
    ex = _extractor()
    stream = ex.create_stream()
    stream.accept_waveform(sample_rate=config.SAMPLE_RATE, waveform=samples)
    stream.input_finished()
    v = np.asarray(ex.compute(stream), dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def _diarizer(num_speakers: int | None, threshold: float):
    import sherpa_onnx

    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(config.SEGMENTATION_MODEL)
            ),
            num_threads=4,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(config.EMBEDDING_MODEL), num_threads=4
        ),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=num_speakers or -1, threshold=threshold
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not cfg.validate():
        raise RuntimeError("Model diarization belum ada. Jalankan: notesy setup")
    return sherpa_onnx.OfflineSpeakerDiarization(cfg)


def diarize(samples: np.ndarray, num_speakers: int | None = None, threshold: float = 0.5,
            progress=None) -> list[Turn]:
    sd = _diarizer(num_speakers, threshold)

    def cb(done, total):
        if progress:
            progress(done, total)
        return 0

    result = sd.process(samples, callback=cb).sort_by_start_time()
    return [Turn(r.start, r.end, f"spk{r.speaker}") for r in result]


def centroids(samples: np.ndarray, turns: list[Turn]) -> dict[str, np.ndarray]:
    """One voiceprint per diarized speaker, built from its longest clean turns."""
    by_spk: dict[str, list[Turn]] = {}
    for t in turns:
        by_spk.setdefault(t.speaker, []).append(t)
    out = {}
    for spk, ts in by_spk.items():
        ts = sorted(ts, key=lambda t: t.end - t.start, reverse=True)
        usable = [t for t in ts if t.end - t.start >= MIN_SEGMENT_FOR_EMBEDDING] or ts[:1]
        vecs, weights, total = [], [], 0.0
        for t in usable:
            if total >= MAX_EMBEDDING_SECONDS:
                break
            chunk = samples[int(t.start * config.SAMPLE_RATE): int(t.end * config.SAMPLE_RATE)]
            if len(chunk) < config.SAMPLE_RATE * 0.5:
                continue
            vecs.append(embed(chunk))
            weights.append(t.end - t.start)
            total += t.end - t.start
        if vecs:
            v = np.average(np.stack(vecs), axis=0, weights=weights)
            out[spk] = v / (np.linalg.norm(v) + 1e-9)
    return out


# --- Voiceprint library -----------------------------------------------------

def _slug(name: str) -> str:
    return re.sub(r"[^\w\-]+", "_", name.strip()).strip("_") or "speaker"


def load_voiceprints() -> dict[str, np.ndarray]:
    prints = {}
    for meta in config.VOICEPRINTS.glob("*.json"):
        info = json.loads(meta.read_text())
        vec_path = meta.with_suffix(".npy")
        if vec_path.exists():
            samples = np.load(vec_path)
            v = samples.mean(axis=0)
            prints[info["name"]] = v / (np.linalg.norm(v) + 1e-9)
    return prints


def save_voiceprint(name: str, vector: np.ndarray) -> int:
    """Add a sample to a person's voiceprint; more samples => more robust matching."""
    config.ensure_dirs()
    base = config.VOICEPRINTS / _slug(name)
    vec_path = base.with_suffix(".npy")
    stack = np.load(vec_path) if vec_path.exists() else np.empty((0, len(vector)), np.float32)
    stack = np.vstack([stack, vector[None, :].astype(np.float32)])
    np.save(vec_path, stack)
    base.with_suffix(".json").write_text(json.dumps({"name": name, "samples": len(stack)}))
    return len(stack)


def delete_voiceprint(name: str) -> bool:
    base = config.VOICEPRINTS / _slug(name)
    found = False
    for ext in (".npy", ".json"):
        p = base.with_suffix(ext)
        if p.exists():
            p.unlink()
            found = True
    return found


def identify(cents: dict[str, np.ndarray], prints: dict[str, np.ndarray]) -> dict[str, dict]:
    """Map diarized speakers to enrolled names.

    Greedy one-to-one assignment by cosine similarity, then any leftover cluster
    that is clearly the same voice as an assigned person is merged into them
    (fixes the common over-splitting of one speaker into two clusters).
    """
    labels: dict[str, dict] = {}
    pairs = sorted(
        ((float(c @ p), spk, name) for spk, c in cents.items() for name, p in prints.items()),
        reverse=True,
    )
    used_names, used_spk = set(), set()
    for sim, spk, name in pairs:
        if sim < MATCH_THRESHOLD:
            break
        if spk in used_spk or name in used_names:
            continue
        labels[spk] = {"name": name, "confidence": round(sim, 3), "enrolled": True}
        used_spk.add(spk)
        used_names.add(name)

    for spk in cents:
        if spk in labels:
            continue
        best = max(((float(cents[spk] @ prints[n]), n) for n in used_names), default=None)
        if best and best[0] >= MERGE_THRESHOLD:
            labels[spk] = {"name": best[1], "confidence": round(best[0], 3), "enrolled": True}

    counter = 1
    for spk in sorted(cents, key=lambda s: int(s[3:])):
        if spk not in labels:
            labels[spk] = {"name": f"Pembicara {counter}", "confidence": None, "enrolled": False}
            counter += 1
    return labels


def refine_turns(samples: np.ndarray, turns: list[Turn], cents: dict[str, np.ndarray],
                 prints: dict[str, np.ndarray], labels: dict[str, dict]) -> tuple[list[Turn], int]:
    """Re-check every turn against the speaker references and move clear mismatches.

    Clustering decides on the whole meeting at once and can absorb a short turn
    into the wrong cluster (e.g. a speaker switching language or accent). Each
    turn is compared to enrolled voiceprints (or cluster centroids for unknown
    speakers) and reassigned only when another speaker is clearly closer.
    """
    refs = {spk: prints.get(info["name"], cents.get(spk)) for spk, info in labels.items()}
    refs = {k: v for k, v in refs.items() if v is not None}
    if len(refs) < 2:
        return turns, 0
    moved = 0
    out = []
    for t in turns:
        if t.end - t.start >= REFINE_MIN_SECONDS and t.speaker in refs:
            chunk = samples[int(t.start * config.SAMPLE_RATE): int(t.end * config.SAMPLE_RATE)]
            e = embed(chunk)
            sims = {spk: float(e @ r) for spk, r in refs.items()}
            best = max(sims, key=sims.get)
            if best != t.speaker and sims[best] - sims[t.speaker] >= REFINE_MARGIN \
                    and labels[best]["name"] != labels[t.speaker]["name"]:
                t = Turn(t.start, t.end, best)
                moved += 1
        out.append(t)
    return out, moved
