"""Lenient JSON extraction plus schema validation for LLM answers.

Every provider in the chain (including small local models) answers in free
text, so the reply is parsed defensively and validated before any value is
used.  Invalid answers never reach the session state.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, Tuple

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError


class LLMJSONError(ValueError):
    """Raised when an LLM answer cannot be turned into valid JSON."""


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def extract_json(text: str) -> Any:
    cleaned = _THINK.sub("", str(text or "")).strip()
    candidates = [match.group(1).strip() for match in _FENCE.finditer(cleaned)]
    candidates.append(cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        candidates.append(cleaned[start:end + 1])
    last_error: Exception | None = None
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except ValueError as exc:
            last_error = exc
    raise LLMJSONError(f"The model did not return valid JSON ({last_error})")


def parse_and_validate(text: str, schema: Dict) -> Dict:
    value = extract_json(text)
    try:
        Draft202012Validator(schema).validate(value)
    except ValidationError as exc:
        location = "/".join(str(part) for part in exc.absolute_path) or "root"
        raise LLMJSONError(f"JSON failed validation at {location}: {exc.message[:200]}") from exc
    return value


def ask_json(run_prompt: Callable[[str], Tuple[str, Dict]], prompt: str, schema: Dict,
             retries: int = 1) -> Tuple[Dict, int]:
    """Run ``prompt`` and return (validated JSON, number of LLM calls made)."""
    calls = 0
    current_prompt = prompt
    last_error: LLMJSONError | None = None
    for _attempt in range(retries + 1):
        text, _profile = run_prompt(current_prompt)
        calls += 1
        try:
            return parse_and_validate(text, schema), calls
        except LLMJSONError as exc:
            last_error = exc
            current_prompt = (
                prompt
                + "\n\nYOUR PREVIOUS ANSWER WAS REJECTED: "
                + str(exc)
                + "\nReturn ONLY one JSON object that follows the required format. No prose, no code fences."
            )
    assert last_error is not None
    last_error.calls = calls  # type: ignore[attr-defined]
    raise last_error
