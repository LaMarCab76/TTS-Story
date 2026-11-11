"""Flask blueprint exposing Auto cast sessions under /api/cast."""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from .service import StoryCastError, StoryCastService
from .store import RevisionConflict, SessionNotFound

logger = logging.getLogger(__name__)


def create_story_cast_blueprint(service: StoryCastService) -> Blueprint:
    blueprint = Blueprint("story_cast", __name__, url_prefix="/api/cast")

    def ok(session=None, **extra):
        payload = {"success": True}
        if session is not None:
            payload["session"] = service.public_state(
                session, include_segments=request.args.get("segments") == "1")
        payload.update(extra)
        return jsonify(payload)

    @blueprint.errorhandler(StoryCastError)
    def handle_story_cast_error(exc: StoryCastError):
        return jsonify({"success": False, "error": str(exc), "code": exc.code}), exc.status

    @blueprint.errorhandler(SessionNotFound)
    def handle_missing(_exc):
        return jsonify({"success": False, "error": "Auto cast session not found", "code": "not_found"}), 404

    @blueprint.errorhandler(RevisionConflict)
    def handle_conflict(exc):
        return jsonify({"success": False, "error": str(exc), "code": "conflict"}), 409

    def body() -> dict:
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    @blueprint.post("/sessions")
    def create_session():
        data = body()
        session = service.create(
            data.get("text") or "",
            project_id=data.get("project_id"),
            strip_existing_tags=data.get("strip_existing_tags") is True,
            title=str(data.get("title") or ""),
        )
        if data.get("start", True):
            session = service.start_attribution(session["id"])
        return ok(session)

    @blueprint.get("/sessions")
    def list_sessions():
        return jsonify({"success": True, "sessions": service.store.list_sessions(request.args.get("project_id"))})

    @blueprint.get("/sessions/<session_id>")
    def get_session(session_id):
        return ok(service.store.load(session_id))

    @blueprint.post("/sessions/<session_id>/pause")
    def pause_session(session_id):
        return ok(service.pause(session_id))

    @blueprint.post("/sessions/<session_id>/resume")
    def resume_session(session_id):
        return ok(service.resume(session_id))

    @blueprint.post("/sessions/<session_id>/cancel")
    def cancel_session(session_id):
        return ok(service.cancel(session_id))

    @blueprint.post("/sessions/<session_id>/answers")
    def answer_question(session_id):
        data = body()
        question_id = str(data.get("question_id") or "")
        if not question_id:
            raise StoryCastError("question_id is required", "invalid_answer")
        return ok(service.answer(session_id, question_id, data.get("answer")))

    @blueprint.post("/sessions/<session_id>/segments/<segment_id>")
    def correct_segment(session_id, segment_id):
        speaker = str(body().get("speaker") or "")
        if not speaker:
            raise StoryCastError("speaker is required", "invalid_segment")
        return ok(service.correct_segment(session_id, segment_id, speaker))

    @blueprint.post("/sessions/<session_id>/examples/<example_id>")
    def toggle_example(session_id, example_id):
        return ok(service.set_example_enabled(session_id, example_id, body().get("enabled") is not False))

    @blueprint.post("/sessions/<session_id>/characters/<char_id>")
    def update_character(session_id, char_id):
        data = body()
        return ok(service.update_character(session_id, char_id, name=data.get("name"), gender=data.get("gender")))

    @blueprint.post("/sessions/<session_id>/materialize")
    def materialize_session(session_id):
        current_text = body().get("current_text")
        result = service.materialize(session_id, current_text if isinstance(current_text, str) else None)
        return jsonify({"success": True, **result})

    @blueprint.post("/sessions/<session_id>/cast")
    def cast_session(session_id):
        data = body()
        catalog = data.get("catalog")
        if not isinstance(catalog, list):
            raise StoryCastError("A voice catalog list is required", "empty_catalog")
        return ok(service.start_casting(session_id, str(data.get("engine") or ""), catalog[:2000]))

    @blueprint.post("/sessions/<session_id>/voices/<char_id>")
    def assign_voice(session_id, char_id):
        data = body()
        return ok(service.assign_voice(session_id, char_id, str(data.get("voice") or ""),
                                       share_confirmed=data.get("share_confirmed") is True))

    return blueprint
