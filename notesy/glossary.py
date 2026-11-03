import re
import sys
from dataclasses import dataclass, field
from functools import lru_cache

import yaml
from rapidfuzz import fuzz, process
from rapidfuzz.distance import Levenshtein

from . import config

LOW_CONFIDENCE = 0.6
FUZZY_MIN_SCORE = 86
OOV_MIN_SCORE = 80
OOV_ANY_INITIAL_SCORE = 88
PROMPT_MAX_CHARS = 600

_PREFIXES = ("meng", "meny", "mem", "men", "me", "peng", "peny", "pem", "pen", "pe",
             "ber", "be", "ter", "per", "di", "ke", "se")
_ID_SUFFIXES = ("nya", "kan", "lah", "kah", "pun", "an", "i")
_EN_SUFFIXES = ("s", "es", "ed", "d", "ing", "ly", "er")
_CLITICS = {"nya", "lah", "kah", "pun", "ku", "mu"}


@lru_cache(maxsize=None)
def _lang_words(lang: str) -> frozenset[str]:
    path = config.DICTS / f"{lang}.txt"
    return frozenset(path.read_text(encoding="utf-8").split()) if path.exists() else frozenset()


@lru_cache(maxsize=1)
def wordlist() -> frozenset[str]:
    words: set[str] = set()
    for lang in config.DICTIONARY_URLS:
        words.update(_lang_words(lang))
    return frozenset(words)


@lru_cache(maxsize=1)
def _by_initial() -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for w in wordlist():
        if w.isalpha() and len(w) >= 3:
            index.setdefault(w[0], []).append(w)
    return index


def is_known(word: str) -> bool:
    """Dictionary lookup that understands Indonesian/English affixes and reduplication."""
    known = wordlist()
    w = word.lower()
    if not known or w in known or not w.isalpha() and "-" not in w:
        return True
    if "-" in w:
        return all(is_known(p) for p in w.split("-") if p and p not in _CLITICS)

    en = _lang_words("en")
    if any(w.endswith(s) and w[: -len(s)] in en for s in _EN_SUFFIXES if len(w) - len(s) >= 3):
        return True

    idn = _lang_words("id")
    stems = {w}
    for s in _ID_SUFFIXES:
        if w.endswith(s) and len(w) - len(s) >= 4:
            stems.add(w[: -len(s)])
    for stem in list(stems):
        for p in _PREFIXES:
            if stem.startswith(p) and len(stem) - len(p) >= 4:
                rest = stem[len(p):]
                stems.update({rest, "k" + rest, "p" + rest, "t" + rest, "s" + rest})
    return any(s in idn for s in stems)


_VOWELS = set("aeiou")
_SOUND_ALIKE = [set("fpv"), set("ckq"), set("sz"), set("dt"), set("bp"), set("gk"), set("jy")]


def _mishearing_rank(src: str, dst: str) -> int:
    """How typical the single edit between two words is as a mishearing.

    0: vowel swap (accents shift vowels: berape/berapa), 1: dropped h or doubled
    letter (jumla/jumlah, kassus/kasus), 2: similar consonants (f/p, k/c),
    9: anything else.
    """
    ops = Levenshtein.editops(src, dst)
    if len(ops) != 1:
        return 9
    op = ops[0]
    if op.tag == "replace":
        a, b = src[op.src_pos], dst[op.dest_pos]
        if a in _VOWELS and b in _VOWELS:
            return 0
        return 2 if any(a in g and b in g for g in _SOUND_ALIKE) else 9
    text, pos = (dst, op.dest_pos) if op.tag == "insert" else (src, op.src_pos)
    ch = text[pos]
    doubled = (pos > 0 and text[pos - 1] == ch) or (pos + 1 < len(text) and text[pos + 1] == ch)
    return 1 if ch == "h" or doubled else 9


def spell_suggest(word: str) -> str | None:
    """Closest dictionary word at edit distance 1, preferring Indonesian words
    and the most typical kind of mishearing when several are possible."""
    w = word.lower()
    cands = [c for c in _by_initial().get(w[0], []) if abs(len(c) - len(w)) <= 1]
    hits = [c for c in cands if Levenshtein.distance(w, c, score_cutoff=1) <= 1]
    if len(hits) <= 1:
        return hits[0] if hits else None
    idn = _lang_words("id")
    ranked = sorted((_mishearing_rank(w, c), c not in idn, c) for c in hits)
    best = ranked[0]
    if best[0] < 9 and (len(ranked) == 1 or ranked[1][:2] != best[:2]):
        return best[2]
    return None


_SHORT_WORDS = {"ini", "itu", "di", "ke", "ya", "lah", "dan", "yang", "aja", "saja", "juga",
                "the", "of", "to", "in", "on", "is", "it"}


def split_suggest(word: str) -> str | None:
    """Split two words Whisper glued together (mingguini -> minggu ini)."""
    w = word.lower()
    if len(w) < 6:
        return None
    for i in range(4, len(w) - 1):
        a, b = w[:i], w[i:]
        if is_known(a) and (b in _SHORT_WORDS or (len(b) >= 4 and is_known(b))):
            return f"{a} {b}"
    return None


def _match_case(src: str, dst: str) -> str:
    if src.isupper():
        return dst.upper()
    if src[:1].isupper():
        return dst[:1].upper() + dst[1:]
    return dst


@dataclass
class Glossary:
    terms: list[str] = field(default_factory=list)
    aliases: dict[str, str] = field(default_factory=dict)
    people: list[str] = field(default_factory=list)
    abbreviations: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls) -> "Glossary":
        config.ensure_dirs()
        data = yaml.safe_load(config.GLOSSARY.read_text()) or {}
        g = cls()
        for item in data.get("terms") or []:
            if isinstance(item, str):
                item = {"term": item}
            term = str(item["term"]).strip()
            g.terms.append(term)
            for alias in item.get("aliases") or []:
                alias = str(alias).strip().lower()
                if len(alias) < 2 or alias.replace(".", "").replace(",", "").isdigit():
                    print(f"Kamus: alias '{alias}' untuk '{term}' diabaikan (terlalu pendek "
                          f"atau hanya angka; beri tanda kutip jika mengandung koma).", file=sys.stderr)
                    continue
                g.aliases[alias] = term
        g.people = [str(p).strip() for p in data.get("people") or []]
        g.abbreviations = {str(k): str(v) for k, v in (data.get("abbreviations") or {}).items()}
        return g

    @property
    def vocabulary(self) -> list[str]:
        return list(dict.fromkeys(self.terms + self.people + list(self.abbreviations)))

    def prompt(self) -> str | None:
        vocab = self.vocabulary
        if not vocab:
            return None
        text = "Glosarium: " + ", ".join(vocab) + "."
        return text[:PROMPT_MAX_CHARS]

    @property
    def _canonical(self) -> dict[str, str]:
        return {v.lower(): v for v in self.vocabulary}

    def correct_text(self, text: str) -> str:
        """Fix known mishearings and enforce canonical spelling/casing."""
        for alias, term in sorted(self.aliases.items(), key=lambda kv: -len(kv[0])):
            text = re.sub(rf"(?<!\w){re.escape(alias)}(?!\w)", term, text, flags=re.IGNORECASE)
        for lower, canonical in self._canonical.items():
            text = re.sub(rf"(?<!\w){re.escape(lower)}(?!\w)", canonical, text, flags=re.IGNORECASE)
        return text

    def _glossary_match(self, core: str, low_conf: bool) -> str | None:
        lower = core.lower()
        single = [v for v in self.vocabulary if " " not in v and len(v) >= 3]
        for v in single:
            if len(v) <= 6 and sorted(v.lower()) == sorted(lower):
                return v
        long = [v for v in single if len(v) >= 4]
        attempts = [(long, FUZZY_MIN_SCORE)] if low_conf else [
            ([v for v in long if v[0].lower() == lower[0]], OOV_MIN_SCORE),
            (long, OOV_ANY_INITIAL_SCORE),
        ]
        for cands, cutoff in attempts:
            match = process.extractOne(lower, cands, scorer=fuzz.ratio, score_cutoff=cutoff,
                                       processor=str.lower)
            if match and abs(len(match[0]) - len(core)) <= 2:
                return match[0]
        return None

    def correctable(self, word: str) -> bool:
        return bool(self._glossary_match(word, True) or spell_suggest(word) or split_suggest(word))

    def correct_words(self, words: list[dict]) -> list[dict]:
        """Correct out-of-dictionary words: glossary terms first, then spelling.

        Glossary matching applies to any unknown word; general spell correction
        only to words Whisper itself was unsure about, so rare-but-real words survive.
        """
        canonical = {tok.lower() for v in self.vocabulary for tok in [v, *v.split()]}
        out = []
        for w in words:
            raw = w["word"]
            core = raw.strip().strip(".,!?;:\"'()")
            lower = core.lower()
            if len(core) >= 3 and core.replace("-", "").isalpha() and lower not in canonical \
                    and not is_known(core):
                low_conf = w.get("probability", 1.0) < LOW_CONFIDENCE
                fix = self._glossary_match(core, low_conf)
                if fix is None and core.isalpha():
                    suggestion = (spell_suggest(core) if low_conf and len(core) >= 4 else None) \
                        or split_suggest(core)
                    fix = _match_case(core, suggestion) if suggestion else None
                if fix and fix != core:
                    w = {**w, "word": raw.replace(core, fix), "corrected_from": core}
            out.append(w)
        return out

    def abbreviations_in(self, text: str) -> dict[str, str]:
        return {
            k: v for k, v in self.abbreviations.items()
            if re.search(rf"(?<!\w){re.escape(k)}(?!\w)", text)
        }
