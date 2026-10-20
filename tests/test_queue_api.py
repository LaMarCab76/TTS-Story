"""Job Queue screen API: additive title / position / output fields on /api/queue and job details."""
import json
import queue

import pytest

import app as app_module


def _job(status="queued", created_at="2026-07-15T19:00:00", **extra):
    entry = {
        "status": status,
        "created_at": created_at,
        "text_preview": "[narrator]Once upon a time.[/narrator]",
        "merge_options": {"output_format": "mp3", "output_bitrate_kbps": 128, "acx_compliance": False},
        "processed_chunks": 0,
        "total_chunks": 7,
    }
    entry.update(extra)
    return entry


@pytest.fixture
def queue_state(monkeypatch):
    state = {}
    pending = queue.Queue()
    monkeypatch.setattr(app_module, "jobs", state)
    monkeypatch.setattr(app_module, "job_queue", pending)
    monkeypatch.setattr(app_module, "current_job_ids", set())
    monkeypatch.setattr(app_module, "current_job_id", None)
    return state, pending


def _get_queue():
    response = app_module.app.test_client().get("/api/queue")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is True
    return {job["job_id"]: job for job in payload["jobs"]}


def test_title_prefers_submitted_collection_title_and_keeps_text_title(queue_state):
    state, _ = queue_state
    state["a"] = _job(
        collection_title="  The   Hidden Path ",
        text_preview="[narrator]Chapter 1 - The hidden passage[/narrator]\n[narrator]Once upon a time.",
    )
    job = _get_queue()["a"]
    assert job["title"] == "The Hidden Path"
    assert job["text_title"] == "Chapter 1 - The hidden passage"


def test_title_falls_back_to_first_sentence_without_tags_or_directions(queue_state):
    state, _ = queue_state
    state["plain"] = _job(
        text_preview="[direction]Read slowly.[/direction]\n***\n[narrator]Once upon a time, in a village. "
                     "Alice lived there.[/narrator]",
    )
    state["cut"] = _job(text_preview="[narrator]Hello there friend[/narr")
    state["open-direction"] = _job(text_preview="Short opening line\n[direction]A direction that was cut off")
    state["empty"] = _job(text_preview="")
    jobs = _get_queue()
    assert jobs["plain"]["title"] == "Once upon a time, in a village."
    assert jobs["cut"]["title"] == "Hello there friend"
    assert jobs["open-direction"]["title"] == "Short opening line"
    assert jobs["empty"]["title"] == ""


def test_long_titles_are_truncated_to_80_chars(queue_state):
    state, _ = queue_state
    state["long"] = _job(text_preview="word " * 60)
    title = _get_queue()["long"]["title"]
    assert len(title) <= 80
    assert title.endswith("…")
    assert not title[:-1].endswith(" ")


def test_breeze_production_title_is_used_only_when_it_is_not_the_text_opening():
    text = "[narrator]Once upon a time there was a long story that keeps going[/narrator]"
    hints = app_module._submitted_queue_title_hints({"production_title": text[:40]}, text)
    assert hints["production_title"] == ""
    hints = app_module._submitted_queue_title_hints({"production_title": "Moon Book", "project_name": ""}, text)
    assert hints["production_title"] == "Moon Book"
    hints = app_module._submitted_queue_title_hints({"book_title": "Sherlock", "project_name": "Draft"}, text)
    assert hints["collection_title"] == "Sherlock"


def test_production_title_is_used_when_no_collection_title(queue_state):
    state, _ = queue_state
    state["breeze"] = _job(collection_title="", production_title="Moonlight Library")
    assert _get_queue()["breeze"]["title"] == "Moonlight Library"


def test_restored_jobs_read_collection_title_from_metadata_once(queue_state, tmp_path, monkeypatch):
    state, _ = queue_state
    job_dir = tmp_path / "restored"
    job_dir.mkdir()
    (job_dir / app_module.JOB_METADATA_FILENAME).write_text(
        json.dumps({"collection_title": "Restored Story"}), encoding="utf-8")
    state["restored"] = _job(status="completed", job_dir=str(job_dir))
    state["no-meta"] = _job(status="completed", job_dir=str(tmp_path / "missing"))

    calls = []
    original = app_module.load_job_metadata
    monkeypatch.setattr(app_module, "load_job_metadata", lambda path: calls.append(path) or original(path))

    first = _get_queue()
    assert first["restored"]["title"] == "Restored Story"
    assert first["no-meta"]["title"] == "Once upon a time."
    assert len(calls) == 2

    second = _get_queue()
    assert second["restored"]["title"] == "Restored Story"
    assert second["no-meta"]["title"] == "Once upon a time."
    assert len(calls) == 2, "metadata.json must only be read once per job"


def test_queue_position_follows_real_dispatch_order(queue_state):
    state, pending = queue_state
    state["first-created"] = _job(created_at="2026-07-15T18:00:00")
    state["resumed"] = _job(created_at="2026-07-15T17:00:00")
    state["paused"] = _job(status="paused")
    state["running"] = _job(status="processing")
    state["dispatched"] = _job(created_at="2026-07-15T20:00:00")  # taken off the queue, waiting for a slot
    state["design"] = _job(job_type="qwen3_voice_design_preview")
    for job_id in ("design", "first-created", "paused", "resumed", "first-created"):
        pending.put({"job_id": job_id})

    jobs = _get_queue()
    assert "design" not in jobs
    assert jobs["dispatched"]["queue_position"] == 1
    assert jobs["first-created"]["queue_position"] == 2
    assert jobs["resumed"]["queue_position"] == 3
    assert jobs["paused"]["queue_position"] is None
    assert jobs["running"]["queue_position"] is None


def test_queued_jobs_expose_the_submit_time_chunk_estimate(queue_state):
    state, pending = queue_state
    state["waiting"] = _job(total_chunks=None)
    state["unknown"] = _job(total_chunks=None)
    pending.put({"job_id": "waiting", "total_chunks": 7})
    pending.put({"job_id": "unknown"})
    jobs = _get_queue()
    assert jobs["waiting"]["estimated_total_chunks"] == 7
    assert jobs["waiting"]["total_chunks"] is None, "the real total stays unset until processing starts"
    assert jobs["unknown"]["estimated_total_chunks"] is None


def test_output_summary_comes_from_merge_options_with_snapshot_fallback(queue_state):
    state, _ = queue_state
    state["mp3"] = _job(merge_options={"output_format": "MP3", "output_bitrate_kbps": 192, "acx_compliance": True})
    state["snapshot"] = _job(merge_options={}, config_snapshot={"output_format": "wav", "output_bitrate_kbps": 0})
    state["broken"] = _job(merge_options="not-a-dict", config_snapshot=None)
    jobs = _get_queue()
    assert (jobs["mp3"]["output_format"], jobs["mp3"]["output_bitrate_kbps"], jobs["mp3"]["acx_compliance"]) == ("mp3", 192, True)
    assert (jobs["snapshot"]["output_format"], jobs["snapshot"]["output_bitrate_kbps"], jobs["snapshot"]["acx_compliance"]) == ("wav", None, False)
    assert (jobs["broken"]["output_format"], jobs["broken"]["output_bitrate_kbps"], jobs["broken"]["acx_compliance"]) == (None, None, False)


def test_existing_queue_fields_are_unchanged(queue_state):
    state, pending = queue_state
    state["a"] = _job()
    pending.put({"job_id": "a"})
    response = app_module.app.test_client().get("/api/queue").get_json()
    assert response["queue_size"] == 1
    job = response["jobs"][0]
    for key in ("job_id", "status", "text_preview", "total_chunks", "processed_chunks", "eta_seconds",
                "chapter_mode", "full_story_requested", "post_process_total", "error"):
        assert key in job


def test_job_details_include_output_summary_error_and_optional_text(queue_state, tmp_path, monkeypatch):
    state, _ = queue_state
    text_path = tmp_path / "job.txt"
    text_path.write_text("[narrator]Hello world.[/narrator]", encoding="utf-8")
    monkeypatch.setattr(app_module, "_load_job_text", lambda path: text_path.read_text(encoding="utf-8") if path else "")
    state["d"] = _job(status="failed", error="Engine crashed", speakers=["narrator"], text_path=str(text_path),
                      eta_seconds=12, chapter_count=3, collection_title="My Book",
                      merge_options={"output_format": "ogg", "output_bitrate_kbps": 160, "acx_compliance": False})
    client = app_module.app.test_client()

    full = client.get("/api/jobs/d/details").get_json()["job"]
    assert full["text"] == "[narrator]Hello world.[/narrator]"
    assert full["error"] == "Engine crashed"
    assert (full["output_format"], full["output_bitrate_kbps"], full["acx_compliance"]) == ("ogg", 160, False)
    assert full["title"] == "My Book"
    assert full["eta_seconds"] == 12
    assert full["chapter_count"] == 3
    assert full["speakers"] == ["narrator"]

    light = client.get("/api/jobs/d/details?include_text=0").get_json()["job"]
    assert light["text"] is None
    assert light["speakers"] == ["narrator"]
    assert light["output_format"] == "ogg"

    assert client.get("/api/jobs/missing/details").status_code == 404


@pytest.fixture
def submit_without_worker(queue_state, monkeypatch, tmp_path):
    """/api/generate with the worker, persistence and engine side effects stubbed out."""
    monkeypatch.setattr(app_module, "start_worker_thread", lambda: None)
    monkeypatch.setattr(app_module, "_persist_job_state", lambda *a, **k: None)
    monkeypatch.setattr(app_module, "_archive_old_jobs", lambda: None)
    monkeypatch.setattr(app_module, "_consume_engine_first_run_notice", lambda *a: False)
    monkeypatch.setattr(app_module, "_write_job_text", lambda *a: str(tmp_path / "input.txt"))
    monkeypatch.setattr(app_module, "OUTPUT_DIR", tmp_path / "audio")
    monkeypatch.setattr(app_module, "load_config", lambda: {**app_module.DEFAULT_CONFIG, "tts_engine": "kokoro"})
    client = app_module.app.test_client()

    def submit(**body):
        assignments = {"narrator": {"voice": "af_heart", "lang_code": "a"}}
        response = client.post("/api/generate", json={"tts_engine": "kokoro", "voice_assignments": assignments, **body})
        assert response.status_code == 200, response.get_json()
        return response.get_json()["job_id"]

    return submit


def test_generate_keeps_the_submitted_project_title_for_the_queue(submit_without_worker):
    text = "[narrator]Chapter 1 - The hidden passage[/narrator]\n[narrator]Once upon a time.[/narrator]"
    titled = submit_without_worker(text=text, project_name="  The   Hidden Path ")
    produced = submit_without_worker(text=text, production_title="Moonlight Library")
    untitled = submit_without_worker(text=text)

    # The hints live on the job entry itself (not only in metadata.json).
    assert app_module.jobs[titled]["collection_title"] == "The Hidden Path"
    assert app_module.jobs[produced]["production_title"] == "Moonlight Library"

    jobs = _get_queue()
    assert jobs[titled]["title"] == "The Hidden Path"
    assert jobs[titled]["text_title"] == "Chapter 1 - The hidden passage"
    assert jobs[produced]["title"] == "Moonlight Library"
    assert jobs[untitled]["title"] == "Chapter 1 - The hidden passage"
    assert [jobs[j]["queue_position"] for j in (titled, produced, untitled)] == [1, 2, 3]
    assert jobs[titled]["estimated_total_chunks"] >= 1
