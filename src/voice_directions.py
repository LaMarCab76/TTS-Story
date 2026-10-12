"""Production-local speaker identity, separate from per-passage delivery cues."""
import copy
import re


PROFILE_FIELDS = ("description", "voice", "voice_design_prompt")


def clean_speaker_profile(profile):
    if not isinstance(profile, dict):
        return {}
    return {key: profile[key].strip() for key in PROFILE_FIELDS
            if isinstance(profile.get(key), str)}


def attach_speaker_profiles(assignments, profiles):
    """Snapshot only matching speaker IDs; never confuse a voice ID with Voice Type."""
    result = copy.deepcopy(assignments)
    if not isinstance(profiles, dict):
        return result
    profiles = {str(key).strip().lower(): value for key, value in profiles.items()}
    # Saved project profile keys historically omit punctuation, while manuscript
    # speaker IDs retain it (alexanderholdermale vs alexander-holder-male).
    # Only accept an unambiguous normalized match; never guess by substring.
    aliases = {}
    for key, value in profiles.items():
        alias = re.sub(r'[^a-z0-9]', '', key)
        aliases.setdefault(alias, []).append(value)
    for speaker, assignment in result.items():
        key = str(speaker).strip().lower()
        raw = profiles.get(key)
        if raw is None:
            matches = aliases.get(re.sub(r'[^a-z0-9]', '', key), [])
            if len(matches) == 1:
                raw = matches[0]
        profile = clean_speaker_profile(raw)
        if profile and isinstance(assignment, dict):
            assignment["extra"] = {**(assignment.get("extra") or {}), "speaker_profile": profile}
    return result


def compose_voice_direction(extra, delivery):
    """Combine at the engine boundary, leaving manuscript and saved cues untouched."""
    profile = clean_speaker_profile((extra or {}).get("speaker_profile"))
    voice_type = re.sub(r"\s+", " ", profile.get("voice", "")).strip()
    cue = re.sub(r"\s+", " ", str(delivery or "")).strip()
    if not voice_type:
        return cue
    # Older/manual cues may already include the exact stable prefix.
    stem = voice_type.rstrip(".!? ")
    if re.match(re.escape(stem) + r"(?:[.!?\s]|$)", cue, re.IGNORECASE):
        return cue
    prefix = voice_type if voice_type.endswith((".", "!", "?")) else voice_type + "."
    return f"{prefix} {cue}".strip()
