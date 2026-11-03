"""End-to-end test: synthetic code-switched meeting (WHO x Indonesia, forest fires).

Generates multi-voice audio with macOS `say`, runs the real Notesy pipeline in an
isolated NOTESY_HOME, and scores the output against the script line by line.

    .venv/bin/python tests/simulate_meeting.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "output"
HOME = WORK / "notesy-home"
SR = 16000

VOICES = {
    "Dr. Sarah": "Samantha",
    "Ibu Damayanti": "Damayanti",
    "Dr. Rishi": "Rishi",
}

# (speaker, text, mode, expected kinds per sentence)
# mode: en = English, id = Indonesian, mix = Indonesian with English inserted
SCRIPT = [
    ("Dr. Sarah", "Good morning everyone, and thank you for joining this coordination call on the forest fires in Riau and Central Kalimantan.", "en"),
    ("Ibu Damayanti", "Selamat pagi, Doctor Sarah. Terima kasih sudah join meeting ini. Situasinya cukup critical, karena jumlah hotspot naik hampir tiga kali lipat dalam satu minggu.", "mix"),
    ("Dr. Sarah", "That is very concerning. What is the current air quality index in Pekanbaru?", "en"),
    ("Ibu Damayanti", "Kemarin index PM 2.5 di Pekanbaru sudah di atas tiga ratus, jadi masuk kategori hazardous. Sekolah-sekolah sudah kami liburkan sejak hari Senin.", "mix"),
    ("Dr. Rishi", "From the regional office, we can deploy additional N95 masks. How many do you need for the first week?", "en"),
    ("Ibu Damayanti", "Kami butuh sekitar dua ratus ribu masker. Tolong prioritaskan untuk anak-anak, ibu hamil, dan lansia, because they are the most vulnerable group.", "mix"),
    ("Dr. Rishi", "Understood. I will submit the procurement request to Geneva by Thursday.", "en"),
    ("Dr. Sarah", "Ibu, berapa jumlah kasus ISPA minggu ini?", "id"),
    ("Ibu Damayanti", "Sampai kemarin ada sekitar lima belas ribu kasus ISPA. Most of them are children under five. Puskesmas kami sudah overloaded.", "mix"),
    ("Dr. Sarah", "Then we should set up temporary clean air shelters near the most affected districts.", "en"),
    ("Ibu Damayanti", "Setuju. Jadi kita putuskan untuk membuka lima clean air shelter di Pekanbaru dan Palangka Raya mulai minggu depan.", "mix"),
    ("Dr. Rishi", "Do you have enough medical staff to run the shelters?", "en"),
    ("Ibu Damayanti", "Honestly, not yet. Kami masih kekurangan perawat. Bisa tidak WHO bantu kirim technical experts untuk training?", "mix"),
    ("Dr. Sarah", "Yes, we can. I will coordinate with the emergency team and send two experts next Monday.", "en"),
    ("Dr. Rishi", "One more thing. We need daily surveillance data to monitor the trend.", "en"),
    ("Ibu Damayanti", "Oke, nanti saya kirim dashboard data harian setiap jam lima sore. Rishi, tolong share template reporting-nya hari ini ya.", "mix"),
    ("Dr. Rishi", "Sure, I will share the template this afternoon. Terima kasih, Ibu.", "en"),
    ("Dr. Sarah", "Great. Let's meet again on Friday to review progress. Thank you all.", "en"),
]

ENROLL = {
    "Dr. Sarah": "Hello, this is Sarah from the World Health Organization. I am recording this short sample so the meeting assistant can recognise my voice automatically.",
    "Ibu Damayanti": "Halo, saya Damayanti dari Kementerian Kesehatan. Ini contoh suara saya supaya aplikasi bisa mengenali saya secara otomatis di setiap rapat.",
    "Dr. Rishi": "Hi, I am Rishi from the regional office. This is a sample of my voice for automatic speaker recognition in our meetings.",
}

GLOSSARY = """\
terms:
  - term: WHO
  - term: PM2.5
    aliases: ["pm 2.5", "pm 2,5", "pm2,5"]
  - term: ISPA
  - term: N95
  - term: Puskesmas
  - term: Pekanbaru
  - term: Palangka Raya
  - term: Riau
  - term: Central Kalimantan
  - term: hotspot
  - term: clean air shelter
people: [Sarah, Rishi, Damayanti]
abbreviations:
  ISPA: infeksi saluran pernapasan akut
  WHO: World Health Organization
  PM2.5: partikel debu berdiameter di bawah 2,5 mikrometer
"""

EN_STOP = set("the a an is are was were be to of and for in on with that this they we you i it "
              "will can do does have has not yet most them under from by our more one need "
              "what how many enough run then should near let's again all thank yes sure".split())
ID_STOP = set("yang di dan ini itu kami kita sudah untuk ada jadi karena dengan saya belum masih "
              "sampai sekitar butuh tolong berapa jumlah kasus minggu kemarin mulai nanti setiap "
              "hari bisa tidak bantu kirim terima kasih ibu".split())


def tts(voice: str, text: str, tmp: Path, name: str) -> np.ndarray:
    aiff = tmp / f"{name}.aiff"
    wav = tmp / f"{name}.wav"
    subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(aiff), "-ar", str(SR), "-ac", "1", str(wav)],
                   check=True)
    data, _ = sf.read(wav, dtype="float32")
    return data


def build_audio() -> tuple[Path, list[dict], dict[str, Path]]:
    WORK.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp())
    rng = np.random.default_rng(7)
    pieces, truth, t = [], [], 0.0
    for i, (spk, text, mode) in enumerate(SCRIPT):
        audio = tts(VOICES[spk], text, tmp, f"l{i}")
        gap = np.zeros(int(rng.uniform(0.5, 1.1) * SR), np.float32)
        truth.append({"speaker": spk, "text": text, "mode": mode,
                      "start": t, "end": t + len(audio) / SR})
        pieces += [audio, gap]
        t += (len(audio) + len(gap)) / SR
    meeting = np.concatenate(pieces)
    meeting += rng.normal(0, 0.003, len(meeting)).astype(np.float32)
    path = WORK / "meeting_karhutla.wav"
    sf.write(path, meeting, SR)

    enroll = {}
    for spk, text in ENROLL.items():
        p = WORK / f"enroll_{VOICES[spk]}.wav"
        sf.write(p, tts(VOICES[spk], text, tmp, f"e_{VOICES[spk]}"), SR)
        enroll[spk] = p
    shutil.rmtree(tmp)
    (WORK / "ground_truth.json").write_text(json.dumps(truth, indent=1, ensure_ascii=False))
    return path, truth, enroll


def prepare_home() -> None:
    if HOME.exists():
        shutil.rmtree(HOME)
    HOME.mkdir(parents=True)
    real = Path.home() / ".notesy"
    for sub in ("models", "dictionaries"):
        (HOME / sub).symlink_to(real / sub)
    (HOME / "glossary.yaml").write_text(GLOSSARY)


def norm(text: str) -> list[str]:
    text = text.lower().replace("-", " ")
    return re.findall(r"[a-z0-9]+(?:[.,][0-9]+)?", text)


def wer(ref: list[str], hyp: list[str]) -> float:
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
            prev, d[j] = d[j], cur
    return d[len(hyp)] / max(len(ref), 1)


def en_share(tokens: list[str]) -> float:
    en = sum(t in EN_STOP for t in tokens)
    idn = sum(t in ID_STOP for t in tokens)
    return en / max(en + idn, 1)


def evaluate(truth: list[dict], result: dict) -> str:
    items = result["items"]
    rows, spk_ok, wers, lang_ok = [], 0, [], 0
    for g in truth:
        hits = [it for it in items if g["start"] - 0.4 <= (it["start"] + it["end"]) / 2 <= g["end"] + 0.4]
        hyp = " ".join(it["text"] for it in hits)
        dur: dict[str, float] = {}
        for it in hits:
            dur[it["speaker"]] = dur.get(it["speaker"], 0) + it["end"] - it["start"]
        got_spk = max(dur, key=dur.get) if dur else "-"
        ok = got_spk == g["speaker"]
        spk_ok += ok
        w = wer(norm(g["text"]), norm(hyp))
        wers.append(w)
        ref_en, hyp_en = en_share(norm(g["text"])), en_share(norm(hyp))
        preserved = abs(ref_en - hyp_en) <= 0.35
        lang_ok += preserved
        rows.append((g, hyp, got_spk, ok, w, preserved, hits))

    n = len(truth)
    by_mode: dict[str, list[float]] = {}
    for g, _hyp, _spk, _ok, w, _p, _h in rows:
        by_mode.setdefault(g["mode"], []).append(w)

    L = ["# Hasil uji Notesy: rapat karhutla WHO x Indonesia (code-switching)", ""]
    L.append(f"- Durasi audio: {truth[-1]['end']:.0f} detik, {n} giliran bicara, 3 pembicara")
    L.append(f"- Ketepatan pembicara: **{spk_ok}/{n} ({100 * spk_ok / n:.0f}%)**")
    L.append(f"- Bahasa tidak diterjemahkan: **{lang_ok}/{n} ({100 * lang_ok / n:.0f}%)**")
    L.append(f"- Word error rate rata-rata: **{100 * np.mean(wers):.1f}%** "
             f"(akurasi kata ~{100 - 100 * np.mean(wers):.0f}%)")
    for mode, label in (("en", "Inggris"), ("id", "Indonesia"), ("mix", "Campuran")):
        if mode in by_mode:
            L.append(f"  - {label}: WER {100 * np.mean(by_mode[mode]):.1f}% ({len(by_mode[mode])} giliran)")
    L.append("")
    L.append("## Perbandingan per giliran")
    for i, (g, hyp, got_spk, ok, w, preserved, hits) in enumerate(rows, 1):
        kinds = ", ".join(sorted({h["kind"] for h in hits if h["kind"] != "pernyataan"})) or "pernyataan"
        L.append(f"### {i}. {g['speaker']} ({g['mode']})")
        L.append(f"- Naskah  : {g['text']}")
        L.append(f"- Notesy  : {hyp or '(kosong)'}")
        L.append(f"- Pembicara: {got_spk} {'✓' if ok else '✗'} | WER {100 * w:.0f}% | "
                 f"bahasa {'utuh ✓' if preserved else 'BERUBAH ✗'} | label: {kinds}")
        L.append("")
    return "\n".join(L)


def main() -> None:
    print("Membuat audio rapat ...")
    audio, truth, enroll = build_audio()
    prepare_home()
    env = {**os.environ, "NOTESY_HOME": str(HOME), "HF_HUB_OFFLINE": "1"}
    notesy = str(Path(sys.executable).parent / "notesy")
    for spk, p in enroll.items():
        subprocess.run([notesy, "enroll", spk, "--file", str(p)], env=env, check=True)
    subprocess.run([notesy, "process", str(audio), "--title", "Koordinasi Karhutla WHO x Kemenkes"],
                   env=env, check=True)
    notes_dir = HOME / "notes"
    result_json = max(notes_dir.glob("*.json"), key=lambda p: p.stat().st_mtime)
    report = evaluate(truth, json.loads(result_json.read_text()))
    (WORK / "report.md").write_text(report, encoding="utf-8")
    shutil.copy(result_json.with_suffix(".md"), WORK / "notes.md")
    print(report)
    print(f"\nCatatan aplikasi: {WORK / 'notes.md'}\nLaporan uji    : {WORK / 'report.md'}")


if __name__ == "__main__":
    main()
