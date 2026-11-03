import re
from dataclasses import dataclass

QUESTION = "pertanyaan"
TASK = "tugas"
DECISION = "keputusan"
STATEMENT = "pernyataan"

_QUESTION_START = re.compile(
    r"^(apa|apakah|bagaimana|gimana|gmn|kenapa|mengapa|kok|kapan|siapa|di ?mana|ke ?mana|"
    r"dari ?mana|berapa|yang mana|mana|bisakah|bolehkah|haruskah|maukah|sudahkah|"
    r"what|why|how|when|who|whom|whose|where|which|is|are|was|were|do|does|did|can|could|"
    r"would|will|should|shall|may|have|has)\b",
    re.IGNORECASE,
)
_TASK = re.compile(
    r"\b(tolong|mohon|minta|harus|perlu|wajib|jangan lupa|pastikan|segera|"
    r"nanti (saya|aku|gue|gw|kita|kamu|kami)|(saya|aku|gue|gw|kita|kami) (akan|mau|bakal|siap)|"
    r"akan (saya|aku|kami|kita)|biar (saya|aku|kami)|"
    r"deadline|tenggat|paling lambat|sebelum (hari|tanggal|jam|minggu|bulan|meeting|rapat)|"
    r"follow ?up|action item|to ?do|tindak lanjut|ditindaklanjuti|"
    r"i will|i'll|we will|we'll|let's|need to|needs to|have to|has to|must|should|please|"
    r"can you|could you|make sure|assign(ed)? to|take care of|"
    r"bisa (tidak |nggak |gak |ga )?(\w+ )?(bantu|kirim|cek|siapkan|buat|share)|minta tolong)\b",
    re.IGNORECASE,
)
_DECISION = re.compile(
    r"\b(kita putuskan|diputuskan|memutuskan|keputusannya|sepakat|disepakati|setuju|"
    r"deal|fix(nya)? (pakai|pake|kita)|final(nya)?|jadi kita (pakai|pake|ambil|pilih)|"
    r"kita (pakai|pake|ambil|pilih) (yang|opsi)|decided|agreed|let's go with|we'll go with|final decision)\b",
    re.IGNORECASE,
)

_FIRST_PERSON = re.compile(r"\b(saya|aku|gue|gw|i|i'll|biar saya|akan saya)\b", re.IGNORECASE)
_WE = re.compile(r"\b(kita|kami|we|we'll|let's)\b", re.IGNORECASE)
_YOU = re.compile(r"\b(kamu|anda|lo|lu|kalian|mas|mbak|bang|you)\b", re.IGNORECASE)
_REQUEST = re.compile(r"\b(tolong|mohon|bisa|please|can you|could you)\b", re.IGNORECASE)

_DAYS = r"senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|monday|tuesday|wednesday|thursday|friday|saturday|sunday"
_MONTHS = (r"januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|"
           r"jan|feb|mar|apr|jun|jul|agu|aug|sep|okt|oct|nov|des|dec")
_DUE = re.compile(
    rf"\b(hari ini|besok( pagi| siang| sore| malam)?|lusa|nanti (sore|malam|siang)|"
    rf"minggu depan|pekan depan|bulan depan|akhir (minggu|pekan|bulan|hari)|"
    rf"(hari )?({_DAYS})( depan| ini)?|"
    rf"tanggal \d{{1,2}}( ({_MONTHS}))?|\d{{1,2}} ({_MONTHS})|"
    rf"jam \d{{1,2}}([.:]\d{{2}})?( (pagi|siang|sore|malam))?|"
    rf"(sebelum|paling lambat|maksimal|max|by|before) [\w\s:.']{{2,25}}?(?=[,.!?]|$)|"
    rf"today|tomorrow|tonight|next week|next month|this week|end of (day|week|month)|eod|eow|asap)\b",
    re.IGNORECASE,
)


@dataclass
class Label:
    kind: str
    assignee: str | None = None
    due: str | None = None


def _is_question(text: str) -> bool:
    t = text.strip()
    if t.endswith("?"):
        return True
    return bool(_QUESTION_START.match(t)) and len(t.split()) <= 25 and not t.endswith(".")


_TITLES = {"dr", "dr.", "prof", "prof.", "ibu", "bu", "bapak", "pak", "mas", "mbak", "mr", "mr.",
           "mrs", "mrs.", "ms", "ms.", "ir", "ir.", "kak", "bang"}


def _name_tokens(name: str) -> list[str]:
    return [t for t in name.split() if t.lower() not in _TITLES and len(t) >= 3]


def _mentioned(name: str, text: str) -> bool:
    return any(re.search(rf"(?<!\w){re.escape(t)}(?!\w)", text, re.IGNORECASE)
               for t in _name_tokens(name))


def _assignee(text: str, speaker: str, people: list[str], others: list[str]) -> str | None:
    for name in others:
        if not name.startswith("Pembicara") and _mentioned(name, text):
            return name
    for name in people:
        if _mentioned(name, text) and not _mentioned(name, speaker):
            participant = next((o for o in others if set(_name_tokens(name)) & set(_name_tokens(o))), None)
            return participant or name
    if _FIRST_PERSON.search(text) and not _YOU.search(text):
        return speaker
    if _WE.search(text):
        return "Tim"
    if _YOU.search(text) or _REQUEST.search(text):
        return "lawan bicara"
    return None


def classify(text: str, speaker: str, people: list[str], others: list[str]) -> Label:
    t = text.strip()
    if not t:
        return Label(STATEMENT)
    due_match = _DUE.search(t)
    due = due_match.group(0).strip() if due_match else None

    if _DECISION.search(t) and not t.endswith("?") and len(t.split()) >= 3:
        return Label(DECISION, due=due)
    is_task = bool(_TASK.search(t)) or (due is not None and _FIRST_PERSON.search(t) is not None)
    if is_task:
        request_question = t.endswith("?") and re.search(
            r"\b(bisa|tolong|can you|could you|please|mohon)\b", t, re.IGNORECASE
        )
        if not t.endswith("?") or request_question:
            return Label(TASK, assignee=_assignee(t, speaker, people, others), due=due)
    if _is_question(t):
        return Label(QUESTION)
    return Label(STATEMENT)
