from src.library_metadata import resolve_new_collection_title, merge_generated_library_metadata


def test_book_title_preferred_over_project_name():
    assert resolve_new_collection_title({"book_title": "  Sherlock Holmes  ", "project_name": "Prepared v2"}) == "Sherlock Holmes"


def test_saved_project_fallback():
    assert resolve_new_collection_title({"book_title": "", "project_name": "My Story"}) == "My Story"


def test_unsaved_explicit_title_and_untitled_prose():
    assert resolve_new_collection_title({"text": "[direction]Announce.[/direction]\n[narrator]Title: My Story[/narrator]\nBy Me"}) == "My Story"
    assert resolve_new_collection_title({"text": "Once upon a time there was a rabbit."}) is None


def test_completion_preserves_title_and_manual_renames():
    for title in ("Sherlock Holmes", "My custom library name"):
        metadata = merge_generated_library_metadata({"collection_title": title}, {"chapters": [{"title": "Chapter 1"}]})
        assert metadata["collection_title"] == title
        assert metadata["chapters"][0]["title"] == "Chapter 1"
