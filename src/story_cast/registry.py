"""Character registry and tagged-manuscript materialization for Auto cast."""

from __future__ import annotations

import re
import unicodedata
from typing import Dict, Iterable, List, Optional

from .segmenter import (
    KIND_DIALOGUE,
    KIND_DIRECTION,
    Segment,
    strip_speaker_tags,
)

NARRATOR_ID = "narrator"
UNKNOWN_SPEAKER = "unknown"
VALID_GENDERS = ("male", "female", "neutral", "unknown")
_RESERVED_TAGS = {"narrator", "default", "direction", "emotion", "unknown"}


class MaterializeError(RuntimeError):
    """Raised when a tagged manuscript would not reproduce the source exactly."""


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    return slug[:40].strip("-")


def normalize_gender(value: Optional[str]) -> str:
    text = str(value or "").strip().lower()
    aliases = {
        "m": "male", "man": "male", "masculine": "male", "masculino": "male", "hombre": "male",
        "f": "female", "woman": "female", "feminine": "female", "femenino": "female", "mujer": "female",
        "n": "neutral", "nonbinary": "neutral", "non-binary": "neutral",
    }
    text = aliases.get(text, text)
    return text if text in VALID_GENDERS else "unknown"


def new_character(char_id: str, key: str, name: str, *, gender: str = "unknown",
                  description: str = "", aliases: Optional[Iterable[str]] = None,
                  role: str = "character") -> Dict:
    return {
        "id": char_id,
        "key": key,
        "name": name,
        "gender": normalize_gender(gender),
        "description": description,
        "aliases": sorted({str(a).strip() for a in (aliases or []) if str(a).strip()}),
        "role": role,
        "merged_into": None,
        "tag": "",
    }


def narrator_character() -> Dict:
    character = new_character(NARRATOR_ID, NARRATOR_ID, "Narrator", role="narrator")
    character["tag"] = NARRATOR_ID
    return character


class CharacterRegistry:
    """Mutable view over the ``characters`` list stored in a session."""

    def __init__(self, characters: List[Dict]):
        self.characters = characters
        if not any(c["id"] == NARRATOR_ID for c in characters):
            characters.insert(0, narrator_character())

    def active(self) -> List[Dict]:
        return [c for c in self.characters if not c.get("merged_into")]

    def by_id(self, char_id: str) -> Optional[Dict]:
        return next((c for c in self.characters if c["id"] == char_id), None)

    def resolve(self, char_id: Optional[str]) -> Optional[str]:
        """Follow merge links to the surviving character id."""
        seen = set()
        current = char_id
        while current and current not in seen:
            seen.add(current)
            character = self.by_id(current)
            if not character:
                return None
            if not character.get("merged_into"):
                return current
            current = character["merged_into"]
        return None

    def find_by_key(self, key: str) -> Optional[Dict]:
        wanted = slugify(key)
        if not wanted:
            return None
        if wanted == NARRATOR_ID:
            return self.by_id(NARRATOR_ID)
        for character in self.characters:
            if character["key"] == wanted or slugify(character["name"]) == wanted:
                return self.by_id(self.resolve(character["id"]) or character["id"])
        for character in self.characters:
            if wanted in {slugify(alias) for alias in character.get("aliases", [])}:
                return self.by_id(self.resolve(character["id"]) or character["id"])
        return None

    def upsert(self, key: str, name: str = "", *, gender: str = "unknown",
               description: str = "", aliases: Optional[Iterable[str]] = None) -> Dict:
        existing = self.find_by_key(key) or (self.find_by_key(name) if name else None)
        if existing:
            if existing["gender"] == "unknown" and normalize_gender(gender) != "unknown":
                existing["gender"] = normalize_gender(gender)
            if description and not existing.get("description"):
                existing["description"] = description
            merged_aliases = set(existing.get("aliases", [])) | {str(a).strip() for a in (aliases or []) if str(a).strip()}
            merged_aliases.discard(existing["name"])
            existing["aliases"] = sorted(merged_aliases)
            return existing
        base_key = slugify(key) or slugify(name) or "character"
        unique_key = base_key
        suffix = 2
        while unique_key in _RESERVED_TAGS or any(c["key"] == unique_key for c in self.characters):
            unique_key = f"{base_key}-{suffix}"
            suffix += 1
        char_id = f"c{len(self.characters):03d}"
        while self.by_id(char_id):
            char_id = f"c{int(char_id[1:]) + 1:03d}"
        character = new_character(
            char_id, unique_key, (name or key).strip() or unique_key,
            gender=gender, description=description, aliases=aliases,
        )
        self.characters.append(character)
        return character

    def merge(self, source_id: str, target_id: str) -> None:
        source = self.by_id(source_id)
        target = self.by_id(self.resolve(target_id) or "")
        if not source or not target or source["id"] == target["id"] or source["id"] == NARRATOR_ID:
            raise ValueError("Invalid character merge")
        source["merged_into"] = target["id"]
        target["aliases"] = sorted(set(target.get("aliases", [])) | {source["name"], *source.get("aliases", [])} - {target["name"]})

    def unmerge(self, source_id: str) -> None:
        source = self.by_id(source_id)
        if source:
            source["merged_into"] = None

    def assign_tags(self) -> Dict[str, str]:
        """Give every active character a unique ASCII speaker tag."""
        used = {NARRATOR_ID}
        tags = {NARRATOR_ID: NARRATOR_ID}
        for character in self.active():
            if character["id"] == NARRATOR_ID:
                continue
            base = character["key"] or slugify(character["name"]) or "character"
            if character["gender"] in ("male", "female"):
                base = f"{base}-{character['gender']}"
            tag = base
            suffix = 2
            while tag in used or tag in _RESERVED_TAGS:
                tag = f"{base}-{suffix}"
                suffix += 1
            used.add(tag)
            character["tag"] = tag
            tags[character["id"]] = tag
        return tags


def effective_speaker(segment: Segment, registry: CharacterRegistry,
                      narration_voice: Optional[str]) -> str:
    """Return the surviving character id that will voice ``segment``."""
    if segment.kind == KIND_DIALOGUE:
        resolved = registry.resolve(segment.speaker) if segment.speaker not in (None, UNKNOWN_SPEAKER) else None
        if resolved == NARRATOR_ID and narration_voice:
            return registry.resolve(narration_voice) or NARRATOR_ID
        return resolved or NARRATOR_ID
    if narration_voice:
        return registry.resolve(narration_voice) or NARRATOR_ID
    return NARRATOR_ID


def materialize(source: str, segments: List[Segment], registry: CharacterRegistry,
                narration_voice: Optional[str] = None) -> Dict:
    """Build the tagged manuscript from the untouched source.

    Adjacent segments of one paragraph voiced by the same character are joined
    into one block.  The result is verified by stripping the speaker tags and
    comparing with the source byte for byte.
    """
    tags = registry.assign_tags()
    parts: List[str] = []
    cursor = 0
    index = 0
    used_tags = set()
    while index < len(segments):
        segment = segments[index]
        parts.append(source[cursor:segment.start])
        if segment.kind == KIND_DIRECTION:
            parts.append(source[segment.start:segment.end])
            cursor = segment.end
            index += 1
            continue
        speaker = effective_speaker(segment, registry, narration_voice)
        block_end = segment.end
        next_index = index + 1
        while next_index < len(segments):
            candidate = segments[next_index]
            if (candidate.para != segment.para or candidate.kind == KIND_DIRECTION
                    or effective_speaker(candidate, registry, narration_voice) != speaker):
                break
            block_end = candidate.end
            next_index += 1
        tag = tags.get(speaker, NARRATOR_ID)
        used_tags.add(tag)
        parts.append(f"[{tag}]{source[segment.start:block_end]}[/{tag}]")
        cursor = block_end
        index = next_index
    parts.append(source[cursor:])
    text = "".join(parts)
    if strip_speaker_tags(text) != source:
        raise MaterializeError("Tagged manuscript does not reproduce the source text exactly")
    return {"text": text, "tags": tags, "speakers": sorted(used_tags)}
