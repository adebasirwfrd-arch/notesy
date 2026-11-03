import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from . import audio, config, diarize, notes, transcribe
from .glossary import Glossary


def _log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def process(path: Path, title: str | None = None, num_speakers: int | None = None,
            language: str | None = None, out_dir: Path | None = None) -> tuple[Path, Path]:
    config.ensure_dirs()
    glossary = Glossary.load()
    out_dir = out_dir or config.OUTPUT
    out_dir.mkdir(parents=True, exist_ok=True)
    title = title or path.stem
    t0 = time.time()

    _log(f"Memuat audio {path.name}")
    samples = audio.load(path)
    duration = len(samples) / config.SAMPLE_RATE
    _log(f"Durasi {notes.fmt_time(duration)}")

    _log("Memisahkan pembicara (diarization)")
    last = [0.0]

    def progress(done, total):
        if time.time() - last[0] > 5:
            last[0] = time.time()
            _log(f"  diarization {100 * done / max(total, 1):.0f}%")

    turns = diarize.diarize(samples, num_speakers=num_speakers, progress=progress)
    cents = diarize.centroids(samples, turns)
    prints = diarize.load_voiceprints()
    speakers = diarize.identify(cents, prints)
    _log("  " + ", ".join(f"{k}→{v['name']}" for k, v in speakers.items()))
    turns, moved = diarize.refine_turns(samples, turns, cents, prints, speakers)
    if moved:
        _log(f"  {moved} giliran bicara dipindahkan ke pembicara yang lebih cocok")

    _log("Transkripsi per pembicara (Whisper large-v3-turbo, lokal)")
    last[0] = 0.0

    def tprogress(done, total):
        if time.time() - last[0] > 5:
            last[0] = time.time()
            _log(f"  transkripsi pembicara {done}/{total}")

    words = transcribe.transcribe_turns(samples, turns, glossary, language=language,
                                        progress=tprogress)
    words = glossary.correct_words(words)
    corrections = [{"from": w["corrected_from"], "to": w["word"].strip(" .,!?;:")}
                   for w in words if "corrected_from" in w]

    names = {k: v["name"] for k, v in speakers.items()}
    items = notes.build_items(words, names)
    for it in items:
        it.text = glossary.correct_text(it.text)
    items = notes.annotate(items, glossary)

    md = notes.render_markdown(title, items, duration, speakers, glossary, corrections)
    stem = f"{datetime.now():%Y%m%d-%H%M}-{_safe(title)}"
    md_path = out_dir / f"{stem}.md"
    json_path = out_dir / f"{stem}.json"
    md_path.write_text(md, encoding="utf-8")
    json_path.write_text(json.dumps({
        "title": title,
        "source": str(path),
        "duration": duration,
        "speakers": speakers,
        "centroids": {k: v.tolist() for k, v in cents.items()},
        "corrections": corrections,
        "items": notes.items_to_json(items),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    _log(f"Selesai dalam {time.time() - t0:.0f} detik")
    return md_path, json_path


def rename_speaker(json_path: Path, label: str, name: str) -> Path:
    """Teach a voiceprint from a processed meeting and re-render its notes."""
    data = json.loads(json_path.read_text())
    spk = next((k for k, v in data["speakers"].items() if v["name"] == label or k == label), None)
    if spk is None:
        raise SystemExit(f"Label '{label}' tidak ada. Pilihan: "
                         + ", ".join(v["name"] for v in data["speakers"].values()))
    old = data["speakers"][spk]["name"]
    n = diarize.save_voiceprint(name, np.asarray(data["centroids"][spk], dtype=np.float32))
    data["speakers"][spk] = {"name": name, "confidence": 1.0, "enrolled": True}

    glossary = Glossary.load()
    items = [notes.Item(**i) for i in data["items"]]
    for it in items:
        if it.speaker == old:
            it.speaker = name
        if it.assignee == old:
            it.assignee = name
        if it.answered_by == old:
            it.answered_by = name
    items = notes.annotate(items, glossary)
    data["items"] = notes.items_to_json(items)
    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    md = notes.render_markdown(data["title"], items, data["duration"], data["speakers"],
                               glossary, data.get("corrections", []))
    md_path = json_path.with_suffix(".md")
    md_path.write_text(md, encoding="utf-8")
    print(f"'{old}' sekarang '{name}' (voiceprint: {n} sampel). Rapat berikutnya dikenali otomatis.")
    return md_path


def _safe(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in s)[:60].strip("-") or "rapat"
