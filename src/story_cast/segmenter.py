"""Deterministic story segmentation for the Auto cast mode.

The LLM never rewrites story text.  This module splits the original source into
ordered, non-overlapping segments (dialogue, narration, headings and direction
tags) whose offsets point back into the untouched source.  Only the speaker of
each dialogue segment is later decided by the LLM or the user.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple

SEGMENTER_VERSION = 1

KIND_DIALOGUE = "dialogue"
KIND_NARRATION = "narration"
KIND_HEADING = "heading"
KIND_DIRECTION = "direction"

DIALOGUE_DASHES = "—―–"  # em dash, horizontal bar, en dash
SPEAKER_TAG_PATTERN = re.compile(r"\[([a-zA-Z0-9_\-]+)\](.*?)\[/\1\]", re.DOTALL)
DIRECTION_PATTERN = re.compile(r"\[(direction|emotion)\].*?\[/\1\]", re.DOTALL | re.IGNORECASE)
RESERVED_TAG_NAMES = {"direction", "emotion"}
_NUMBER_WORDS = (
    # English
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
    "sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|"
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|"
    # Spanish
    "uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|"
    "diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti[a-zá-ú]+|treinta|cuarenta|cincuenta|cien|"
    "primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|s[eé]ptim[oa]|octav[oa]|"
    "noven[oa]|d[eé]cim[oa]|[uú]ltim[oa]"
)
# A number word, possibly compound: "Twenty-One", "Twenty One", "treinta y dos".
_NUMBER_WORD = r"(?:" + _NUMBER_WORDS + r")(?:(?:[-\s]|\s+y\s+)(?:" + _NUMBER_WORDS + r"))*"
# A well-formed roman numeral, so words such as "did" or "mild" do not count.
_ROMAN = r"(?=[ivxlcdm])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})\b"
HEADING_PATTERN = re.compile(
    r"^(?:chapter|cap[ií]tulo|part|parte|book|libro|section|secci[oó]n|"
    r"prologue|pr[oó]logo|epilogue|ep[ií]logo|interlude|interludio|"
    r"chapitre|kapitel|capitolo)"
    # Only the keyword, the keyword plus a title ("Prologue: ..."), or a number,
    # roman numeral or number word ("Chapter 3", "Part IV", "Book One"),
    # optionally followed by a title. "Part of me knew." and "Part failed."
    # are narration.
    r"(?:\s*$|\s*[-—–:.]\s*\S.*$|\s+(?:\d+|" + _ROMAN + "|" + _NUMBER_WORD + r")\.?(?:\s*[-—–:.]\s*.*)?$)",
    re.IGNORECASE,
)
# Every quote character the dialogue parser opens or closes on.
_HEADING_QUOTES = "\"«»“”‘’„‚‹›"
_TERMINAL_CHARS = set(".!?:;\"'»”’)]*—…")


@dataclass
class Segment:
    id: str
    start: int
    end: int
    kind: str
    para: int
    speaker: Optional[str] = None
    confidence: float = 0.0
    locked: bool = False
    origin: str = "rule"  # rule | llm | user | policy
    candidates: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict) -> "Segment":
        return cls(**{key: data[key] for key in cls.__dataclass_fields__ if key in data})


def source_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def has_speaker_tags(text: str) -> bool:
    return any(
        match.group(1).lower() not in RESERVED_TAG_NAMES
        for match in SPEAKER_TAG_PATTERN.finditer(text or "")
    )


def strip_speaker_tags(text: str) -> str:
    """Remove balanced speaker tags, keeping their content and direction tags."""
    previous = None
    current = text or ""
    # Repeat so nested (invalid but possible) speaker tags are also removed.
    while previous != current:
        previous = current
        current = SPEAKER_TAG_PATTERN.sub(
            lambda m: m.group(0) if m.group(1).lower() in RESERVED_TAG_NAMES else m.group(2),
            current,
        )
    return current


def _trimmed_span(text: str, start: int, end: int) -> Optional[Tuple[int, int]]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return (start, end) if start < end else None


def _is_hard_wrapped(text: str) -> bool:
    lines = text.split("\n")
    candidates = 0
    unterminated = 0
    for index, line in enumerate(lines[:-1]):
        stripped = line.strip()
        if not stripped or not lines[index + 1].strip():
            continue
        candidates += 1
        if stripped[-1] not in _TERMINAL_CHARS:
            unterminated += 1
    return candidates >= 4 and unterminated / candidates > 0.3


def split_paragraphs(text: str) -> List[Tuple[int, int]]:
    """Return trimmed (start, end) spans of paragraphs in source order.

    Text with blank-line separated, hard-wrapped paragraphs is split on blank
    lines; otherwise every non-empty line is a paragraph (the common format for
    pasted stories and converted documents).
    """
    if re.search(r"\n[ \t]*\n", text) and _is_hard_wrapped(text):
        separator = re.compile(r"\n[ \t]*\n\s*")
    else:
        separator = re.compile(r"\n")
    spans: List[Tuple[int, int]] = []
    cursor = 0
    for match in separator.finditer(text):
        span = _trimmed_span(text, cursor, match.start())
        if span:
            spans.append(span)
        cursor = match.end()
    span = _trimmed_span(text, cursor, len(text))
    if span:
        spans.append(span)
    return spans


def _looks_like_heading(paragraph: str) -> bool:
    candidate = paragraph.strip().strip("*").strip()
    if not candidate or len(candidate) > 80 or "\n" in candidate:
        return False
    if any(q in candidate for q in _HEADING_QUOTES) or candidate[0] in DIALOGUE_DASHES:
        return False
    if HEADING_PATTERN.match(candidate):
        return True
    letters = [ch for ch in candidate if ch.isalpha()]
    return (
        len(letters) >= 3
        and all(ch.isupper() for ch in letters)
        and not any(q in candidate for q in "\"«“" + DIALOGUE_DASHES)
        and candidate[-1] not in ".!?,;"
    )


def _dash_dialogue_spans(text: str, start: int, end: int) -> List[Tuple[int, int, str]]:
    """Split a dash-dialogue paragraph into dialogue / narrator inciso spans.

    Handles the Spanish convention ``—Vamos —dijo Juan— que es tarde.`` and
    ``—Hola —dijo—. ¿Cómo estás?``.
    """
    pieces: List[Tuple[int, int, str]] = []
    state = KIND_DIALOGUE
    piece_start = start
    i = start + 1
    while i < end:
        ch = text[i]
        if ch in DIALOGUE_DASHES:
            if state == KIND_DIALOGUE and text[i - 1].isspace() and i + 1 < end and not text[i + 1].isspace():
                pieces.append((piece_start, i, KIND_DIALOGUE))
                piece_start = i
                state = KIND_NARRATION
            elif state == KIND_NARRATION and (i + 1 >= end or text[i + 1].isspace() or text[i + 1] in ".,;:" or not text[i - 1].isspace()):
                close = i + 1
                while close < end and text[close] in ".,;:":
                    close += 1
                rest = _trimmed_span(text, close, end)
                if rest is None:
                    break
                pieces.append((piece_start, close, KIND_NARRATION))
                piece_start = rest[0]
                state = KIND_DIALOGUE
                i = rest[0]
        i += 1
    pieces.append((piece_start, end, state))
    return pieces


def _find_quote_close(text: str, i: int, end: int) -> int:
    opener = text[i]
    if opener == "«":
        depth = 0
        for j in range(i, end):
            if text[j] == "«":
                depth += 1
            elif text[j] == "»":
                depth -= 1
                if depth == 0:
                    return j + 1
        return end
    if opener == "“":
        j = text.find("”", i + 1, end)
        return j + 1 if j >= 0 else end
    if opener == "„":
        for closer in ("“", "”"):
            j = text.find(closer, i + 1, end)
            if j >= 0:
                return j + 1
        return end
    if opener == '"':
        j = text.find('"', i + 1, end)
        return j + 1 if j >= 0 else end
    if opener == "‘":
        for j in range(i + 1, end):
            if text[j] == "’" and not text[j - 1].isspace() and (j + 1 >= end or not text[j + 1].isalnum()):
                return j + 1
        return -1
    return -1


def _quote_dialogue_spans(text: str, start: int, end: int) -> List[Tuple[int, int, str]]:
    pieces: List[Tuple[int, int, str]] = []
    cursor = start
    i = start
    while i < end:
        ch = text[i]
        is_opener = ch in "«“„\""
        if ch == "‘" and (i == start or not text[i - 1].isalnum()):
            is_opener = True
        if is_opener:
            close = _find_quote_close(text, i, end)
            if close > i:
                if i > cursor:
                    pieces.append((cursor, i, KIND_NARRATION))
                pieces.append((i, close, KIND_DIALOGUE))
                cursor = close
                i = close
                continue
        i += 1
    if cursor < end:
        pieces.append((cursor, end, KIND_NARRATION))
    return pieces


def _merge_punctuation_only(text: str, pieces: List[Tuple[int, int, str]]) -> List[Tuple[int, int, str]]:
    """Attach narration fragments without letters/digits to a neighbour."""
    merged: List[List] = []
    for piece_start, piece_end, kind in pieces:
        span = _trimmed_span(text, piece_start, piece_end)
        if span is None:
            continue
        content = text[span[0]:span[1]]
        if kind == KIND_NARRATION and not any(ch.isalnum() for ch in content):
            if merged:
                merged[-1][1] = span[1]
                continue
            pending = [span[0], span[1], kind]
            merged.append(pending)
            continue
        if merged and merged[-1][2] == KIND_NARRATION and not any(
            ch.isalnum() for ch in text[merged[-1][0]:merged[-1][1]]
        ):
            # Leading punctuation-only fragment: fold into this piece.
            merged[-1] = [merged[-1][0], span[1], kind]
            continue
        merged.append([span[0], span[1], kind])
    return [(a, b, k) for a, b, k in merged]


def _segment_paragraph(text: str, start: int, end: int) -> List[Tuple[int, int, str]]:
    paragraph = text[start:end]
    if _looks_like_heading(paragraph):
        return [(start, end, KIND_HEADING)]
    pieces: List[Tuple[int, int, str]] = []
    cursor = start
    for match in DIRECTION_PATTERN.finditer(text, start, end):
        if match.start() > cursor:
            pieces.extend(_segment_spoken(text, cursor, match.start()))
        pieces.append((match.start(), match.end(), KIND_DIRECTION))
        cursor = match.end()
    if cursor < end:
        pieces.extend(_segment_spoken(text, cursor, end))
    return pieces


def _segment_spoken(text: str, start: int, end: int) -> List[Tuple[int, int, str]]:
    span = _trimmed_span(text, start, end)
    if span is None:
        return []
    start, end = span
    if text[start] in DIALOGUE_DASHES:
        pieces = _dash_dialogue_spans(text, start, end)
    else:
        pieces = _quote_dialogue_spans(text, start, end)
    return _merge_punctuation_only(text, pieces)


def segment_text(text: str) -> List[Segment]:
    """Split ``text`` into ordered segments covering every non-space character."""
    segments: List[Segment] = []
    for para_index, (start, end) in enumerate(split_paragraphs(text)):
        for piece_start, piece_end, kind in _segment_paragraph(text, start, end):
            span = _trimmed_span(text, piece_start, piece_end)
            if span is None:
                continue
            segment = Segment(
                id=f"s{len(segments) + 1:05d}",
                start=span[0],
                end=span[1],
                kind=kind,
                para=para_index,
            )
            if kind in (KIND_NARRATION, KIND_HEADING):
                segment.speaker = "narrator"
                segment.confidence = 1.0
            segments.append(segment)
    return segments


def verify_coverage(text: str, segments: List[Segment]) -> List[str]:
    """Return problems if segments overlap, are unordered or skip characters."""
    problems: List[str] = []
    cursor = 0
    for segment in segments:
        if segment.start < cursor:
            problems.append(f"{segment.id} overlaps the previous segment")
        gap = text[cursor:segment.start]
        if gap.strip():
            problems.append(f"Text before {segment.id} is not covered: {gap.strip()[:40]!r}")
        cursor = max(cursor, segment.end)
    if text[cursor:].strip():
        problems.append(f"Trailing text is not covered: {text[cursor:].strip()[:40]!r}")
    return problems
