# Edit, Rebuild, and Repair Library Items

TTS-Story preserves individual chunk audio and review metadata so many completed jobs can be repaired without starting from the manuscript. The available repair depends on which source files still exist.

![Inline chunk review panel under a chapter row with speaker regeneration, chunk rows, and rebuild controls](../../../static/help/screenshots/chunk-review.png)

*The inline chunk review panel keeps the saved text, voice, engine, effects, and playback controls together for targeted repairs.*

## Know the three operations

**Edit** changes saved text or metadata. Editing chunk text alone does not create new audio.

**Regenerate** calls a TTS engine to synthesize replacement audio for one or more chunks.

**Rebuild** merges the current saved chunk files into chapter and combined outputs. Rebuild does not synthesize speech.

This distinction prevents the most common repair mistake: regenerating a chunk, hearing the correction in review, and then downloading an older compiled chapter.

## Correct a completed item

1. Open [Audio Library](app:library).
2. Expand the production and click **Review chunks** on a chapter row or on the **Full story** row.
3. Locate and play the faulty chunk.
4. Click **Edit** on the chunk, then edit its text or adjust its engine, voice, speed, pitch, or silence.
5. Click **Regenerate** and listen to the replacement.
6. Rebuild the affected chapter.
7. If a Full story exists, use the production row's **Rebuild** action to update all compiled outputs.

Bulk speaker regeneration is available, but first prove the chosen settings on one chunk. Cloud bulk regeneration can consume quota quickly.

Full story review automatically restores the completed item to the internal review state when regeneration is requested. This is background bookkeeping; the current interface keeps you in the Library review panel rather than sending you back to the Queue page.

## Use targeted rebuild controls

Inside chunk review, **Rebuild chapter audio file** (single-chapter review) or **Rebuild chapter** on each chapter (Full story review) rebuilds one chapter, and **Recompile audio** in the panel footer recompiles the production. The production row's **Rebuild** action rebuilds each chapter from its saved chapter chunks and independently rebuilds the Full story from its saved full-story chunks. It does not use the newly compiled chapter files as the Full story source.

Use Rebuild when:

- a regenerated chunk is absent from the downloaded chapter;
- a chapter or combined output is missing;
- compiled chapter audio needs refreshing; or
- chunk files play correctly but a merged file does not.

Rebuild can succeed only when the required chunk files still exist. It cannot reconstruct deleted or corrupt speech from text. Regenerate the missing chunk first when review metadata and an engine assignment remain available.

## Repair pronunciation without editing every chunk

Open **… → Alt words** on the production row, add the source and spoken replacement, save, then regenerate affected chunks. Because matching is a case-insensitive substring operation, verify that the source does not also occur inside unrelated words.

## Metadata and names

- Choose **Rename title** in the production's **…** menu.
- Use **Rename chapter** in a chapter row's **…** menu (or in the chunk review header).
- Use **Edit metadata** for Title, Author, Genre, Year, and Description.

Metadata edits affect packaging and display. They do not change speaker tags, chunk text, or audio by themselves.

## When repair is no longer possible

If the Library item was deleted, its `static/audio/<job-id>` directory and associated files are removed. If individual chunks are missing and cannot be regenerated, restore the item from a filesystem backup or rerun generation from a saved manuscript/Project.

Projects are stored separately in the backend's shared project library and are not a backup of generated audio or global settings. See [Save and Restore Projects](help:projects) and [Local Data, API Keys, and Backups](help:data-storage).
