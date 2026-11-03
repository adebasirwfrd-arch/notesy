import json
import subprocess
from pathlib import Path

from . import config

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".ogg", ".opus", ".flac", ".webm", ".aac", ".mp4"}


def _run(*args: str) -> dict:
    if not config.ANARLOG_CLI.exists():
        raise RuntimeError("anarlog CLI tidak ditemukan di ~/.local/bin/anarlog")
    out = subprocess.run([str(config.ANARLOG_CLI), "--json", *args],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip())
    return json.loads(out.stdout)


def list_meetings(query: str | None = None, limit: int = 20) -> list[dict]:
    args = ["meetings", "--source", "local", "list", "--limit", str(limit)]
    if query:
        args += ["--query", query]
    return _run(*args).get("data") or []


def get_meeting(meeting_id: str) -> dict:
    return _run("meetings", "get", meeting_id).get("data") or {}


def _audio_paths(obj) -> list[Path]:
    found = []
    if isinstance(obj, dict):
        for v in obj.values():
            found += _audio_paths(v)
    elif isinstance(obj, list):
        for v in obj:
            found += _audio_paths(v)
    elif isinstance(obj, str) and Path(obj).suffix.lower() in AUDIO_EXTS:
        p = Path(obj).expanduser()
        if p.is_file():
            found.append(p)
    return found


def find_recording(meeting_id: str) -> Path | None:
    session = config.ANARLOG_BASE / "sessions" / meeting_id
    if session.is_dir():
        audio = [p for p in session.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS]
        if audio:
            return max(audio, key=lambda p: p.stat().st_size)
    for args in (("meetings", "export", meeting_id, "--format", "json"),
                 ("meetings", "get", meeting_id)):
        try:
            paths = _audio_paths(_run(*args))
        except Exception:
            continue
        if paths:
            return max(paths, key=lambda p: p.stat().st_size)
    return None


def propose_memo(meeting_id: str, markdown_file: Path) -> dict:
    return _run("proposals", "create", "--meeting", meeting_id, "--kind", "memo",
                "--content-file", str(markdown_file))
