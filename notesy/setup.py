import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path

from . import config


def _download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  sudah ada: {dest.name}")
        return
    print(f"  mengunduh {dest.name} ...")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.rename(dest)


SYSTEM_WORDS = {"en": Path("/usr/share/dict/words")}


def _parse_hunspell(dic: Path, out: Path, extra: Path | None = None) -> int:
    words = set()
    lines = dic.read_text(encoding="utf-8", errors="ignore").splitlines()
    for line in lines[1:]:
        w = line.split("/", 1)[0].strip().lower()
        if w and not w.startswith("#"):
            words.add(w)
    if extra and extra.exists():
        words.update(w.strip().lower() for w in extra.read_text(errors="ignore").splitlines() if w.strip())
    out.write_text("\n".join(sorted(words)), encoding="utf-8")
    return len(words)


def run(skip_whisper: bool = False) -> None:
    config.ensure_dirs()

    print("[1/4] Model segmentasi pembicara (pyannote 3.0, ONNX)")
    archive = config.MODELS / "segmentation.tar.bz2"
    if not config.SEGMENTATION_MODEL.exists():
        _download(config.SEGMENTATION_URL, archive)
        with tarfile.open(archive) as t:
            t.extractall(config.MODELS, filter="data")
        archive.unlink()
    else:
        print("  sudah ada")

    print("[2/4] Model voiceprint pembicara (WeSpeaker ResNet34)")
    _download(config.EMBEDDING_URL, config.EMBEDDING_MODEL)

    print("[3/4] Kamus offline (Indonesia + Inggris)")
    for lang, url in config.DICTIONARY_URLS.items():
        raw = config.DICTS / f"{lang}.dic"
        _download(url, raw)
        n = _parse_hunspell(raw, config.DICTS / f"{lang}.txt", SYSTEM_WORDS.get(lang))
        print(f"  {lang}: {n:,} kata")

    print("[4/4] Model transkripsi Whisper large-v3-turbo (MLX, ~1.6 GB)")
    if skip_whisper:
        print("  dilewati")
    else:
        from huggingface_hub import snapshot_download

        snapshot_download(config.WHISPER_MODEL)
        print("  siap")

    if not shutil.which("ffmpeg"):
        print("PERINGATAN: ffmpeg tidak ditemukan. Jalankan: brew install ffmpeg")
    if not config.ANARLOG_CLI.exists():
        print("PERINGATAN: anarlog CLI belum terpasang di ~/.local/bin/anarlog")
    else:
        subprocess.run([str(config.ANARLOG_CLI), "--version"], check=False)

    print(f"\nSelesai. Kamus custom: {config.GLOSSARY}")
