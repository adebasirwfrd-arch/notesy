import os
from pathlib import Path

HOME = Path(os.environ.get("NOTESY_HOME", Path.home() / ".notesy")).expanduser()
MODELS = HOME / "models"
DICTS = HOME / "dictionaries"
VOICEPRINTS = HOME / "voiceprints"
OUTPUT = HOME / "notes"
GLOSSARY = HOME / "glossary.yaml"

ANARLOG_CLI = Path.home() / ".local" / "bin" / "anarlog"
ANARLOG_BASE = Path(os.environ.get("ANARLOG_BASE", Path.home() / "Library" / "Application Support" / "anarlog"))

WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
SAMPLE_RATE = 16000

SEGMENTATION_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
SEGMENTATION_MODEL = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"

EMBEDDING_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx"
)
EMBEDDING_MODEL = MODELS / "wespeaker_en_voxceleb_resnet34_LM.onnx"

DICTIONARY_URLS = {
    "id": "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/id/id_ID.dic",
    "en": "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_US.dic",
}

DEFAULT_GLOSSARY = """\
# Kamus custom Notesy.
# terms   : istilah yang harus selalu dieja persis seperti ini.
#           aliases = cara salah dengar yang sering muncul dari transkripsi.
# people  : nama orang; dipakai untuk ejaan dan untuk mendeteksi siapa yang diberi tugas.
# abbreviations : singkatan dan kepanjangannya (ditampilkan di catatan).

terms:
  - term: Anarlog
    aliases: [anar log, analog app]
  - term: Notesy
    aliases: [notes see, notsi]

people: []

abbreviations:
  PIC: person in charge
  EOD: end of day
  KPI: key performance indicator
"""


def ensure_dirs() -> None:
    for d in (HOME, MODELS, DICTS, VOICEPRINTS, OUTPUT):
        d.mkdir(parents=True, exist_ok=True)
    if not GLOSSARY.exists():
        GLOSSARY.write_text(DEFAULT_GLOSSARY)
