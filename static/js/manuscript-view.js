/* manuscript-view.js — Generate screen manuscript (Script / Raw tags) view.
   Owned by the generate screen agent of the "Estudio" redesign. Classic script, loaded last; no top-level DOM access.

   The textarea #input-text stays the single source of truth:
   - "Raw tags" is the textarea itself.
   - "Script" is a read-only rendering of it, parsed like src/text_processor.py
     (speaker blocks with an optional [direction] prefix) and app.py's section
     heading detector, so what you read is what gets narrated.
   This file also wires the rest of the manuscript chrome: the view toggle, the
   Insert tag menu, the tag status chip, the header save status, and the aside's
   sticky footer (pending-ready notice, queue line, View queue). */

const MANUSCRIPT_VIEW_STORAGE_KEY = 'tts-story:manuscript-view';
const MANUSCRIPT_RESERVED_TAGS = ['emotion', 'direction'];
const MANUSCRIPT_DEFAULT_HEADINGS = ['book', 'chapter', 'section', 'letter', 'part', 'prologue', 'epilogue'];

const manuscriptViewState = {
    initialized: false,
    view: 'raw',
    renderedKey: null,
    renderTimer: null,
    parseCacheText: null,
    parseCacheResult: null,
    lastTextEmpty: true,
    savedAt: null,
    savedText: null,
    dirty: false,
    uploadTimer: null,
    castEventSeen: false,
    castSpeakers: []
};

/* --------------------------------------------------------------------------
   Parsing (pure functions; no DOM)
   -------------------------------------------------------------------------- */

/** Mirrors app.py _build_section_heading_pattern for one line of text. */
function manuscriptHeadingPattern(headings) {
    const keywords = [];
    (Array.isArray(headings) ? headings : []).forEach(heading => {
        const word = String(heading || '').trim().toLowerCase();
        if (word && !keywords.includes(word)) keywords.push(word);
    });
    const parts = keywords.map(word => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
        const last = word[word.length - 1];
        if (/[a-z]/i.test(last)) return `${escaped}(?![^\\W\\d_])`;
        if (/[0-9_]/.test(last)) return `${escaped}\\b`;
        return escaped;
    }).filter(Boolean);
    if (!parts.length) return null;
    return new RegExp(`^\\s*(?:\\[[^\\]]+\\]\\s*)*((?:${parts.join('|')})[^\\n\\r]*)$`, 'i');
}

/**
 * Finds speaker blocks exactly like TextProcessor.parse_speaker_segments:
 * optional [direction]…[/direction] (or legacy [emotion]) prefix, then
 * [name]…[/name] with a case-sensitive closer. Linear-ish (binary search per
 * opener) so unclosed cues in long books cannot trigger regex backtracking.
 */
function manuscriptParseSegments(text) {
    const source = String(text || '');
    const tags = [];
    const tagRe = /\[(\/?)([a-zA-Z0-9_\-]+)\]/g;
    let match;
    while ((match = tagRe.exec(source)) !== null) {
        tags.push({ pos: match.index, end: match.index + match[0].length, name: match[2], closing: match[1] === '/' });
    }
    const closers = new Map();
    tags.forEach((tag, index) => {
        if (!tag.closing) return;
        if (!closers.has(tag.name)) closers.set(tag.name, []);
        closers.get(tag.name).push(index);
    });
    const firstCloserAfter = (name, pos) => {
        const list = closers.get(name);
        if (!list || !list.length) return -1;
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tags[list[mid]].pos < pos) lo = mid + 1; else hi = mid;
        }
        return lo < list.length ? list[lo] : -1;
    };
    const controlCloserAfter = pos => {
        const a = firstCloserAfter('emotion', pos);
        const b = firstCloserAfter('direction', pos);
        if (a < 0) return b;
        if (b < 0) return a;
        return tags[a].pos < tags[b].pos ? a : b;
    };

    const segments = [];
    let cursor = 0;
    for (let i = 0; i < tags.length; i += 1) {
        const tag = tags[i];
        if (tag.closing || tag.pos < cursor) continue;
        let opener = tag;
        let closeIndex = -1;
        let direction = null;
        if (tag.name === 'emotion' || tag.name === 'direction') {
            const controlClose = controlCloserAfter(tag.end);
            if (controlClose >= 0) {
                let next = tags[controlClose].end;
                while (next < source.length && /\s/.test(source[next])) next += 1;
                const candidate = tags[controlClose + 1];
                if (candidate && !candidate.closing && candidate.pos === next) {
                    const speakerClose = firstCloserAfter(candidate.name, candidate.end);
                    if (speakerClose >= 0) {
                        opener = candidate;
                        closeIndex = speakerClose;
                        direction = source.slice(tag.end, tags[controlClose].pos);
                    }
                }
            }
        }
        if (closeIndex < 0) {
            opener = tag;
            direction = null;
            closeIndex = firstCloserAfter(tag.name, tag.end);
        }
        if (closeIndex < 0) continue;
        const close = tags[closeIndex];
        const speaker = opener.name.trim().toLowerCase();
        const content = source.slice(opener.end, close.pos);
        segments.push({
            start: tag.pos,
            end: close.end,
            contentStart: opener.end,
            contentEnd: close.pos,
            speaker,
            direction: direction !== null ? direction.trim() : '',
            narrated: Boolean(content.trim()) && !MANUSCRIPT_RESERVED_TAGS.includes(speaker)
        });
        cursor = close.end;
    }
    return { segments, hasSpeakerTags: segments.some(segment => segment.narrated) };
}

function manuscriptParseCached(text) {
    if (manuscriptViewState.parseCacheText !== text) {
        manuscriptViewState.parseCacheText = text;
        manuscriptViewState.parseCacheResult = manuscriptParseSegments(text);
    }
    return manuscriptViewState.parseCacheResult;
}

function manuscriptCleanHeading(value) {
    return String(value || '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/\s*\*{3}(?:\*{3})*\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** "Chapter 1: The Hidden Path" → kicker "Chapter 1", title "The Hidden Path". */
function manuscriptSplitHeading(heading) {
    const clean = manuscriptCleanHeading(heading);
    const split = clean.match(/^(.{1,40}?)\s*(?::|\s[-–—]\s|\.\s)\s*(.+)$/);
    if (split) return { kicker: split[1], title: split[2] };
    return { kicker: '', title: clean };
}

/**
 * Splits a slice of the manuscript into headings and paragraphs (blank lines end
 * a paragraph). Offsets are absolute positions in the textarea value.
 */
function manuscriptSplitParagraphs(text, base, headingRe) {
    const items = [];
    let para = null;
    const flush = () => {
        if (para) items.push(para);
        para = null;
    };
    let lineStart = 0;
    while (lineStart <= text.length) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd < 0) lineEnd = text.length;
        const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
        if (!line.trim()) {
            flush();
        } else if (headingRe && headingRe.test(line)) {
            flush();
            items.push({ kind: 'heading', text: line, start: base + lineStart, end: base + lineEnd });
        } else if (para) {
            para.text += `\n${line}`;
            para.end = base + lineEnd;
        } else {
            const lead = line.length - line.trimStart().length;
            para = { kind: 'para', text: line, start: base + lineStart + lead, end: base + lineEnd };
        }
        if (lineEnd >= text.length) break;
        lineStart = lineEnd + 1;
    }
    flush();
    return items;
}

/** Turns the textarea value into render blocks (headings, speaker paragraphs, pauses, unvoiced text). */
function manuscriptBuildBlocks(text, parsed, headingRe) {
    const blocks = [];
    const hasTags = parsed.hasSpeakerTags;
    let untaggedRunLabelled = false;
    const isPauseOnly = value => /^\s*(?:\*{3}(?:\*{3})*\s*)+$/.test(value);
    const pushGap = (start, end) => {
        if (end <= start) return;
        const slice = text.slice(start, end);
        if (!slice.trim()) return;
        manuscriptSplitParagraphs(slice, start, headingRe).forEach(item => {
            if (item.kind === 'heading') {
                blocks.push({ type: 'heading', start: item.start, end: item.end, heading: item.text });
                untaggedRunLabelled = false;
            } else if (isPauseOnly(item.text)) {
                blocks.push({ type: 'pause', start: item.start, end: item.end, marker: item.text.trim() });
            } else if (hasTags) {
                blocks.push({ type: 'unvoiced', start: item.start, end: item.end, text: item.text });
            } else {
                blocks.push({ type: 'para', start: item.start, end: item.end, text: item.text, speaker: 'Speaker 1', label: !untaggedRunLabelled });
                untaggedRunLabelled = true;
            }
        });
    };
    let cursor = 0;
    parsed.segments.forEach(segment => {
        pushGap(cursor, segment.start);
        cursor = segment.end;
        if (!segment.narrated) {
            const raw = text.slice(segment.start, segment.end);
            if (raw.trim()) blocks.push({ type: 'unvoiced', start: segment.start, end: segment.end, text: raw });
            return;
        }
        const content = text.slice(segment.contentStart, segment.contentEnd);
        let labelled = false;
        manuscriptSplitParagraphs(content, segment.contentStart, headingRe).forEach(item => {
            if (item.kind === 'heading') {
                blocks.push({ type: 'heading', start: item.start, end: item.end, heading: item.text });
                return;
            }
            if (isPauseOnly(item.text)) {
                blocks.push({ type: 'pause', start: item.start, end: item.end, marker: item.text.trim() });
                return;
            }
            blocks.push({
                type: 'para',
                start: item.start,
                end: item.end,
                text: item.text,
                speaker: segment.speaker,
                direction: labelled ? '' : segment.direction,
                label: !labelled
            });
            labelled = true;
        });
    });
    pushGap(cursor, text.length);
    return blocks;
}

function manuscriptPauseSeconds(marker) {
    const groups = Math.floor(String(marker || '').replace(/\s+/g, '').length / 3);
    const seconds = Math.floor(groups / 2) * 0.5 + (groups % 2) * 0.25;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : String(seconds)} s`;
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */

function manuscriptGetTextarea() {
    return document.getElementById('input-text');
}

function manuscriptSpeakerOrder(parsed) {
    const stats = typeof currentStats !== 'undefined' ? currentStats : null;
    if (stats && Array.isArray(stats.speakers) && stats.speakers.length) return stats.speakers.slice();
    const order = [];
    parsed.segments.forEach(segment => {
        if (segment.narrated && !order.includes(segment.speaker)) order.push(segment.speaker);
    });
    return order.length ? order : ['Speaker 1'];
}

function manuscriptSpeakerColor(name, order) {
    if (typeof window.studioSpeakerColor === 'function') return window.studioSpeakerColor(name, order);
    return '#c4b8a5';
}

/** Appends prose with inline cues ([sigh]) and pause markers (***) as mono chips. */
function manuscriptAppendProse(target, value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const tokenRe = /\[\/?[^\[\]\n]{1,60}\]|\*{3,}/g;
    let last = 0;
    let match;
    while ((match = tokenRe.exec(text)) !== null) {
        const token = match[0];
        if (token[0] === '*' && token.length % 3 !== 0) continue;
        if (match.index > last) target.appendChild(document.createTextNode(text.slice(last, match.index)));
        const chip = document.createElement('span');
        chip.className = token[0] === '*' ? 'mv-cue mv-cue-pause' : 'mv-cue';
        chip.textContent = token;
        if (token[0] === '*') chip.title = `${manuscriptPauseSeconds(token)} pause`;
        target.appendChild(chip);
        last = match.index + token.length;
    }
    if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

function manuscriptBlockElement(block, order) {
    const row = document.createElement('div');
    row.className = 'mv-row';
    row.dataset.start = String(block.start);
    row.dataset.end = String(block.end);

    if (block.type === 'heading') {
        row.classList.add('mv-heading');
        const gutter = document.createElement('span');
        gutter.className = 'mv-gutter';
        const body = document.createElement('div');
        body.className = 'mv-heading-text';
        const { kicker, title } = manuscriptSplitHeading(block.heading);
        if (kicker) {
            const kickerEl = document.createElement('span');
            kickerEl.className = 'mv-heading-kicker';
            kickerEl.textContent = kicker;
            body.appendChild(kickerEl);
        }
        const titleEl = document.createElement('span');
        titleEl.className = 'mv-heading-title';
        if (title.length > 60) titleEl.classList.add('is-long');
        titleEl.textContent = title || kicker;
        body.appendChild(titleEl);
        row.append(gutter, body);
        row.title = 'Section heading · click to edit in Raw tags';
        return row;
    }

    if (block.type === 'pause') {
        row.classList.add('mv-pause');
        const gutter = document.createElement('span');
        gutter.className = 'mv-gutter';
        const body = document.createElement('div');
        body.className = 'mv-body';
        const chip = document.createElement('span');
        chip.className = 'mv-cue mv-cue-pause';
        chip.textContent = block.marker;
        const note = document.createElement('span');
        note.className = 'mv-pause-note';
        note.textContent = `${manuscriptPauseSeconds(block.marker)} pause`;
        body.append(chip, note);
        row.append(gutter, body);
        return row;
    }

    const body = document.createElement('div');
    body.className = 'mv-body';
    if (block.type === 'unvoiced') {
        row.classList.add('mv-para', 'is-unvoiced');
        row.title = 'Text outside speaker tags is skipped when the manuscript uses speaker tags.';
        const note = document.createElement('span');
        note.className = 'mv-gutter mv-gutter-note';
        note.textContent = 'Not narrated';
        const prose = document.createElement('p');
        prose.className = 'mv-prose';
        manuscriptAppendProse(prose, block.text);
        body.appendChild(prose);
        row.append(note, body);
        return row;
    }

    row.classList.add('mv-para');
    row.style.setProperty('--mv-spk', manuscriptSpeakerColor(block.speaker, order));
    let gutter;
    if (block.label) {
        gutter = document.createElement('button');
        gutter.type = 'button';
        gutter.className = 'mv-gutter mv-speaker';
        gutter.dataset.speaker = block.speaker;
        gutter.textContent = block.speaker;
        gutter.title = `${block.speaker} · open in Cast`;
    } else {
        row.classList.add('is-continued');
        gutter = document.createElement('span');
        gutter.className = 'mv-gutter';
    }
    if (block.direction) {
        const direction = document.createElement('span');
        direction.className = 'mv-direction';
        direction.textContent = block.direction.replace(/\s+/g, ' ');
        body.appendChild(direction);
    }
    const prose = document.createElement('p');
    prose.className = 'mv-prose';
    manuscriptAppendProse(prose, block.text);
    body.appendChild(prose);
    row.append(gutter, body);
    return row;
}

function manuscriptRender(force = false) {
    const container = document.getElementById('manuscript-script-view');
    const textarea = manuscriptGetTextarea();
    if (!container || !textarea) return;
    const text = textarea.value || '';
    const headings = typeof getEnabledSectionHeadings === 'function'
        ? getEnabledSectionHeadings()
        : MANUSCRIPT_DEFAULT_HEADINGS;
    const headingRe = manuscriptHeadingPattern(headings);
    const parsed = manuscriptParseCached(text);
    const order = manuscriptSpeakerOrder(parsed);
    const key = `${text}\u0001${order.join(',')}\u0001${headingRe ? headingRe.source : ''}`;
    if (!force && key === manuscriptViewState.renderedKey) return;
    manuscriptViewState.renderedKey = key;

    const scrollTop = container.scrollTop;
    const column = document.createElement('div');
    column.className = 'mv-column';
    const fragment = document.createDocumentFragment();
    manuscriptBuildBlocks(text, parsed, headingRe).forEach(block => {
        fragment.appendChild(manuscriptBlockElement(block, order));
    });
    column.appendChild(fragment);
    container.replaceChildren(column);
    container.scrollTop = scrollTop;
}

function manuscriptScheduleRender(delay = 150) {
    if (manuscriptViewState.renderTimer) clearTimeout(manuscriptViewState.renderTimer);
    manuscriptViewState.renderTimer = null;
    if (manuscriptViewState.view !== 'script') {
        manuscriptViewState.renderedKey = null;
        return;
    }
    manuscriptViewState.renderTimer = setTimeout(() => {
        manuscriptViewState.renderTimer = null;
        manuscriptRender();
    }, delay);
}

/* --------------------------------------------------------------------------
   Script / Raw view switching
   -------------------------------------------------------------------------- */

function manuscriptReadPreference() {
    try {
        const value = window.localStorage?.getItem(MANUSCRIPT_VIEW_STORAGE_KEY);
        return value === 'script' || value === 'raw' ? value : null;
    } catch (error) {
        return null;
    }
}

function manuscriptWritePreference(view) {
    try {
        window.localStorage?.setItem(MANUSCRIPT_VIEW_STORAGE_KEY, view);
    } catch (error) {
        // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
}

/** Script when the text has speaker tags (unless the user prefers Raw), otherwise Raw. */
function manuscriptDefaultView(text) {
    if (!String(text || '').trim()) return 'raw';
    if (!manuscriptParseCached(text).hasSpeakerTags) return 'raw';
    return manuscriptReadPreference() || 'script';
}

function manuscriptSyncToggle() {
    const textarea = manuscriptGetTextarea();
    const empty = !textarea || !textarea.value.trim();
    document.querySelectorAll('[data-manuscript-view]').forEach(button => {
        const active = button.dataset.manuscriptView === manuscriptViewState.view;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
        if (button.dataset.manuscriptView === 'script') {
            button.setAttribute('aria-disabled', empty ? 'true' : 'false');
            button.title = empty
                ? 'Add some text to read it as a script'
                : 'Read the manuscript as a script, one paragraph per speaker';
        }
    });
}

function manuscriptRowAtTop(container) {
    const rect = container.getBoundingClientRect();
    const probe = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12);
    const row = probe?.closest?.('.mv-row[data-start]');
    if (row && container.contains(row)) return row;
    return container.querySelector('.mv-row[data-start]');
}

function manuscriptRowForOffset(container, offset) {
    const rows = container.querySelectorAll('.mv-row[data-start]');
    let lo = 0;
    let hi = rows.length - 1;
    let found = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const start = Number(rows[mid].dataset.start);
        if (start <= offset) {
            found = rows[mid];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found || rows[0] || null;
}

function manuscriptIsSpokenRow(row) {
    return row.classList.contains('mv-para') && !row.classList.contains('is-unvoiced');
}

/** Rows of the Script view that are on screen (binary search, so long books stay cheap). */
function manuscriptVisibleRows(container) {
    const rows = container.querySelectorAll('.mv-row[data-start]');
    const view = container.getBoundingClientRect();
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].getBoundingClientRect().bottom <= view.top) lo = mid + 1; else hi = mid;
    }
    const visible = [];
    for (let i = lo; i < rows.length; i += 1) {
        if (rows[i].getBoundingClientRect().top >= view.bottom) break;
        visible.push(rows[i]);
    }
    return { rows, first: lo, visible };
}

/**
 * Where a tag inserted from Script view goes. Script view has no caret, and after a
 * load the textarea caret sits at the very end (outside every speaker tag, so the
 * cue would never be narrated). Keep the caret only when it is inside a narrated
 * paragraph that is on screen (e.g. the paragraph last clicked); otherwise use the
 * end of the first narrated paragraph on screen, which is inside its speaker block.
 */
function manuscriptScriptInsertOffset(container, textarea) {
    manuscriptRender(); // no-op unless a debounced re-render is still pending (offsets must match the text)
    const caretStart = textarea.selectionStart || 0;
    const caretEnd = Math.max(caretStart, textarea.selectionEnd || 0);
    const { rows, first, visible } = manuscriptVisibleRows(container);
    const holding = visible.find(row => manuscriptIsSpokenRow(row)
        && Number(row.dataset.start) <= caretStart
        && caretEnd <= Number(row.dataset.end));
    // A selection is invisible from Script view, so never replace it: insert after it.
    if (holding) return caretEnd;
    let target = visible.find(manuscriptIsSpokenRow) || null;
    for (let i = first + visible.length; !target && i < rows.length; i += 1) {
        if (manuscriptIsSpokenRow(rows[i])) target = rows[i];
    }
    for (let i = first - 1; !target && i >= 0; i -= 1) {
        if (manuscriptIsSpokenRow(rows[i])) target = rows[i];
    }
    return target ? Number(target.dataset.end) : caretEnd;
}

function manuscriptScrollTextareaTo(textarea, offset, context = 0.25) {
    if (typeof _computeScrollTopForChar !== 'function') return;
    const top = _computeScrollTopForChar(textarea, offset);
    const target = Math.max(0, top - textarea.clientHeight * context);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        textarea.scrollTop = target;
    }));
}

/**
 * Switches between "script" and "raw". `persist` stores an explicit user choice;
 * forced switches (insert tag, issue navigation, empty text) never do.
 */
function manuscriptSetView(view, { persist = false, syncScroll = true } = {}) {
    const wrapper = document.getElementById('text-input-wrapper');
    const textarea = manuscriptGetTextarea();
    const container = document.getElementById('manuscript-script-view');
    if (!wrapper || !textarea || !container) return;
    let next = view === 'script' ? 'script' : 'raw';
    if (next === 'script' && !textarea.value.trim()) next = 'raw';
    if (persist) manuscriptWritePreference(next);
    const previous = manuscriptViewState.view;
    if (previous === next && wrapper.dataset.view === next) {
        manuscriptSyncToggle();
        return;
    }

    if (next === 'script') {
        const rawFocused = document.activeElement === textarea;
        const caret = textarea.selectionStart || 0;
        const ratio = textarea.scrollTop / Math.max(1, textarea.scrollHeight - textarea.clientHeight);
        manuscriptViewState.view = 'script';
        wrapper.dataset.view = 'script';
        manuscriptRender();
        if (rawFocused && caret > 0) {
            manuscriptRowForOffset(container, caret)?.scrollIntoView({ block: 'center' });
        } else {
            container.scrollTop = ratio * Math.max(0, container.scrollHeight - container.clientHeight);
        }
    } else {
        const topRow = previous === 'script' && syncScroll ? manuscriptRowAtTop(container) : null;
        manuscriptViewState.view = 'raw';
        wrapper.dataset.view = 'raw';
        if (topRow) {
            manuscriptScrollTextareaTo(textarea, Number(topRow.dataset.start) || 0, 0);
        }
    }
    manuscriptSyncToggle();
}

/** Raw view with the given passage selected and scrolled into view. */
function manuscriptRevealRange(start, end) {
    const textarea = manuscriptGetTextarea();
    if (!textarea) return;
    manuscriptSetView('raw', { syncScroll: false });
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(start, end);
    manuscriptScrollTextareaTo(textarea, start);
}

function manuscriptOpenSpeaker(name) {
    if (!name) return;
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(name) : String(name).replace(/"/g, '\\"');
    const chip = document.querySelector(`#speakers-list .speaker-tag[data-speaker="${escaped}"]`);
    if (chip) {
        chip.click();
    } else if (typeof showNotification === 'function') {
        showNotification(`"${name}" isn't in the cast yet. The analysis may still be running.`, 'info');
    }
}

/* --------------------------------------------------------------------------
   Toolbar: Insert tag menu and tag status chip
   -------------------------------------------------------------------------- */

function manuscriptSetTagMenuOpen(open) {
    const menu = document.getElementById('manuscript-tag-menu');
    const trigger = document.getElementById('manuscript-insert-trigger');
    if (!menu || !trigger) return;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    trigger.classList.toggle('is-open', open);
}

function manuscriptSyncTagMenuAvailability() {
    const wrapper = document.getElementById('manuscript-insert-tag');
    const bar = document.getElementById('paralinguistic-tags-bar');
    const label = document.getElementById('manuscript-tag-menu-label');
    if (!wrapper || !bar) return;
    const available = bar.style.display !== 'none';
    wrapper.hidden = !available;
    if (!available) manuscriptSetTagMenuOpen(false);
    const kokoro = document.getElementById('paralinguistic-tags-kokoro');
    const omni = document.getElementById('paralinguistic-tags-omnivoice');
    let engine = '';
    if (kokoro && kokoro.style.display !== 'none') engine = 'Kokoro';
    else if (omni && omni.style.display !== 'none') engine = 'OmniVoice';
    if (label) label.textContent = engine ? `Paralinguistic tags · ${engine}` : 'Paralinguistic tags';
}

function manuscriptUpdateTagStatus() {
    const chip = document.getElementById('manuscript-tag-status');
    const textarea = manuscriptGetTextarea();
    if (!chip || !textarea) return;
    const text = textarea.value || '';
    if (!text.trim()) {
        chip.hidden = true;
        chip.dataset.state = 'empty';
        return;
    }
    const issues = typeof _tagIssues !== 'undefined' && Array.isArray(_tagIssues) ? _tagIssues.length : 0;
    const icon = chip.querySelector('.ms');
    const label = chip.querySelector('.manuscript-tag-status-label');
    let state;
    let iconName;
    let labelText;
    let title;
    if (issues > 0) {
        state = 'issues';
        iconName = 'error';
        labelText = `${issues} tag issue${issues === 1 ? '' : 's'}`;
        title = 'Show the first tag issue in Raw tags';
    } else if (manuscriptParseCached(text).hasSpeakerTags) {
        state = 'valid';
        iconName = 'check_circle';
        labelText = 'Speaker tags valid';
        title = 'Every speaker tag is opened and closed correctly';
    } else {
        state = 'none';
        iconName = 'info';
        labelText = 'No speaker tags';
        title = 'Plain text is read by a single voice. Wrap lines in [name]…[/name] tags for several voices.';
    }
    chip.dataset.state = state;
    chip.title = title;
    chip.setAttribute('aria-disabled', state === 'issues' ? 'false' : 'true');
    if (icon) icon.textContent = iconName;
    if (label) label.textContent = labelText;
    chip.hidden = false;
}

/* --------------------------------------------------------------------------
   Header: project save status and upload status
   -------------------------------------------------------------------------- */

function manuscriptHasActiveProject() {
    return typeof activeProjectId !== 'undefined' && activeProjectId !== null && activeProjectId !== '';
}

function manuscriptRenderProjectStatus() {
    const status = document.getElementById('project-status');
    if (!status) return;
    let text;
    let state;
    let title = '';
    if (!manuscriptHasActiveProject()) {
        text = 'Not saved';
        state = 'none';
        title = 'Save this manuscript as a project from the project menu in the sidebar.';
    } else if (manuscriptViewState.dirty) {
        text = 'Unsaved changes';
        state = 'dirty';
        title = 'Save the project again to keep your latest changes.';
    } else if (manuscriptViewState.savedAt) {
        const relative = typeof window.studioRelativeTime === 'function'
            ? window.studioRelativeTime(manuscriptViewState.savedAt)
            : '';
        const lowered = relative === 'Just now' || relative === 'Yesterday' ? relative.toLowerCase() : relative;
        text = lowered ? `Saved ${lowered}` : 'Saved';
        state = 'saved';
        const savedDate = new Date(manuscriptViewState.savedAt);
        if (!Number.isNaN(savedDate.getTime())) title = `Saved ${savedDate.toLocaleString()}`;
    } else {
        text = 'Saved';
        state = 'saved';
    }
    status.textContent = text;
    status.dataset.state = state;
    status.title = title;
}

/**
 * `savedText` is the text that was actually written (saves are async, so the
 * user may have typed meanwhile); without it the current textarea is the snapshot.
 */
function manuscriptMarkSaved(savedAt, savedText) {
    const textarea = manuscriptGetTextarea();
    manuscriptViewState.savedAt = savedAt || new Date().toISOString();
    manuscriptViewState.savedText = typeof savedText === 'string' ? savedText : (textarea ? textarea.value : null);
    manuscriptViewState.dirty = Boolean(textarea) && manuscriptViewState.savedText !== null
        && textarea.value !== manuscriptViewState.savedText;
    manuscriptRenderProjectStatus();
}

function manuscriptMarkDirtyFromText() {
    if (!manuscriptHasActiveProject()) return;
    const textarea = manuscriptGetTextarea();
    const dirty = !textarea || manuscriptViewState.savedText === null || textarea.value !== manuscriptViewState.savedText;
    if (dirty !== manuscriptViewState.dirty) {
        manuscriptViewState.dirty = dirty;
        manuscriptRenderProjectStatus();
    }
}

window.studioProjectStatus = {
    markSaved(savedAt, savedText) {
        manuscriptMarkSaved(savedAt, savedText);
    },
    markLoaded(savedAt) {
        manuscriptMarkSaved(savedAt);
        const textarea = manuscriptGetTextarea();
        if (textarea && manuscriptViewState.initialized) {
            manuscriptViewState.lastTextEmpty = !textarea.value.trim();
            manuscriptSetView(manuscriptDefaultView(textarea.value));
        }
    },
    refresh() {
        manuscriptRenderProjectStatus();
    }
};

function manuscriptWatchUploadStatus() {
    const statusEl = document.getElementById('document-upload-status');
    const subtitle = statusEl?.closest('.manuscript-subtitle');
    if (!statusEl || !subtitle || typeof MutationObserver !== 'function') return;
    const sync = () => {
        const text = (statusEl.textContent || '').trim();
        subtitle.classList.toggle('is-uploading', Boolean(text));
        if (manuscriptViewState.uploadTimer) clearTimeout(manuscriptViewState.uploadTimer);
        manuscriptViewState.uploadTimer = null;
        if (!text || statusEl.classList.contains('loading')) return;
        // Finished uploads give the subtitle back to the save status after a moment.
        const delay = statusEl.classList.contains('error') ? 10000 : 6000;
        manuscriptViewState.uploadTimer = setTimeout(() => {
            manuscriptViewState.uploadTimer = null;
            if ((statusEl.textContent || '').trim() === text) {
                statusEl.textContent = '';
                statusEl.className = 'upload-status';
            }
        }, delay);
    };
    new MutationObserver(sync).observe(statusEl, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
    });
    sync();
}

/* --------------------------------------------------------------------------
   Aside sticky footer: pending-ready notice and queue line
   -------------------------------------------------------------------------- */

function manuscriptRenderPending(speakers) {
    const notice = document.getElementById('generate-pending-review');
    const label = notice?.querySelector('.generate-pending-text');
    const textarea = manuscriptGetTextarea();
    if (!notice || !label) return;
    const pending = (Array.isArray(speakers) ? speakers : [])
        .filter(speaker => speaker && speaker.name && !speaker.ready)
        .map(speaker => String(speaker.name));
    if (!pending.length || !textarea || !textarea.value.trim()) {
        notice.hidden = true;
        notice.dataset.speaker = '';
        return;
    }
    const shown = pending.length > 3
        ? `${pending.slice(0, 2).join(', ')} and ${pending.length - 2} more`
        : pending.join(', ');
    label.textContent = `${shown} ${pending.length === 1 ? 'is' : 'are'} not marked ready`;
    notice.dataset.speaker = pending[0];
    notice.title = `Not marked ready: ${pending.join(', ')}. Click to open ${pending[0]} in the cast.`;
    notice.hidden = false;
}

/** Until the Cast list announces itself (cast:changed), derive readiness from main.js state. */
function manuscriptFallbackPending() {
    if (manuscriptViewState.castEventSeen) return;
    const stats = typeof currentStats !== 'undefined' ? currentStats : null;
    const readyState = typeof speakerReadyState !== 'undefined' ? speakerReadyState : {};
    if (!stats) {
        manuscriptRenderPending([]);
        return;
    }
    const names = stats.has_speaker_tags && Array.isArray(stats.speakers) && stats.speakers.length
        ? stats.speakers
        : ['Speaker 1'];
    manuscriptRenderPending(names.map(name => ({ name, ready: Boolean(readyState[name]) })));
}

function manuscriptRefreshPending() {
    if (manuscriptViewState.castEventSeen) {
        manuscriptRenderPending(manuscriptViewState.castSpeakers);
    } else {
        manuscriptFallbackPending();
    }
}

function manuscriptSyncQueueLine(detail) {
    const line = document.querySelector('#generate-tab .generate-queue-line');
    if (!line || !detail) return;
    const running = Number(detail.running) || 0;
    const queued = Number(detail.queued) || 0;
    line.dataset.state = running > 0 ? 'running' : (queued > 0 ? 'queued' : 'idle');
}

function manuscriptFormatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = String(whole % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Compact player for #latest-audio-player (main.js sets its src from the queue). */
function manuscriptInitLatestAudio() {
    const audio = document.getElementById('latest-audio-player');
    const play = document.getElementById('latest-audio-play-btn');
    const seek = document.getElementById('latest-audio-seek');
    const time = document.getElementById('latest-audio-time');
    if (!audio || !play || !seek || !time) return;
    const icon = play.querySelector('.ms');
    const sync = () => {
        const duration = audio.duration;
        const hasDuration = Number.isFinite(duration) && duration > 0;
        const playing = !audio.paused && !audio.ended;
        if (icon) icon.textContent = playing ? 'pause' : 'play_arrow';
        play.setAttribute('aria-label', playing ? 'Pause the latest audio' : 'Play the latest audio');
        const ratio = hasDuration ? Math.min(1, audio.currentTime / duration) : 0;
        if (document.activeElement !== seek) seek.value = String(Math.round(ratio * 1000));
        seek.style.setProperty('--seek', `${(ratio * 100).toFixed(2)}%`);
        seek.disabled = !hasDuration;
        time.textContent = hasDuration
            ? (audio.currentTime > 0 ? `${manuscriptFormatClock(audio.currentTime)} / ${manuscriptFormatClock(duration)}` : manuscriptFormatClock(duration))
            : '';
    };
    ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'durationchange', 'emptied'].forEach(type => {
        audio.addEventListener(type, sync);
    });
    play.addEventListener('click', () => {
        if (audio.paused || audio.ended) {
            const attempt = audio.play();
            if (attempt && typeof attempt.catch === 'function') {
                attempt.catch(() => {
                    if (typeof showNotification === 'function') showNotification('Unable to play the latest audio.', 'warning');
                });
            }
        } else {
            audio.pause();
        }
    });
    seek.addEventListener('input', () => {
        const duration = audio.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;
        audio.currentTime = (Number(seek.value) / 1000) * duration;
        sync();
    });
    sync();
}

/* --------------------------------------------------------------------------
   Wiring
   -------------------------------------------------------------------------- */

/** Wraps a global function declared by another classic script (resolved at call time). */
function manuscriptWrapGlobal(name, { before, after } = {}) {
    const original = window[name];
    if (typeof original !== 'function' || original.manuscriptWrapped) return;
    const wrapped = function manuscriptWrappedGlobal(...args) {
        if (before) before(...args);
        const result = original.apply(this, args);
        if (after) {
            if (result && typeof result.then === 'function') {
                result.then(() => after(...args), () => after(...args));
            } else {
                after(...args);
            }
        }
        return result;
    };
    wrapped.manuscriptWrapped = true;
    window[name] = wrapped;
}

function manuscriptAfterAnalysis() {
    manuscriptScheduleRender(0);
    manuscriptUpdateTagStatus();
    manuscriptSyncToggle();
    manuscriptRefreshPending();
}

function manuscriptInitHeadingForm() {
    const addChip = document.getElementById('heading-chip-add-btn');
    const form = document.getElementById('custom-heading-form');
    const input = document.getElementById('custom-heading-input');
    if (!addChip || !form || !input) return;
    const setOpen = open => {
        form.hidden = !open;
        addChip.setAttribute('aria-expanded', open ? 'true' : 'false');
        addChip.classList.toggle('is-open', open);
    };
    addChip.addEventListener('click', () => {
        const open = form.hidden;
        setOpen(open);
        if (open) input.focus();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            input.value = '';
            setOpen(false);
            addChip.focus();
        }
    });
    if (input.value.trim()) setOpen(true);
}

function initManuscriptView() {
    const wrapper = document.getElementById('text-input-wrapper');
    const textarea = manuscriptGetTextarea();
    const container = document.getElementById('manuscript-script-view');
    if (!wrapper || !textarea || !container) return;
    manuscriptViewState.initialized = true;

    // Re-render / re-check after main.js updates the analysis or tag banner.
    manuscriptWrapGlobal('displayStatistics', { after: manuscriptAfterAnalysis });
    manuscriptWrapGlobal('hideAnalysis', { after: manuscriptAfterAnalysis });
    manuscriptWrapGlobal('_updateTagErrorBanner', { after: manuscriptUpdateTagStatus });
    // Actions that need a visible, focusable textarea switch to Raw first.
    manuscriptWrapGlobal('_scrollToTagIssue', { before: () => manuscriptSetView('raw', { syncScroll: false }) });
    // Tags go in at the textarea's caret. From Script view the caret is first moved into the
    // narrated paragraph on screen (see manuscriptScriptInsertOffset); then show where it landed.
    let insertedFromScript = false;
    manuscriptWrapGlobal('insertTextAtCursor', {
        before: target => {
            insertedFromScript = target === textarea && manuscriptViewState.view === 'script';
            const offset = insertedFromScript && textarea.value.trim()
                ? manuscriptScriptInsertOffset(container, textarea)
                : null;
            if (target === textarea) manuscriptSetView('raw', { syncScroll: false });
            if (offset !== null) textarea.setSelectionRange(offset, offset);
        },
        after: target => {
            manuscriptSetTagMenuOpen(false);
            if (insertedFromScript && target === textarea) {
                manuscriptScrollTextareaTo(textarea, textarea.selectionStart || 0, 0.3);
            }
            insertedFromScript = false;
        }
    });
    document.getElementById('tag-error-fix-btn')?.addEventListener('click', () => manuscriptSetView('raw'), true);

    // View toggle
    document.querySelectorAll('[data-manuscript-view]').forEach(button => {
        button.addEventListener('click', () => {
            if (button.getAttribute('aria-disabled') === 'true') return;
            manuscriptSetView(button.dataset.manuscriptView, { persist: true });
        });
    });

    // Script view interactions: gutter → cast, paragraph → Raw tags at that passage.
    container.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const speakerButton = target.closest('.mv-speaker[data-speaker]');
        if (speakerButton) {
            manuscriptOpenSpeaker(speakerButton.dataset.speaker);
            return;
        }
        const row = target.closest('.mv-row[data-start]');
        if (!row) return;
        const selection = window.getSelection ? window.getSelection() : null;
        if (selection && !selection.isCollapsed && container.contains(selection.anchorNode)) return;
        manuscriptRevealRange(Number(row.dataset.start) || 0, Number(row.dataset.end) || 0);
    });

    textarea.addEventListener('input', event => {
        const empty = !textarea.value.trim();
        if (empty) {
            manuscriptSetView('raw');
        } else if (manuscriptViewState.lastTextEmpty && !event.isTrusted && manuscriptViewState.view === 'raw') {
            // Bulk loads into an empty manuscript (documents, projects) open in their default view;
            // typing never flips the view.
            manuscriptSetView(manuscriptDefaultView(textarea.value));
        }
        if (empty !== manuscriptViewState.lastTextEmpty) manuscriptRefreshPending();
        manuscriptViewState.lastTextEmpty = empty;
        if (empty) manuscriptUpdateTagStatus();
        manuscriptSyncToggle();
        manuscriptScheduleRender(200);
        manuscriptMarkDirtyFromText();
    });

    // Insert tag menu (wraps the unchanged #paralinguistic-tags-bar).
    const tagWrapper = document.getElementById('manuscript-insert-tag');
    const trigger = document.getElementById('manuscript-insert-trigger');
    const menu = document.getElementById('manuscript-tag-menu');
    const bar = document.getElementById('paralinguistic-tags-bar');
    if (trigger && menu) {
        trigger.addEventListener('click', () => manuscriptSetTagMenuOpen(menu.hidden));
        document.addEventListener('click', event => {
            if (menu.hidden) return;
            if (event.target instanceof Node && tagWrapper?.contains(event.target)) return;
            manuscriptSetTagMenuOpen(false);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !menu.hidden) {
                manuscriptSetTagMenuOpen(false);
                trigger.focus();
            }
        });
    }
    if (bar && typeof MutationObserver === 'function') {
        new MutationObserver(manuscriptSyncTagMenuAvailability).observe(bar, {
            attributes: true,
            attributeFilter: ['style'],
            subtree: true
        });
    }
    manuscriptSyncTagMenuAvailability();

    // Tag status chip → first issue in Raw tags.
    document.getElementById('manuscript-tag-status')?.addEventListener('click', () => {
        const issues = typeof _tagIssues !== 'undefined' && Array.isArray(_tagIssues) ? _tagIssues : [];
        if (!issues.length || typeof _scrollToTagIssue !== 'function') return;
        _tagIssueIndex = 0;
        _scrollToTagIssue(0);
    });

    // Header save status (refreshed every 30 s) and upload status.
    manuscriptRenderProjectStatus();
    setInterval(manuscriptRenderProjectStatus, 30000);
    manuscriptWatchUploadStatus();
    document.addEventListener('change', event => {
        if (!event.isTrusted || !manuscriptHasActiveProject()) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.id === 'input-text') return;
        if (target.closest('#generate-tab, #speaker-edit-modal')) {
            manuscriptViewState.dirty = true;
            manuscriptRenderProjectStatus();
        }
    });

    // Sticky footer
    const pending = document.getElementById('generate-pending-review');
    pending?.addEventListener('click', () => manuscriptOpenSpeaker(pending.dataset.speaker));
    document.addEventListener('cast:changed', event => {
        manuscriptViewState.castEventSeen = true;
        manuscriptViewState.castSpeakers = Array.isArray(event.detail?.speakers) ? event.detail.speakers : [];
        manuscriptRenderPending(manuscriptViewState.castSpeakers);
    });
    document.addEventListener('change', event => {
        if (event.target instanceof Element && event.target.id === 'speaker-ready-checkbox') {
            setTimeout(manuscriptFallbackPending, 0);
        }
    });
    document.addEventListener('queue:status', event => manuscriptSyncQueueLine(event.detail));
    document.getElementById('generate-view-queue-btn')?.addEventListener('click', () => {
        if (typeof window.studioGoToTab === 'function') window.studioGoToTab('queue');
    });

    manuscriptInitHeadingForm();
    manuscriptInitLatestAudio();

    // Initial state (the browser may restore a previous draft into the textarea).
    manuscriptViewState.lastTextEmpty = !textarea.value.trim();
    manuscriptSetView(manuscriptDefaultView(textarea.value));
    manuscriptSyncToggle();
    manuscriptUpdateTagStatus();
    manuscriptRefreshPending();
}

document.addEventListener('DOMContentLoaded', initManuscriptView);
