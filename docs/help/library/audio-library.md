# Use the Audio Library

Completed generation jobs are collected in [Audio Library](app:library). Library is the working area for listening, downloading, correcting chunks, and rebuilding final audio. It is also where review takes place; the review panel opens inline under the chapter you are reviewing.

![Library productions with one expanded into chapter rows and the More actions menu open on another](../../../static/help/screenshots/audio-library.png)

*Expand a production to reach its chapter rows; Download, Edit metadata, Rebuild, and the … menu hold the remaining actions.*

## Read a production row

Each row shows a play button, the title, a line with engine, format, size and date, the duration, **Download ▾**, **Edit metadata**, **Rebuild**, a **…** (More actions) menu, and a chevron that shows the chapters.

The actions are:

- **Download ▾:** **Full story** (or **Audio file**), **All chapters** (ZIP), and **Audiobook** (M4B) for chapter-mode items.
- **Edit metadata:** Set title, author, genre, year, and description.
- **Rebuild:** Recompile outputs from the saved chunk audio.
- **… menu:** **Rename title**, **Review all chunks**, **Alt words** (pronunciation replacements for future regeneration of this item), **Metrics** (when the job has timing metrics), **Time codes** (chapter start times for a video description), **About these actions**, and **Delete** (permanently removes the item and its generated files).

Choose **Rename title** in the **…** menu to edit the Library title. This changes the saved Library metadata; it does not alter the source manuscript.

## Play the result

Use the round play button; while it plays, the expanded row shows a seek bar and a stop button. Only one Library player is active at a time.

For chapter-mode items, click the chevron to list the chapters. Each chapter row has **Review chunks**, a play button, a download icon, and a **…** menu with **Rename chapter** and **Download chapter**. The **Full story** row offers **Review chunks** and a download icon when a combined file exists.

## Review and correct audio

Click **Review chunks** on a chapter or Full story row (or **… → Review all chunks**). TTS-Story loads the saved chunks into a review panel under that row, where you can edit text, change voices or engines, apply FX, and regenerate selected audio.

After regeneration, rebuild the affected chapter or all outputs. A previously compiled chapter does not update merely because one of its source chunks changed. Follow [Review and Regenerate Chunks](help:job-review).

## Use Library-specific alternate words

The Generate-page Alternate Word Registry is temporary unless saved in a Project, but a Library item's **… → Alt words** list is stored with that item. Edit it before regenerating a recurring mispronunciation.

Replacements are case-insensitive literal substrings and run in list order. They are not whole-word rules. Test a narrow replacement before applying it across a speaker or book. See [Alternate Word Registry](help:alt-word-registry).

## Refresh and delete safely

Use **Refresh** after an export or rebuild if the row has not updated yet.

Deleting a Library item removes its audio directory, chunk data, metadata, and job log. This is different from removing a Queue record, which preserves completed audio. **Clear all** permanently deletes every Library item; download or back up anything you need first.

For storage locations and backup boundaries, see [Local Data, API Keys, and Backups](help:data-storage).
