"""Per-speaker chunk counts used by the Generate screen's Cast list and speaker drawer.

Scope: /api/analyze counts chunks the way a job is chunked WITHOUT "Separate file per
chapter". In chapter mode the generator chunks each detected section on its own, so its
total can differ slightly from the analyze counts (a pre-existing difference that also
affects total_chunks); these tests cover the non-chapter path.
"""
from __future__ import annotations

import pytest

import app as app_module
from src.text_processor import TextProcessor


STORY = (
    "[narrator]Once upon a time, in a small village nestled between rolling hills, "
    "there lived a young girl named Alice. She was known for her curious nature.[/narrator]\n"
    "[Alice]This is strange. I've walked these woods a hundred times.[/Alice]\n"
    "[narrator]The path was narrow and winding, covered with moss and fallen leaves.[/narrator]\n"
    "[guardian]I am the Guardian of the Forest.[/guardian]"
)

# Long enough that every engine's chunk limit splits the narrator into several chunks.
LONG_STORY = (
    "[narrator]" + " ".join(
        f"Sentence {index} walks the narrow path between the hills, past the mill and the old stone bridge."
        for index in range(60)
    ) + "[/narrator]\n"
    "[Alice]" + " ".join(f"Line {index}, I have walked these woods a hundred times before." for index in range(20)) + "[/Alice]\n"
    "[guardian]I am the Guardian of the Forest.[/guardian]"
)

GENERATOR_ENGINES = [
    "kokoro", "gemini_tts", "chatterbox_turbo_local", "audio8_tts", "breeze_tts_2", "openai_tts",
]


def _counts_by_speaker(segments):
    counts = {}
    for segment in segments:
        counts[segment["speaker"]] = counts.get(segment["speaker"], 0) + len(segment["chunks"])
    return counts


@pytest.mark.parametrize("engine", GENERATOR_ENGINES)
def test_speaker_chunks_match_generator_chunking_per_engine(monkeypatch, engine):
    config = dict(app_module.DEFAULT_CONFIG)
    monkeypatch.setattr(app_module, "load_config", lambda: dict(config))
    response = app_module.app.test_client().post("/api/analyze", json={"text": LONG_STORY, "tts_engine": engine})
    assert response.status_code == 200, response.get_json()
    statistics = response.get_json()["statistics"]

    # Total: the generator's own estimate for a non-chapter job with this engine.
    generator_total = app_module.estimate_total_chunks(
        LONG_STORY, False, int(config["chunk_size"]), engine_name=engine, config=config,
    )
    assert sum(statistics["speaker_chunks"].values()) == generator_total == statistics["total_chunks"]

    # Per speaker: the engine's processor as the generator builds it.
    processor = app_module._create_text_processor_for_engine(engine, int(config["chunk_size"]), config)
    assert statistics["speaker_chunks"] == _counts_by_speaker(processor.process_text(LONG_STORY))
    assert set(statistics["speaker_chunks"]) == {"narrator", "alice", "guardian"}
    assert statistics["speaker_chunks"]["narrator"] > 1, "the fixture must exercise multi-chunk speakers"
    assert statistics["speaker_chunks"]["guardian"] == 1


def test_speaker_chunks_use_normalized_speaker_names():
    processor = TextProcessor(chunk_size=8)
    stats = processor.get_statistics(STORY)

    assert stats["speaker_chunks"] == _counts_by_speaker(processor.process_text(STORY))
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
