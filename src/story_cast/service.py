"""Auto cast session orchestration.

The backend drives every step; the LLM only returns validated JSON data.
Questions to the user are created and answered here with deterministic
handlers, so nothing the model (or the story text) says can approve a shared
voice, raise the budget or change locked decisions.
"""

from __future__ import annotations

import logging
import threading
import uuid
from typing import Callable, Dict, List, Optional, Tuple

from .attribution import (
    ATTRIBUTION_SCHEMA,
    apply_attribution,
    build_attribution_prompt,
    build_batches,
    find_similar_segments,
    is_doubtful,
)
from .casting import (
    RANKING_SCHEMA,
    assign_unique,
    build_ranking_prompt,
    filter_catalog_for_language,
    heuristic_rankings,
    normalize_catalog,
    parse_rankings,
    propose_sharing,
)
from .llm_json import LLMJSONError, ask_json
from .registry import (
    NARRATOR_ID,
    UNKNOWN_SPEAKER,
    CharacterRegistry,
    effective_speaker,
    materialize,
)
from .segmenter import (
    KIND_DIALOGUE,
    SEGMENTER_VERSION,
    Segment,
    has_speaker_tags,
    segment_text,
    source_hash,
    strip_speaker_tags,
    verify_coverage,
)
from .store import StoryCastStore, utc_now

logger = logging.getLogger(__name__)

DEFAULT_PAID_REQUEST_LIMIT = 200
BUDGET_STEP = 200
MAX_LOG = 60
MAX_SOURCE_CHARS = 3_000_000

LLMRunner = Callable[[str, bool], Tuple[str, Dict, List[Dict]]]


class StoryCastError(RuntimeError):
    def __init__(self, message: str, code: str = "error", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


class BudgetExceeded(RuntimeError):
    pass


class SessionStopped(RuntimeError):
    pass


def billing_for_provider(provider: str) -> str:
    """Classify an LLM profile for the paid-request limit."""
    provider = str(provider or "").strip().lower()
    if provider == "local":
        return "local"
    if provider in ("chatgpt", "chatgpt_subscription"):
        return "subscription"
    return "pay_per_use"


def _segments(session: Dict) -> List[Segment]:
    return [Segment.from_dict(item) for item in session["segments"]]


def _store_segments(session: Dict, segments: List[Segment]) -> None:
    session["segments"] = [segment.to_dict() for segment in segments]


def _log(session: Dict, message: str) -> None:
    session.setdefault("log", []).append({"at": utc_now(), "message": message})
    session["log"] = session["log"][-MAX_LOG:]


class StoryCastService:
    def __init__(self, store: StoryCastStore, run_llm: LLMRunner,
                 paid_limit_provider: Callable[[], int] = lambda: DEFAULT_PAID_REQUEST_LIMIT):
        self.store = store
        self.run_llm = run_llm
        self.paid_limit_provider = paid_limit_provider
        self._llm_lock = threading.Lock()  # one inference at a time (shared GPU / quotas)
        self._workers: Dict[str, threading.Thread] = {}
        self._workers_lock = threading.Lock()

    # ------------------------------------------------------------------ create
    def create(self, text: str, *, project_id: Optional[str] = None, strip_existing_tags: bool = False,
               title: str = "") -> Dict:
        source = str(text or "")
        if not source.strip():
            raise StoryCastError("The manuscript is empty", "empty_text")
        if len(source) > MAX_SOURCE_CHARS:
            raise StoryCastError("The manuscript is too large for Auto cast", "too_large")
        if has_speaker_tags(source):
            if not strip_existing_tags:
                raise StoryCastError(
                    "The manuscript already has speaker tags. Auto cast works on the untagged story.",
                    "already_tagged", 409,
                )
            source = strip_speaker_tags(source)
        segments = segment_text(source)
        problems = verify_coverage(source, segments)
        if problems:
            raise StoryCastError("Could not segment the manuscript: " + problems[0], "segmentation_failed", 422)
        session = {
            "id": uuid.uuid4().hex,
            "created_at": utc_now(),
            "project_id": str(project_id) if project_id else None,
            "title": (title or source.strip().splitlines()[0])[:80],
            "source": source,
            "source_hash": source_hash(source),
            "segmenter_version": SEGMENTER_VERSION,
            "segments": [segment.to_dict() for segment in segments],
            "characters": [],
            "language": "",
            "narration": {"first_person": False, "voice": None, "decided": False},
            "status": "idle",
            "phase": "attribution",
            "generation": 0,
            "progress": {"done": 0, "total": 0, "label": "Ready"},
            "error": "",
            "questions": [],
            "approvals": [],
            "examples": [],
            "budget": {"paid_requests": 0, "limit": int(self.paid_limit_provider()), "local_only": False},
            "casting": {"engine": "", "assignments": {}, "alternatives": {}, "origin": {}, "catalog": []},
            "materialized": None,
            "log": [],
            "pending_rerun_targets": [],
        }
        CharacterRegistry(session["characters"])
        dialogue = sum(1 for s in segments if s.kind == KIND_DIALOGUE)
        _log(session, f"Segmented {len(segments)} passages ({dialogue} speech segments)")
        return self.store.create(session)

    # ----------------------------------------------------------------- workers
    def _spawn(self, session_id: str, target: Callable, *args) -> None:
        with self._workers_lock:
            existing = self._workers.get(session_id)
            if existing and existing.is_alive():
                raise StoryCastError("Auto cast is already running for this session", "busy", 409)
            thread = threading.Thread(target=self._guarded, args=(session_id, target, *args),
                                      name=f"story-cast-{session_id[:8]}", daemon=True)
            self._workers[session_id] = thread
            thread.start()

    def is_running(self, session_id: str) -> bool:
        with self._workers_lock:
            thread = self._workers.get(session_id)
            return bool(thread and thread.is_alive())

    def wait(self, session_id: str, timeout: float = 30) -> None:
        with self._workers_lock:
            thread = self._workers.get(session_id)
        if thread:
            thread.join(timeout)

    def _guarded(self, session_id: str, target: Callable, *args) -> None:
        try:
            target(session_id, *args)
        except SessionStopped:
            pass
        except Exception as exc:  # pragma: no cover - defensive
            logger.error("Auto cast worker failed: %s", exc, exc_info=True)

            def mark(session):
                session["status"] = "error"
                session["error"] = str(exc)[:500]
                _log(session, f"Stopped: {str(exc)[:200]}")
            self.store.update(session_id, mark)

    def _check_generation(self, session_id: str, generation: int) -> Dict:
        session = self.store.load(session_id)
        if session.get("generation") != generation or session.get("status") != "running":
            raise SessionStopped()
        return session

    def _begin(self, session: Dict, phase: str, label: str) -> None:
        session["generation"] = int(session.get("generation", 0)) + 1
        session["status"] = "running"
        session["phase"] = phase
        session["error"] = ""
        session["progress"] = {"done": 0, "total": 0, "label": label}

    # --------------------------------------------------------------- LLM calls
    def _call_llm(self, session_id: str, prompt: str) -> Tuple[str, Dict]:
        session = self.store.load(session_id)
        budget = session["budget"]
        limit = int(budget.get("limit") or 0)
        local_only = bool(budget.get("local_only"))
        limit_reached = limit > 0 and int(budget.get("paid_requests", 0)) >= limit
        with self._llm_lock:
            try:
                text, profile, failures = self.run_llm(prompt, local_only or limit_reached)
            except Exception as exc:
                if limit_reached and not local_only:
                    raise BudgetExceeded(str(exc)) from exc
                raise
        paid = 1 if billing_for_provider(profile.get("provider")) == "pay_per_use" else 0
        paid += sum(
            1 for failure in failures or []
            if billing_for_provider(failure.get("provider")) == "pay_per_use"
            and failure.get("failure_kind") not in ("daily_limit", "unsupported_structured_output", "filtered")
        )
        if paid:
            def count(s):
                s["budget"]["paid_requests"] = int(s["budget"].get("paid_requests", 0)) + paid
            self.store.update(session_id, count)
        return text, profile

    def _handle_worker_error(self, session_id: str, exc: Exception, resume_phase: str) -> None:
        def mark(session):
            session["status"] = "paused"
            if resume_phase in ("attribution", "casting"):
                session["phase"] = resume_phase
            if isinstance(exc, BudgetExceeded):
                limit = int(session["budget"].get("limit") or 0)
                session["error"] = f"Paid request limit reached ({limit})"
                self._add_question(
                    session, "budget_limit", key="budget",
                    title=f"The paid LLM request limit for this session ({limit}) was reached",
                    body="Subscriptions and local models are not limited. Choose how to continue.",
                    options=[
                        {"value": "raise", "label": f"Raise the limit by {BUDGET_STEP}"},
                        {"value": "unlimited", "label": "Remove the limit for this session"},
                        {"value": "local_only", "label": "Continue with local models only"},
                        {"value": "stop", "label": "Stop here"},
                    ],
                    payload={"resume_phase": resume_phase},
                )
            else:
                session["error"] = str(exc)[:500]
                _log(session, f"Paused after an error: {str(exc)[:200]}")
            if any(q["status"] == "pending" for q in session["questions"]):
                session["status"] = "waiting_user"
        self.store.update(session_id, mark)

    # ------------------------------------------------------------- attribution
    def start_attribution(self, session_id: str) -> Dict:
        def begin(session):
            if session["status"] == "running":
                raise StoryCastError("Auto cast is already running", "busy", 409)
            self._begin(session, "attribution", "Identifying speakers")
        session = self.store.update(session_id, begin)
        self._spawn(session_id, self._attribution_worker, session["generation"])
        return session

    def _attribution_worker(self, session_id: str, generation: int) -> None:
        session = self._check_generation(session_id, generation)
        segments = _segments(session)
        pending_ids = [s.id for s in segments if s.kind == KIND_DIALOGUE and not s.locked and s.origin == "rule"]
        batches = build_batches(segments, pending_ids)
        total = len(batches)
        self.store.update(session_id, lambda s: s.update(progress={"done": 0, "total": total, "label": "Identifying speakers"}))
        failed_batches = 0
        for index, batch in enumerate(batches):
            session = self._check_generation(session_id, generation)
            segments = _segments(session)
            registry = CharacterRegistry(session["characters"])
            first_batch = not session.get("language")
            built = build_attribution_prompt(
                session["source"], segments, batch, registry,
                examples=session.get("examples", []), only_ids=set(pending_ids), first_batch=first_batch,
            )
            try:
                result, _calls = ask_json(lambda p: self._call_llm(session_id, p), built["prompt"], ATTRIBUTION_SCHEMA)
            except LLMJSONError as exc:
                failed_batches += 1
                result = {"attributions": []}
                logger.warning("Auto cast batch %s returned invalid JSON: %s", index + 1, exc)
            except Exception as exc:
                self._handle_worker_error(session_id, exc, "attribution")
                return

            def commit(s, result=result, built=built, index=index):
                if s.get("generation") != generation:
                    raise SessionStopped()
                segs = _segments(s)
                reg = CharacterRegistry(s["characters"])
                apply_attribution(result, segs, reg, built["targets"])
                if result.get("language") and not s.get("language"):
                    s["language"] = str(result["language"])[:12]
                narration = result.get("narration") or {}
                if narration and not s["narration"].get("decided"):
                    self._note_narration(s, reg, narration)
                for pair in result.get("possible_duplicates") or []:
                    self._note_duplicate(s, reg, pair)
                _store_segments(s, segs)
                s["progress"] = {"done": index + 1, "total": total, "label": "Identifying speakers"}
            try:
                self.store.update(session_id, commit)
            except SessionStopped:
                return
        def finish(s):
            if s.get("generation") != generation:
                raise SessionStopped()
            if failed_batches:
                _log(s, f"{failed_batches} batch(es) returned unusable answers; their lines are marked doubtful")
            self._after_attribution(s)
        try:
            self.store.update(session_id, finish)
        except SessionStopped:
            return

    def _note_narration(self, session: Dict, registry: CharacterRegistry, narration: Dict) -> None:
        if not narration.get("first_person"):
            return
        session["narration"]["first_person"] = True
        key = narration.get("narrator_key")
        character = registry.find_by_key(str(key)) if key else None
        try:
            confidence = float(narration.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        if character and character["id"] != NARRATOR_ID and confidence >= 0.75:
            session["narration"]["voice"] = character["id"]
            session["narration"]["decided"] = True
            _log(session, f"First-person narration: narration uses {character['name']}'s voice")
        elif character and character["id"] != NARRATOR_ID:
            session["narration"]["suggested"] = character["id"]

    def _note_duplicate(self, session: Dict, registry: CharacterRegistry, pair) -> None:
        if not isinstance(pair, list) or len(pair) < 2:
            return
        first = registry.find_by_key(str(pair[0]))
        second = registry.find_by_key(str(pair[1]))
        if not first or not second or first["id"] == second["id"] or NARRATOR_ID in (first["id"], second["id"]):
            return
        key = "|".join(sorted([first["id"], second["id"]]))
        self._add_question(
            session, "merge_characters", key=key,
            title=f"Are \"{first['name']}\" and \"{second['name']}\" the same character?",
            body="If they are, both will share one voice and one entry in the cast.",
            options=[
                {"value": "merge", "label": f"Yes, merge into {first['name']}"},
                {"value": "keep", "label": "No, they are different characters"},
            ],
            payload={"keep": first["id"], "merge": second["id"]},
        )

    def _after_attribution(self, session: Dict) -> None:
        registry = CharacterRegistry(session["characters"])
        segments = _segments(session)
        if session["narration"].get("first_person") and not session["narration"].get("decided"):
            options = [{"value": c["id"], "label": c["name"]} for c in registry.active() if c["id"] != NARRATOR_ID]
            options.append({"value": NARRATOR_ID, "label": "A separate narrator voice"})
            suggested = session["narration"].get("suggested")
            if suggested:
                options.sort(key=lambda o: o["value"] != suggested)
            self._add_question(
                session, "narrator_identity", key="narrator",
                title="The story is narrated in first person. Who is the narrator?",
                body="Narration will be read with that character's voice.",
                options=options,
            )
        doubtful = [s for s in segments if is_doubtful(s)]
        if doubtful:
            self._add_question(
                session, "doubtful_policy", key="doubtful-policy",
                title=f"{len(doubtful)} line(s) have an unclear speaker",
                body="The narrator can read them, or you can choose the speaker of each one.",
                options=[
                    {"value": "narrator", "label": "Let the narrator read them"},
                    {"value": "each", "label": "Let me choose each speaker"},
                ],
            )
        self._settle(session, "review")
        _log(session, "Speaker identification finished")

    def _settle(self, session: Dict, phase: str) -> None:
        session["phase"] = phase
        session["status"] = "waiting_user" if any(q["status"] == "pending" for q in session["questions"]) else "idle"
        session["progress"]["label"] = "Waiting for your answers" if session["status"] == "waiting_user" else "Ready"

    # --------------------------------------------------------------- questions
    def _add_question(self, session: Dict, qtype: str, *, key: str, title: str, body: str = "",
                      options: Optional[List[Dict]] = None, payload: Optional[Dict] = None,
                      kind: str = "choice", items: Optional[List[Dict]] = None) -> Optional[Dict]:
        for question in session["questions"]:
            if question["type"] == qtype and question["key"] == key and question["status"] == "pending":
                return None
        question = {
            "id": f"q{len(session['questions']) + 1:04d}",
            "type": qtype,
            "key": key,
            "kind": kind,
            "title": title,
            "body": body,
            "options": options or [],
            "items": items or [],
            "payload": payload or {},
            "status": "pending",
            "answer": None,
            "created_at": utc_now(),
        }
        session["questions"].append(question)
        return question

    def answer(self, session_id: str, question_id: str, answer) -> Dict:
        follow_up: Dict = {}

        def apply(session):
            question = next((q for q in session["questions"] if q["id"] == question_id), None)
            if question is None:
                raise StoryCastError("Unknown question", "unknown_question", 404)
            if question["status"] != "pending":
                if question.get("answer") == answer:
                    return  # idempotent repeat
                raise StoryCastError("This question was already answered", "already_answered", 409)
            value = self._validate_answer(question, answer)
            handler = getattr(self, f"_on_{question['type']}")
            handler(session, question, value, follow_up)
            question["status"] = "answered"
            question["answer"] = answer
            question["answered_at"] = utc_now()
            if session["status"] in ("waiting_user", "idle") and not follow_up.get("start"):
                self._settle(session, session["phase"])
        session = self.store.update(session_id, apply)
        start = follow_up.get("start")
        if start == "attribution":
            return self.start_attribution(session_id)
        if start == "rerun":
            return self.start_rerun(session_id)
        if start == "casting":
            return self._restart_casting(session_id)
        return session

    @staticmethod
    def _validate_answer(question: Dict, answer):
        if question["kind"] == "review":
            accepted = answer.get("accepted") if isinstance(answer, dict) else None
            if not isinstance(accepted, list):
                raise StoryCastError("Review answers need an 'accepted' list", "invalid_answer")
            valid = {item["id"] for item in question["items"]}
            if any(item not in valid for item in accepted):
                raise StoryCastError("Unknown review item", "invalid_answer")
            return accepted
        valid = {option["value"] for option in question["options"]}
        if answer not in valid:
            raise StoryCastError("Choose one of the offered options", "invalid_answer")
        return answer

    def _on_budget_limit(self, session, question, value, follow_up):
        budget = session["budget"]
        if value == "raise":
            budget["limit"] = int(budget.get("limit") or 0) + BUDGET_STEP
        elif value == "unlimited":
            budget["limit"] = 0
        elif value == "local_only":
            budget["local_only"] = True
        else:
            session["status"] = "paused"
            return
        _log(session, f"Budget updated: {value}")
        phase = question["payload"].get("resume_phase")
        if phase == "attribution":
            follow_up["start"] = "attribution"
        elif phase == "rerun":
            follow_up["start"] = "rerun"
        elif phase == "casting":
            follow_up["start"] = "casting"

    def _on_narrator_identity(self, session, question, value, follow_up):
        session["narration"]["voice"] = None if value == NARRATOR_ID else value
        session["narration"]["decided"] = True

    def _on_merge_characters(self, session, question, value, follow_up):
        if value == "merge":
            registry = CharacterRegistry(session["characters"])
            registry.merge(question["payload"]["merge"], question["payload"]["keep"])
            _log(session, "Merged duplicate characters")

    def _on_doubtful_policy(self, session, question, value, follow_up):
        segments = _segments(session)
        registry = CharacterRegistry(session["characters"])
        doubtful = [s for s in segments if is_doubtful(s)]
        if value == "narrator":
            for segment in doubtful:
                segment.speaker = NARRATOR_ID
                segment.confidence = 1.0
                segment.origin = "policy"
            _store_segments(session, segments)
            return
        source = session["source"]
        everyone = [c for c in registry.active() if c["id"] != NARRATOR_ID]
        for segment in doubtful:
            preferred = [cid for cid in [segment.speaker, *segment.candidates]
                         if cid and cid not in (UNKNOWN_SPEAKER, NARRATOR_ID)]
            ordered = []
            for cid in preferred + [c["id"] for c in everyone]:
                resolved = registry.resolve(cid)
                if resolved and resolved not in ordered:
                    ordered.append(resolved)
            options = [{"value": cid, "label": registry.by_id(cid)["name"]} for cid in ordered]
            options.append({"value": NARRATOR_ID, "label": "Narrator"})
            self._add_question(
                session, "doubtful_line", key=segment.id,
                title=source[segment.start:segment.end][:300],
                body=self._context_snippet(session, segment),
                options=options,
                payload={"segment": segment.id},
            )

    def _context_snippet(self, session: Dict, segment: Segment) -> str:
        source = session["source"]
        start = max(0, segment.start - 160)
        end = min(len(source), segment.end + 160)
        return ("…" if start else "") + source[start:end].replace("\n", " ") + ("…" if end < len(source) else "")

    def _on_doubtful_line(self, session, question, value, follow_up):
        self._apply_correction(session, question["payload"]["segment"], value, offer_rerun=False)
        remaining = [q for q in session["questions"]
                     if q["type"] == "doubtful_line" and q["status"] == "pending" and q["id"] != question["id"]]
        if not remaining:
            self._offer_rerun(session)

    def _on_rerun_with_examples(self, session, question, value, follow_up):
        if value == "rerun":
            session["pending_rerun_targets"] = question["payload"].get("targets", [])
            follow_up["start"] = "rerun"
        else:
            session["pending_rerun_targets"] = []

    def _on_review_changes(self, session, question, accepted, follow_up):
        segments = _segments(session)
        by_id = {s.id: s for s in segments}
        changes = {item["id"]: item for item in question["items"]}
        applied = 0
        for seg_id in accepted:
            item = changes[seg_id]
            segment = by_id.get(item["segment"])
            if not segment or segment.locked or segment.speaker != item["from_id"]:
                continue  # stale: the user changed this line meanwhile
            segment.speaker = item["to_id"]
            segment.confidence = item.get("confidence", 0.8)
            segment.origin = "llm"
            applied += 1
        _store_segments(session, segments)
        _log(session, f"Applied {applied} reviewed change(s)")

    def _on_share_voices(self, session, question, value, follow_up):
        if value != "approve":
            _log(session, "Voice sharing declined: assign the remaining characters manually")
            return
        casting = session["casting"]
        for proposal in question["payload"].get("proposals", []):
            casting["assignments"][proposal["character"]] = proposal["voice"]
            casting["origin"][proposal["character"]] = "shared"
            session["approvals"].append({
                "type": "share_voice",
                "voice": proposal["voice"],
                "characters": sorted([proposal["character"], proposal["share_with"]]),
                "question": question["id"],
                "at": utc_now(),
            })
        _log(session, "Voice sharing approved")

    def _on_catalog_language(self, session, question, value, follow_up):
        if value == "use_all":
            session["casting"]["language_override"] = True
            follow_up["start"] = "casting"

    # ------------------------------------------------------------- corrections
    def _apply_correction(self, session: Dict, segment_id: str, speaker: str, *, offer_rerun: bool) -> None:
        registry = CharacterRegistry(session["characters"])
        resolved = NARRATOR_ID if speaker == NARRATOR_ID else registry.resolve(speaker)
        if not resolved:
            raise StoryCastError("Unknown character", "unknown_character", 404)
        segments = _segments(session)
        segment = next((s for s in segments if s.id == segment_id), None)
        if segment is None or segment.kind != KIND_DIALOGUE:
            raise StoryCastError("Only speech segments can be reassigned", "invalid_segment", 400)
        previous = segment.speaker
        segment.speaker = resolved
        segment.confidence = 1.0
        segment.locked = True
        segment.origin = "user"
        _store_segments(session, segments)
        if previous != resolved:
            source = session["source"]
            previous_char = registry.by_id(previous) if previous else None
            session["examples"].append({
                "id": f"e{len(session['examples']) + 1:04d}",
                "segment": segment.id,
                "text": source[segment.start:segment.end],
                "context": self._context_snippet(session, segment),
                "speaker_id": resolved,
                "speaker_key": registry.by_id(resolved)["key"],
                "previous_key": previous_char["key"] if previous_char else None,
                "previous_id": previous,
                "enabled": True,
            })
        if offer_rerun and previous != resolved:
            similar = find_similar_segments(segments, segment, previous)
            if similar:
                self._add_question(
                    session, "rerun_with_examples", key="rerun",
                    title=f"Re-check {len(similar)} similar line(s) using your correction as an example?",
                    body="The model proposes changes; you review them before anything is applied.",
                    options=[{"value": "rerun", "label": "Yes, re-check them"},
                             {"value": "skip", "label": "No, keep them"}],
                    payload={"targets": similar},
                )

    def _offer_rerun(self, session: Dict) -> None:
        segments = _segments(session)
        corrected = {e["segment"] for e in session["examples"] if e.get("enabled", True)}
        if not corrected:
            return
        targets = set()
        by_id = {s.id: s for s in segments}
        for seg_id in corrected:
            segment = by_id.get(seg_id)
            if segment:
                targets.update(find_similar_segments(segments, segment, None))
        if targets:
            self._add_question(
                session, "rerun_with_examples", key="rerun",
                title=f"Re-check {len(targets)} nearby line(s) using your answers as examples?",
                body="The model proposes changes; you review them before anything is applied.",
                options=[{"value": "rerun", "label": "Yes, re-check them"},
                         {"value": "skip", "label": "No, keep them"}],
                payload={"targets": sorted(targets)},
            )

    def correct_segment(self, session_id: str, segment_id: str, speaker: str) -> Dict:
        def apply(session):
            if session["status"] == "running":
                raise StoryCastError("Wait until the current step finishes", "busy", 409)
            self._apply_correction(session, segment_id, speaker, offer_rerun=True)
            self._settle(session, session["phase"])
        return self.store.update(session_id, apply)

    def set_example_enabled(self, session_id: str, example_id: str, enabled: bool) -> Dict:
        def apply(session):
            example = next((e for e in session["examples"] if e["id"] == example_id), None)
            if example is None:
                raise StoryCastError("Unknown example", "unknown_example", 404)
            example["enabled"] = bool(enabled)
        return self.store.update(session_id, apply)

    def update_character(self, session_id: str, char_id: str, *, name: Optional[str] = None,
                         gender: Optional[str] = None) -> Dict:
        from .registry import normalize_gender

        def apply(session):
            registry = CharacterRegistry(session["characters"])
            character = registry.by_id(char_id)
            if character is None:
                raise StoryCastError("Unknown character", "unknown_character", 404)
            if name is not None and name.strip():
                character["name"] = name.strip()[:80]
            if gender is not None and char_id != NARRATOR_ID:
                character["gender"] = normalize_gender(gender)
        return self.store.update(session_id, apply)

    # ------------------------------------------------------------------- rerun
    def start_rerun(self, session_id: str) -> Dict:
        def begin(session):
            if session["status"] == "running":
                raise StoryCastError("Auto cast is already running", "busy", 409)
            if not session.get("pending_rerun_targets"):
                raise StoryCastError("Nothing to re-check", "nothing_to_rerun")
            self._begin(session, session.get("phase") or "review", "Re-checking lines with your examples")
        session = self.store.update(session_id, begin)
        self._spawn(session_id, self._rerun_worker, session["generation"])
        return session

    def _rerun_worker(self, session_id: str, generation: int) -> None:
        session = self._check_generation(session_id, generation)
        targets = set(session.get("pending_rerun_targets") or [])
        segments = _segments(session)
        batches = build_batches(segments, targets)
        proposals: Dict[str, Dict] = {}
        for index, batch in enumerate(batches):
            session = self._check_generation(session_id, generation)
            segments = _segments(session)
            registry = CharacterRegistry(session["characters"])
            built = build_attribution_prompt(session["source"], segments, batch, registry,
                                             examples=session.get("examples", []), only_ids=targets)
            try:
                result, _calls = ask_json(lambda p: self._call_llm(session_id, p), built["prompt"], ATTRIBUTION_SCHEMA)
            except LLMJSONError:
                continue
            except Exception as exc:
                self._handle_worker_error(session_id, exc, "rerun")
                return
            # Proposals only: characters may be registered, segments untouched.
            def collect(s, result=result, built=built, index=index):
                if s.get("generation") != generation:
                    raise SessionStopped()
                reg = CharacterRegistry(s["characters"])
                proposals.update(apply_attribution(result, _segments(s), reg, built["targets"], write=False))
                s["progress"] = {"done": index + 1, "total": len(batches), "label": "Re-checking lines"}
            try:
                self.store.update(session_id, collect)
            except SessionStopped:
                return

        def finish(s):
            if s.get("generation") != generation:
                raise SessionStopped()
            registry = CharacterRegistry(s["characters"])
            source = s["source"]
            items = []
            for segment in _segments(s):
                proposal = proposals.get(segment.id)
                if not proposal or segment.locked or proposal["speaker"] in (UNKNOWN_SPEAKER, segment.speaker):
                    continue
                before = registry.by_id(segment.speaker) if segment.speaker else None
                after = registry.by_id(proposal["speaker"])
                items.append({
                    "id": f"c{len(items) + 1:04d}",
                    "segment": segment.id,
                    "text": source[segment.start:segment.end][:300],
                    "from_id": segment.speaker,
                    "from": before["name"] if before else "Unknown",
                    "to_id": proposal["speaker"],
                    "to": after["name"] if after else proposal["speaker"],
                    "confidence": proposal["confidence"],
                })
            s["pending_rerun_targets"] = []
            if items:
                self._add_question(
                    s, "review_changes", key=f"review-{s['generation']}", kind="review",
                    title=f"The model proposes {len(items)} change(s)",
                    body="Accept the changes you agree with. Lines you corrected are never changed.",
                    items=items,
                )
            else:
                _log(s, "Re-check finished without changes")
            self._settle(s, s["phase"])
        try:
            self.store.update(session_id, finish)
        except SessionStopped:
            return

    # ------------------------------------------------------------- materialize
    def character_stats(self, session: Dict) -> Dict[str, Dict]:
        registry = CharacterRegistry(session["characters"])
        stats: Dict[str, Dict] = {}
        narration_voice = session["narration"].get("voice")
        for segment in _segments(session):
            if segment.kind not in (KIND_DIALOGUE, "narration", "heading"):
                continue
            speaker = effective_speaker(segment, registry, narration_voice)
            entry = stats.setdefault(speaker, {"lines": 0, "words": 0, "doubtful": 0})
            entry["lines"] += 1
            entry["words"] += len(session["source"][segment.start:segment.end].split())
            if is_doubtful(segment):
                entry["doubtful"] += 1
        return stats

    def materialize(self, session_id: str, current_text: Optional[str] = None) -> Dict:
        """Build the tagged manuscript. ``current_text`` (the editor content) is
        only compared, so the UI can warn before replacing edited text."""
        output: Dict = {}

        def apply(session):
            registry = CharacterRegistry(session["characters"])
            result = materialize(session["source"], _segments(session), registry,
                                 session["narration"].get("voice"))
            session["materialized"] = {"hash": source_hash(result["text"]), "at": utc_now()}
            output.update(result)
            if current_text is not None:
                current = str(current_text)
                output["current_matches"] = (
                    current.strip() == session["source"].strip()
                    or strip_speaker_tags(current).strip() == session["source"].strip()
                )
        session = self.store.update(session_id, apply)
        output["voices"] = self._voices_by_tag(session)
        output["session"] = self.public_state(session)
        return output

    def _voices_by_tag(self, session: Dict) -> Dict[str, str]:
        registry = CharacterRegistry(session["characters"])
        tags = registry.assign_tags()
        assignments = session["casting"].get("assignments") or {}
        return {tags[cid]: voice for cid, voice in assignments.items() if cid in tags and voice}

    # ----------------------------------------------------------------- casting
    def start_casting(self, session_id: str, engine: str, catalog: List[Dict]) -> Dict:
        normalized = normalize_catalog(catalog)
        if not normalized:
            raise StoryCastError("No voices are available for the selected engine", "empty_catalog")

        def begin(session):
            if session["status"] == "running":
                raise StoryCastError("Auto cast is already running", "busy", 409)
            if session["phase"] == "attribution":
                raise StoryCastError("Finish identifying speakers first", "not_ready", 409)
            if session["casting"].get("engine") != engine:
                session["casting"] = {"engine": engine, "assignments": {}, "alternatives": {}, "origin": {}}
            session["casting"]["engine"] = engine
            session["casting"]["catalog"] = normalized
            self._begin(session, "casting", "Casting voices")
        session = self.store.update(session_id, begin)
        self._spawn(session_id, self._casting_worker, session["generation"])
        return session

    def _restart_casting(self, session_id: str) -> Dict:
        def begin(session):
            self._begin(session, "casting", "Casting voices")
        session = self.store.update(session_id, begin)
        self._spawn(session_id, self._casting_worker, session["generation"])
        return session

    def _casting_worker(self, session_id: str, generation: int) -> None:
        session = self._check_generation(session_id, generation)
        registry = CharacterRegistry(session["characters"])
        stats = self.character_stats(session)
        characters = []
        for character in registry.active():
            entry = stats.get(character["id"])
            if not entry:
                continue
            characters.append({**character, "lines": entry["lines"], "words": entry["words"]})
        casting = session["casting"]
        catalog = casting.get("catalog") or []
        voices, matched = filter_catalog_for_language(catalog, session.get("language", ""))
        if not matched and not casting.get("language_override"):
            def ask(s):
                if s.get("generation") != generation:
                    raise SessionStopped()
                self._add_question(
                    s, "catalog_language", key="catalog-language",
                    title=f"No voice of this engine declares the story language ({s.get('language') or 'unknown'})",
                    body="Voices in another language may mispronounce the text. Choose another engine, or use the whole catalog.",
                    options=[{"value": "use_all", "label": "Use the whole catalog anyway"},
                             {"value": "stop", "label": "Stop; I will choose another engine"}],
                )
                self._settle(s, "casting")
            try:
                self.store.update(session_id, ask)
            except SessionStopped:
                pass
            return
        manual = {cid: voice for cid, voice in (casting.get("assignments") or {}).items()
                  if casting.get("origin", {}).get(cid) == "manual" and voice}
        rankings: Dict = {}
        try:
            prompt = build_ranking_prompt(characters, voices, session.get("language", ""), casting.get("engine", ""))
            result, _calls = ask_json(lambda p: self._call_llm(session_id, p), prompt, RANKING_SCHEMA)
            rankings = parse_rankings(result, characters, voices)
        except LLMJSONError:
            rankings = heuristic_rankings(characters, voices)
        except Exception as exc:
            if isinstance(exc, BudgetExceeded):
                self._handle_worker_error(session_id, exc, "casting")
                return
            logger.warning("Auto cast voice ranking failed, using heuristics: %s", exc)
            rankings = heuristic_rankings(characters, voices)
        outcome = assign_unique(characters, rankings, voices, locked=manual)

        def commit(s):
            if s.get("generation") != generation:
                raise SessionStopped()
            c = s["casting"]
            c["assignments"] = outcome["assignments"]
            c["alternatives"] = outcome["alternatives"]
            c["origin"] = {cid: ("manual" if cid in manual else "auto") for cid in outcome["assignments"]}
            if outcome["unassigned"]:
                proposals = propose_sharing(characters, outcome)
                names = {ch["id"]: ch["name"] for ch in characters}
                if proposals:
                    lines = [f"{names[p['character']]} → shares {names[p['share_with']]}'s voice" for p in proposals]
                    self._add_question(
                        s, "share_voices", key="share",
                        title=f"There are not enough distinct voices for {len(outcome['unassigned'])} character(s)",
                        body="Proposed sharing (least important characters): " + "; ".join(lines)
                             + ". You can also design new voices with Generate voices or switch engines.",
                        options=[{"value": "approve", "label": "Approve the shared voices"},
                                 {"value": "manual", "label": "I will assign them myself"}],
                        payload={"proposals": proposals},
                    )
            _log(s, f"Cast {len(outcome['assignments'])} character(s)")
            self._settle(s, "done")
        try:
            self.store.update(session_id, commit)
        except SessionStopped:
            return

    def assign_voice(self, session_id: str, char_id: str, voice: str, share_confirmed: bool = False) -> Dict:
        """Manual assignment from the UI (a user action, never the model)."""
        def apply(session):
            registry = CharacterRegistry(session["characters"])
            if not registry.by_id(char_id):
                raise StoryCastError("Unknown character", "unknown_character", 404)
            casting = session["casting"]
            holders = [cid for cid, v in casting["assignments"].items() if v == voice and cid != char_id]
            if voice and holders and not share_confirmed:
                names = ", ".join(registry.by_id(cid)["name"] for cid in holders if registry.by_id(cid))
                raise StoryCastError(f"This voice is already used by {names}", "voice_in_use", 409)
            if voice:
                casting["assignments"][char_id] = voice
                casting["origin"][char_id] = "manual"
                if holders:
                    session["approvals"].append({"type": "share_voice", "voice": voice,
                                                 "characters": sorted([char_id, *holders]),
                                                 "question": None, "at": utc_now()})
            else:
                casting["assignments"].pop(char_id, None)
                casting["origin"].pop(char_id, None)
        return self.store.update(session_id, apply)

    # ------------------------------------------------------------- lifecycle
    def pause(self, session_id: str) -> Dict:
        def apply(session):
            if session["status"] == "running":
                session["generation"] = int(session.get("generation", 0)) + 1
                session["status"] = "paused"
                _log(session, "Paused")
        return self.store.update(session_id, apply)

    def resume(self, session_id: str) -> Dict:
        session = self.store.load(session_id)
        if session["status"] not in ("paused", "interrupted", "error"):
            raise StoryCastError("Nothing to resume", "not_paused", 409)
        if session["phase"] == "attribution":
            return self.start_attribution(session_id)
        if session.get("pending_rerun_targets"):
            return self.start_rerun(session_id)
        if session["phase"] == "casting" and session["casting"].get("catalog"):
            return self._restart_casting(session_id)

        def settle(s):
            self._settle(s, s["phase"])
        return self.store.update(session_id, settle)

    def cancel(self, session_id: str) -> Dict:
        def apply(session):
            session["generation"] = int(session.get("generation", 0)) + 1
            session["status"] = "cancelled"
            for question in session["questions"]:
                if question["status"] == "pending":
                    question["status"] = "obsolete"
            _log(session, "Cancelled")
        return self.store.update(session_id, apply)

    def generation_blockers(self, session_id: str) -> List[str]:
        session = self.store.load(session_id)
        blockers = []
        if session["status"] == "running":
            blockers.append("Auto cast is still running")
        pending = [q for q in session["questions"] if q["status"] == "pending"]
        if pending:
            blockers.append(f"{len(pending)} Auto cast question(s) are waiting for an answer")
        return blockers

    # -------------------------------------------------------------- reporting
    def public_state(self, session: Dict, *, include_segments: bool = False) -> Dict:
        registry = CharacterRegistry(session["characters"])
        stats = self.character_stats(session)
        tags = registry.assign_tags()
        casting = session["casting"]
        characters = []
        for character in registry.active():
            entry = stats.get(character["id"], {"lines": 0, "words": 0, "doubtful": 0})
            characters.append({
                "id": character["id"],
                "name": character["name"],
                "key": character["key"],
                "tag": tags.get(character["id"], ""),
                "gender": character["gender"],
                "role": character["role"],
                "aliases": character.get("aliases", []),
                "description": character.get("description", ""),
                "lines": entry["lines"],
                "words": entry["words"],
                "doubtful": entry["doubtful"],
                "voice": casting.get("assignments", {}).get(character["id"], ""),
                "voice_origin": casting.get("origin", {}).get(character["id"], ""),
                "alternatives": casting.get("alternatives", {}).get(character["id"], []),
            })
        characters.sort(key=lambda c: (c["id"] != NARRATOR_ID, -c["words"]))
        segments = _segments(session)
        dialogue = [s for s in segments if s.kind == KIND_DIALOGUE]
        state = {
            "id": session["id"],
            "rev": session["rev"],
            "project_id": session.get("project_id"),
            "title": session.get("title"),
            "status": session["status"],
            "phase": session["phase"],
            "progress": session["progress"],
            "error": session.get("error", ""),
            "language": session.get("language", ""),
            "narration": session["narration"],
            "budget": session["budget"],
            "characters": characters,
            "questions": [q for q in session["questions"] if q["status"] == "pending"],
            "answered_questions": sum(1 for q in session["questions"] if q["status"] == "answered"),
            "examples": session.get("examples", []),
            "casting": {k: v for k, v in casting.items() if k != "catalog"},
            "counts": {
                "segments": len(segments),
                "speech": len(dialogue),
                "doubtful": sum(1 for s in dialogue if is_doubtful(s)),
                "corrected": sum(1 for s in dialogue if s.locked),
            },
            "materialized": session.get("materialized"),
            "source_hash": session["source_hash"],
            "log": session.get("log", [])[-15:],
            "updated_at": session.get("updated_at"),
        }
        if include_segments:
            source = session["source"]
            state["segments"] = [{
                "id": s.id,
                "text": source[s.start:s.end],
                "para": s.para,
                "speaker": registry.resolve(s.speaker) if s.speaker and s.speaker != UNKNOWN_SPEAKER else UNKNOWN_SPEAKER,
                "confidence": round(s.confidence, 2),
                "locked": s.locked,
                "doubtful": is_doubtful(s),
            } for s in dialogue]
        return state
