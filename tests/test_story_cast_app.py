"""Auto cast integration with app.py: strict assignments, profile filter, routes."""

from __future__ import annotations

import json

import pytest

import app as app_module
from src.story_cast import StoryCastService, StoryCastStore, create_story_cast_blueprint


@pytest.fixture(autouse=True)
def isolate_llm_profile_usage(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "LLM_PROFILE_USAGE_FILE", tmp_path / "llm_profile_usage.json")


def test_strict_assignments_report_speakers_that_would_inherit_a_voice():
    text = "[narrator]Hi.[/narrator] [ana-female]Hello.[/ana-female] [bob-male]Yo.[/bob-male]"
    assignments = {"narrator": {"voice": "a"}, "ana-female": {"voice": "b"}}
    assert app_module._strict_assignment_problems(text, assignments) == ["bob-male"]
    assignments["bob-male"] = {"voice": "c"}
    assert app_module._strict_assignment_problems(text, assignments) == []


def test_profile_filter_restricts_chain_to_local_profiles(monkeypatch):
    used = []

    def fake_run(prompt, config, provider, model_override=None, api_key_override=None, **_kwargs):
        used.append(provider)
        return "ok"

    monkeypatch.setattr(app_module, "_run_llm_prompt_for_provider", fake_run)
    config = {
        "llm_provider": "openrouter",
        "openrouter_api_key": "key",
        "llm_local_model": "qwen",
        "llm_backup_profiles": [{"id": "local", "name": "Local", "provider": "local", "model": "qwen"}],
    }
    text, profile, _failures = app_module._run_llm_prompt_with_failover(
        "prompt", config, profile_filter=lambda p: p.get("provider") == "local")
    assert text == "ok" and used == ["local"] and profile["provider"] == "local"

    with pytest.raises(app_module.LLMProviderChainError):
        app_module._run_llm_prompt_with_failover(
            "prompt", {"llm_provider": "openrouter", "openrouter_api_key": "key"},
            profile_filter=lambda p: p.get("provider") == "local")


def test_generate_is_blocked_while_auto_cast_questions_are_pending(monkeypatch, tmp_path):
    def fake_llm(prompt, local_only):
        ids = [part.split(" ")[0] for part in prompt.split("<<")[1:] if part.startswith("s") and " SPEECH>>" in part]
        return json.dumps({"attributions": [{"id": i, "speaker": "unknown", "confidence": 0} for i in ids]}), {"provider": "local"}, []

    service = StoryCastService(StoryCastStore(tmp_path / "cast"), fake_llm)
    monkeypatch.setattr(app_module, "STORY_CAST_SERVICE", service)
    session = service.create("“Who is there?” asked someone.")
    service.start_attribution(session["id"])
    service.wait(session["id"])

    client = app_module.app.test_client()
    response = client.post("/api/generate", json={
        "text": "[narrator]Hi[/narrator]",
        "voice_assignments": {"narrator": {"voice": "af_heart"}},
        "story_cast_session_id": session["id"],
    })
    assert response.status_code == 409
    assert response.get_json()["code"] == "story_cast_pending"


def test_routes_create_answer_and_materialize(tmp_path):
    from flask import Flask

    def fake_llm(prompt, local_only):
        ids = [part.split(" ")[0] for part in prompt.split("<<")[1:] if part.startswith("s") and " SPEECH>>" in part]
        return json.dumps({
            "language": "en",
            "characters": [{"key": "mary", "name": "Mary", "gender": "female"}],
            "attributions": [{"id": i, "speaker": "mary", "confidence": 0.9} for i in ids],
        }), {"provider": "local"}, []

    service = StoryCastService(StoryCastStore(tmp_path / "cast"), fake_llm)
    flask_app = Flask(__name__)
    flask_app.register_blueprint(create_story_cast_blueprint(service))
    client = flask_app.test_client()

    tagged = client.post("/api/cast/sessions", json={"text": "[bob]Hi[/bob]"})
    assert tagged.status_code == 409 and tagged.get_json()["code"] == "already_tagged"

    created = client.post("/api/cast/sessions", json={"text": "“Hello,” said Mary."}).get_json()
    session_id = created["session"]["id"]
    service.wait(session_id)
    state = client.get(f"/api/cast/sessions/{session_id}?segments=1").get_json()["session"]
    assert state["status"] == "idle" and state["segments"][0]["speaker"] != "unknown"
    materialized = client.post(f"/api/cast/sessions/{session_id}/materialize").get_json()
    assert materialized["text"] == "[mary-female]“Hello,”[/mary-female] [narrator]said Mary.[/narrator]"
    assert client.get("/api/cast/sessions/0123").status_code == 404
