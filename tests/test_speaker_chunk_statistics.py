"""Per-speaker chunk counts used by the Generate screen's Cast list and speaker drawer."""
from __future__ import annotations

import app as app_module
from src.text_processor import TextProcessor


STORY = (
    "[narrator]Once upon a time, in a small village nestled between rolling hills, "
    "there lived a young girl named Alice. She was known for her curious nature.[/narrator]\n"
    "[Alice]This is strange. I've walked these woods a hundred times.[/Alice]\n"
    "[narrator]The path was narrow and winding, covered with moss and fallen leaves.[/narrator]\n"
    "[guardian]I am the Guardian of the Forest.[/guardian]"
)


def test_speaker_chunks_match_generator_chunking_per_speaker():
    processor = TextProcessor(chunk_size=8)
    stats = processor.get_statistics(STORY)

    expected = {}
    for segment in processor.process_text(STORY):
        expected[segment["speaker"]] = expected.get(segment["speaker"], 0) + len(segment["chunks"])

    assert stats["speaker_chunks"] == expected
    # Speaker keys use the same normalized names as stats["speakers"].
    assert set(stats["speaker_chunks"]) == set(stats["speakers"]) == {"narrator", "alice", "guardian"}
    assert stats["speaker_chunks"]["narrator"] > stats["speaker_chunks"]["guardian"] >= 1
    assert sum(stats["speaker_chunks"].values()) == stats["total_chunks"]


def test_speaker_chunks_include_pause_markers_and_untagged_text():
    processor = TextProcessor(chunk_size=500)

    paused = processor.get_statistics("[narrator]First line.[/narrator]\n******\n[bob]Hello there.[/bob]")
    assert sum(paused["speaker_chunks"].values()) == paused["total_chunks"]
    assert paused["speaker_chunks"]["bob"] == 1

    plain = processor.get_statistics("Just a single narrator reading plain text without any tags.")
    assert plain["speaker_chunks"] == {"default": plain["total_chunks"]}


def test_analyze_api_returns_speaker_chunks(monkeypatch):
    monkeypatch.setattr(app_module, "load_config", lambda: dict(app_module.DEFAULT_CONFIG))
    client = app_module.app.test_client()

    response = client.post("/api/analyze", json={"text": STORY})

    assert response.status_code == 200
    statistics = response.get_json()["statistics"]
    assert set(statistics["speaker_chunks"]) == {"narrator", "alice", "guardian"}
    assert sum(statistics["speaker_chunks"].values()) == statistics["total_chunks"]
