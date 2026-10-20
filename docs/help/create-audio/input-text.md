# Enter or Import Your Text

The **Manuscript** editor on [Generate](app:generate) is the working manuscript for analysis and the next submitted job. You can type, paste, drop documents onto the manuscript, or click **Load document** (the upload icon in the Manuscript header).

Keep an untouched source copy outside TTS-Story before making changes.

The editor has two views, switched in its toolbar: **Raw tags** shows the editable text with its speaker tags; **Script** is a read-only reading view with one paragraph per speaker. Typing or pasting never switches the view for you, but tagged text opens in Script when you reload the page, load a project, or import a document into an empty manuscript (unless you last chose **Raw tags** yourself). Switch to **Raw tags** to type, paste, or fix tags; clicking a passage in Script view also jumps to it in Raw tags.

![Generate page with the Manuscript editor, the Load document and Alt word registry buttons, and Prep text](../../../static/help/screenshots/generate-overview.png)

*Enter or import the text in the Manuscript editor; the header buttons load documents, open the Alt word registry, and run optional LLM preparation.*

## Type or paste text

Plain text produces one **Speaker 1** assignment. Add paired speaker tags when different passages need different voices:

```text
[narrator]The station clock struck midnight.[/narrator]
[elena]We are out of time.[/elena]
```

After an edit, TTS-Story waits briefly and analyzes the manuscript automatically. The footer counts (speakers, chunks, words, ≈ duration), the **Cast** list, and the **Chapters** section update without a separate Analyze button. Large manuscripts or slower computers can take longer than a short passage.

Read [Speaker and Expression Tags](help:speaker-tags) before tagging a long multi-character work.

## Add deliberate pauses

TTS-Story recognizes pause controls with every TTS engine. Use `***` for 0.25 seconds of silence or `******` for 0.5 seconds. A marker can occupy its own line or follow punctuation directly:

```text
[narrator]Chapter 4.******[/narrator]
[narrator]The corridor was empty, and the man could not see.*** Something moved behind him.[/narrator]
```

Pause controls inside speaker tags retain the surrounding speaker assignment and are removed before text is sent to the TTS provider. Use them selectively where the narration needs more space than the engine provides naturally.

## Load documents

Click **Load document**, choose one or more files, and wait for the extraction status next to the Manuscript title. You can also drop files anywhere on the manuscript.

Supported extensions are:

- TXT
- PDF
- Word `.doc` and `.docx`
- RTF
- EPUB
- ODT
- Markdown
- HTML

Document extraction retrieves text; it is not a layout-preserving conversion. Review headings, page furniture, footnotes, tables, image captions, hyphenation, smart punctuation, and reading order—especially after PDF extraction.

## Imports always append

> **Important:** Loading a document does not replace the current manuscript. Every successfully extracted document is appended after the existing text, separated by blank lines.

This behavior is useful for assembling multiple chapters, but it can also duplicate a manuscript:

- Clear the manuscript before importing a replacement copy.
- If loading several files, confirm their selected order and inspect the combined result.
- A supported file that fails extraction is skipped while other valid files can still append.
- Unsupported files are ignored; the status reports when no supported documents were found.

**Clear**, at the right end of the manuscript toolbar, clears all text. If the manuscript is not empty, TTS-Story asks for confirmation.

## Preserve a clean source

Several actions deliberately modify the working manuscript:

- **Load document** appends extracted text.
- **Prep text** replaces the entire manuscript with LLM output.
- Renaming a speaker with **Rename** in its Edit speaker drawer rewrites matching speaker tags.
- **Auto-fix** inserts tags to repair detected imbalances.
- Editing a heading in the **Review sections** dialog (the *Review N sections* link in the Chapters section) changes that heading in the manuscript.
- Loading a project replaces the current Generate-page state.

Before any large change, save the original file externally. You can also create a named snapshot in **Projects** (the **Project** switcher at the top of the left sidebar), but projects are working snapshots stored by the TTS-Story backend, not portable backups; see [Save and Restore Projects](help:projects).

## Clean the extracted text

Work from the top down:

1. Remove repeated headers, page numbers, navigation text, and legal boilerplate that should not be spoken.
2. Restore broken paragraphs and words split by PDF line endings.
3. Make chapter headings consistent if you want separate outputs.
4. Add balanced speaker tags, or use [Prepare Text with an LLM](help:prep-text) and review its changes.
5. Add pronunciation substitutions only after the wording is stable; see [Alternate Word Registry](help:alt-word-registry).
6. Check the footer counts, the Cast list and the Chapters section, and confirm that the word, speaker, chunk, and section counts are plausible.

## Large manuscripts

For a book-length source:

- Import once rather than repeatedly clicking **Load document**.
- Save a project after cleanup and again after voice assignment.
- Test one representative chapter before generating everything.
- Use clear, consistent headings covered by [Chapters, Books, and Sections](help:chapters-and-sections).
- Expect automatic analysis to take longer as the manuscript grows.

When the text is clean, continue with [Analyze Text and Review Statistics](help:text-statistics).
