import re
from dataclasses import asdict, dataclass

from .classify import DECISION, QUESTION, STATEMENT, TASK, classify
from .glossary import Glossary

ANSWER_WINDOW = 45.0
REPEAT_WINDOW = 8.0
HALLUCINATION_CONFIDENCE = 0.45
_SENTENCE_END = re.compile(r"[.?!…]$")
_ABBREVIATIONS = {"dr.", "mr.", "mrs.", "ms.", "prof.", "ir.", "bpk.", "pak.", "bu.", "st.",
                  "no.", "vs.", "dll.", "dsb.", "tsb.", "yth.", "e.g.", "i.e.", "etc."}


@dataclass
class Item:
    speaker: str
    start: float
    end: float
    text: str
    kind: str = STATEMENT
    assignee: str | None = None
    due: str | None = None
    answered_by: str | None = None
    answer: str | None = None
    confidence: float = 1.0
    language: str | None = None


def fmt_time(seconds: float) -> str:
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def build_items(words: list[dict], names: dict[str, str]) -> list[Item]:
    """Group words into per-speaker sentences."""
    items: list[Item] = []
    cur: list[dict] = []

    def flush():
        if cur:
            text = "".join(w["word"] for w in cur).strip()
            conf = sum(w.get("probability", 1.0) for w in cur) / len(cur)
            hallucination = len(cur) <= 4 and conf < HALLUCINATION_CONFIDENCE
            if text and not hallucination:
                items.append(Item(names.get(cur[0]["speaker"], cur[0]["speaker"]),
                                  cur[0]["start"], cur[-1]["end"], text,
                                  confidence=round(conf, 3), language=cur[0].get("language")))
            cur.clear()

    for w in words:
        if cur and (w["speaker"] != cur[-1]["speaker"] or w["start"] - cur[-1]["end"] > 2.0):
            flush()
        cur.append(w)
        token = w["word"].strip()
        if _SENTENCE_END.search(token) and token.lower() not in _ABBREVIATIONS:
            flush()
    flush()
    return drop_repeats(items)


def _norm(text: str) -> str:
    return re.sub(r"[^\w\s]", "", text.lower()).strip()


def drop_repeats(items: list[Item]) -> list[Item]:
    """Remove Whisper's looped repetitions: a sentence that only re-says what the
    same speaker said moments before."""
    from rapidfuzz import fuzz

    out: list[Item] = []
    for it in items:
        text = _norm(it.text)
        recent = [p for p in out[-4:] if p.speaker == it.speaker and it.start - p.end <= REPEAT_WINDOW]
        if len(text.split()) >= 2 and any(
            fuzz.partial_ratio(text, _norm(p.text)) >= 92 and len(text) <= len(_norm(p.text))
            for p in recent
        ):
            continue
        out.append(it)
    return out


def annotate(items: list[Item], glossary: Glossary) -> list[Item]:
    speakers = sorted({i.speaker for i in items})
    for it in items:
        others = [s for s in speakers if s != it.speaker]
        label = classify(it.text, it.speaker, glossary.people, others)
        it.kind, it.assignee, it.due = label.kind, label.assignee, label.due

    for idx, it in enumerate(items):
        if it.kind != QUESTION:
            continue
        reply = []
        for nxt in items[idx + 1:]:
            if nxt.start - it.end > ANSWER_WINDOW:
                break
            if nxt.speaker == it.speaker:
                if reply:
                    break
                continue
            if reply and nxt.speaker != reply[0].speaker:
                break
            reply.append(nxt)
            if len(reply) >= 2:
                break
        if reply:
            it.answered_by = reply[0].speaker
            it.answer = " ".join(r.text for r in reply)
    return items


def speaker_stats(items: list[Item]) -> list[tuple[str, float, int, float]]:
    totals: dict[str, list[float]] = {}
    for it in items:
        t = totals.setdefault(it.speaker, [0.0, 0])
        t[0] += it.end - it.start
        t[1] += len(it.text.split())
    grand = sum(v[0] for v in totals.values()) or 1.0
    return sorted(
        ((s, v[0], int(v[1]), 100 * v[0] / grand) for s, v in totals.items()),
        key=lambda x: -x[1],
    )


_TAG = {QUESTION: " `?`", TASK: " `TUGAS`", DECISION: " `KEPUTUSAN`", STATEMENT: ""}


def render_markdown(title: str, items: list[Item], duration: float, speakers: dict[str, dict],
                    glossary: Glossary, corrections: list[dict]) -> str:
    tasks = [i for i in items if i.kind == TASK]
    decisions = [i for i in items if i.kind == DECISION]
    questions = [i for i in items if i.kind == QUESTION]
    full_text = " ".join(i.text for i in items)

    L = [f"# {title}", ""]
    L.append(f"- Durasi: {fmt_time(duration)}")
    L.append(f"- Pembicara: {', '.join(s for s, *_ in speaker_stats(items)) or '-'}")
    L.append(f"- {len(tasks)} tugas, {len(decisions)} keputusan, {len(questions)} pertanyaan")
    L.append("")

    L.append("## Tugas")
    if tasks:
        for t in tasks:
            who = f"**{t.assignee}**: " if t.assignee else ""
            due = f" _(tenggat: {t.due})_" if t.due else ""
            L.append(f"- [ ] {who}{t.text}{due} — oleh {t.speaker} [{fmt_time(t.start)}]")
    else:
        L.append("_Tidak ada tugas terdeteksi._")
    L.append("")

    L.append("## Keputusan")
    if decisions:
        L += [f"- {d.text} — {d.speaker} [{fmt_time(d.start)}]" for d in decisions]
    else:
        L.append("_Tidak ada keputusan terdeteksi._")
    L.append("")

    L.append("## Pertanyaan")
    if questions:
        for q in questions:
            L.append(f"- **{q.speaker}** [{fmt_time(q.start)}]: {q.text}")
            if q.answered_by:
                L.append(f"  - Dijawab **{q.answered_by}**: {q.answer}")
            else:
                L.append("  - _Belum terjawab di rapat ini._")
    else:
        L.append("_Tidak ada pertanyaan terdeteksi._")
    L.append("")

    L.append("## Pembicara")
    L.append("| Pembicara | Waktu bicara | Porsi | Kata | Identifikasi |")
    L.append("|---|---|---|---|---|")
    by_name = {v["name"]: v for v in speakers.values()}
    for name, secs, nwords, pct in speaker_stats(items):
        info = by_name.get(name, {})
        ident = (f"voiceprint ({info['confidence']:.2f})" if info.get("enrolled")
                 else "belum dikenal — `notesy name`")
        L.append(f"| {name} | {fmt_time(secs)} | {pct:.0f}% | {nwords} | {ident} |")
    L.append("")

    abbr = glossary.abbreviations_in(full_text)
    if abbr:
        L.append("## Singkatan")
        L += [f"- **{k}**: {v}" for k, v in abbr.items()]
        L.append("")

    if corrections:
        L.append("## Koreksi kamus")
        seen = set()
        for c in corrections:
            key = (c["from"], c["to"])
            if key not in seen:
                seen.add(key)
                L.append(f"- \"{c['from']}\" → **{c['to']}**")
        L.append("")

    L.append("## Transkrip")
    prev = None
    for it in items:
        if it.speaker != prev:
            L.append("")
            L.append(f"**{it.speaker}** [{fmt_time(it.start)}]")
            prev = it.speaker
        L.append(f"{it.text}{_TAG[it.kind]}")
    L.append("")
    return "\n".join(L)


def items_to_json(items: list[Item]) -> list[dict]:
    return [asdict(i) for i in items]
