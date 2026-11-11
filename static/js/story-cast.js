/* Auto cast assistant (Generate screen).
 *
 * The backend (/api/cast) segments the story, asks the configured LLM chain who
 * says each line, and keeps every decision. This file only renders the session
 * and sends the user's answers. Story text is untrusted: it is always inserted
 * with textContent, never as HTML.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'tts-story:story-cast-session';
    const POLL_RUNNING_MS = 1500;
    const MAX_LINE_QUESTIONS_SHOWN = 15;
    const STATUS_LABELS = {
        idle: 'Ready',
        running: 'Working…',
        waiting_user: 'Needs your answer',
        paused: 'Paused',
        interrupted: 'Interrupted',
        cancelled: 'Cancelled',
        completed: 'Done',
        error: 'Error',
    };
    const CONFLICTING_BUTTONS = ['gemini-process-btn', 'build-speaker-profiles-btn', 'generate-voices-btn', 'auto-assign-voices-btn'];

    let session = null;
    let pollTimer = null;
    let busy = false;
    let lastCastSignature = '';
    let segmentsCache = null;
    let showAllLineQuestions = false;
    const lockedButtons = new Map();

    const $ = id => document.getElementById(id);

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(message, type);
        else console.log(`[Auto cast] ${message}`);
    }

    function el(tag, options = {}, children = []) {
        const node = document.createElement(tag);
        if (options.className) node.className = options.className;
        if (options.text !== undefined) node.textContent = options.text;
        if (options.title) node.title = options.title;
        if (options.type) node.type = options.type;
        if (options.dataset) Object.assign(node.dataset, options.dataset);
        (Array.isArray(children) ? children : [children]).filter(Boolean).forEach(child => node.appendChild(child));
        return node;
    }

    function button(label, className, onClick, title) {
        const node = el('button', { className: `btn ${className}`, text: label, type: 'button', title });
        node.addEventListener('click', onClick);
        return node;
    }

    async function api(method, path, body) {
        const response = await fetch(`/api/cast${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        let data = {};
        try { data = await response.json(); } catch (_error) { /* non-JSON error page */ }
        if (!response.ok || data.success === false) {
            const error = new Error(data.error || `Request failed (${response.status})`);
            error.code = data.code;
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function rememberSession(id) {
        try {
            if (id) localStorage.setItem(STORAGE_KEY, id);
            else localStorage.removeItem(STORAGE_KEY);
        } catch (_error) { /* storage unavailable */ }
    }

    function currentProjectId() {
        try { return typeof activeProjectId !== 'undefined' && activeProjectId ? String(activeProjectId) : null; } catch (_error) { return null; }
    }

    function currentEngine() {
        try {
            return (typeof getSelectedJobEngine === 'function' && getSelectedJobEngine())
                || (typeof runtimeSettings !== 'undefined' && runtimeSettings && runtimeSettings.tts_engine) || '';
        } catch (_error) { return ''; }
    }

    function isActive() {
        return Boolean(session && session.status !== 'cancelled');
    }

    // ------------------------------------------------------------- session io
    function setSession(next) {
        const previous = session;
        session = next;
        rememberSession(next && next.status !== 'cancelled' ? next.id : null);
        if (!previous || previous.id !== next?.id) segmentsCache = null;
        render();
        schedulePoll();
        maybeApplyCasting();
    }

    async function refresh() {
        if (!session) return;
        try {
            const data = await api('GET', `/sessions/${session.id}`);
            setSession(data.session);
            if ($('story-cast-lines-details')?.open) loadSegments();
        } catch (error) {
            if (error.status === 404) {
                session = null;
                rememberSession(null);
                render();
            }
        }
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        if (session && session.status === 'running') {
            pollTimer = setTimeout(refresh, POLL_RUNNING_MS);
        }
    }

    async function run(action) {
        if (busy) return;
        busy = true;
        render();
        try {
            await action();
        } catch (error) {
            notify(error.message || 'Auto cast request failed', 'error');
        } finally {
            busy = false;
            render();
        }
    }

    // --------------------------------------------------------------- start
    async function start() {
        if (isActive()) {
            reveal();
            return refresh();
        }
        const text = $('input-text')?.value || '';
        if (!text.trim()) {
            notify('Load or paste a story first.', 'warning');
            return;
        }
        await run(async () => {
            let data;
            try {
                data = await api('POST', '/sessions', { text, project_id: currentProjectId() });
            } catch (error) {
                if (error.code !== 'already_tagged') throw error;
                const proceed = confirm('The manuscript already has speaker tags. Auto cast identifies speakers again on the untagged story: existing speaker tags are replaced when you apply the result (direction tags are kept). Continue?');
                if (!proceed) return;
                data = await api('POST', '/sessions', { text, project_id: currentProjectId(), strip_existing_tags: true });
            }
            lastCastSignature = '';
            reveal();
            setSession(data.session);
            notify('Auto cast started. You can keep working; questions appear in the Auto cast panel.', 'info');
        });
    }

    function reveal() {
        const panel = $('story-cast-panel');
        if (!panel) return;
        panel.hidden = false;
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ------------------------------------------------------------- answers
    function answer(question, value) {
        return run(async () => {
            const data = await api('POST', `/sessions/${session.id}/answers`, { question_id: question.id, answer: value });
            setSession(data.session);
        });
    }

    function correctLine(segmentId, speaker) {
        return run(async () => {
            const data = await api('POST', `/sessions/${session.id}/segments/${segmentId}`, { speaker });
            setSession(data.session);
            await loadSegments();
        });
    }

    function toggleExample(exampleId, enabled) {
        return run(async () => {
            const data = await api('POST', `/sessions/${session.id}/examples/${exampleId}`, { enabled });
            setSession(data.session);
        });
    }

    // ----------------------------------------------------- apply to manuscript
    async function applyToManuscript() {
        await run(async () => {
            const input = $('input-text');
            const result = await api('POST', `/sessions/${session.id}/materialize`, { current_text: input?.value || '' });
            if (result.current_matches === false
                && !confirm('The manuscript was edited after Auto cast started. Replace it with the story as it was when Auto cast started, tagged by speaker?')) {
                return;
            }
            if (input) {
                input.value = result.text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (typeof analyzeText === 'function') {
                try { await analyzeText({ auto: true }); } catch (_error) { /* auto-analysis also runs on input */ }
            }
            lastCastSignature = '';
            setSession(result.session);
            const pending = result.session.questions.length;
            notify(pending
                ? `Manuscript updated. ${pending} question(s) still need an answer before generating audio.`
                : 'Manuscript updated with one tag per character.', pending ? 'warning' : 'success');
        });
    }

    // ------------------------------------------------------------- catalog
    function voiceEntries() {
        // Provider catalogs are top-level bindings of main.js (shared script scope).
        const lists = [];
        const add = value => { if (Array.isArray(value)) lists.push(...value); };
        add(typeof edgeTtsVoices !== 'undefined' ? edgeTtsVoices : null);
        add(typeof azureSpeechVoices !== 'undefined' ? azureSpeechVoices : null);
        add(typeof elevenLabsVoices !== 'undefined' ? elevenLabsVoices : null);
        add(typeof openAITtsVoices !== 'undefined' ? openAITtsVoices : null);
        add(typeof localAITtsVoices !== 'undefined' ? localAITtsVoices : null);
        add(window.breezeApiVoices);
        return lists;
    }

    function firstAssignmentRow() {
        try { return typeof getAssignmentRows === 'function' ? getAssignmentRows()[0] : null; } catch (_error) { return null; }
    }

    function usesSamples(row) {
        const control = row?.querySelector('[data-role="turbo-control"]');
        return Boolean(control && !control.hidden && control.style.display !== 'none');
    }

    function collectCatalog() {
        const engine = currentEngine();
        const row = firstAssignmentRow();
        if (!row) return { engine, mode: null, catalog: [] };
        if (usesSamples(row)) {
            const minDuration = typeof getMinDurationForEngine === 'function' ? getMinDurationForEngine(engine) : 0;
            const samples = typeof availableChatterboxVoices !== 'undefined' ? availableChatterboxVoices : [];
            const catalog = samples
                .filter(entry => !entry.archived && (entry.prompt_path || entry.file_name))
                .filter(entry => !minDuration || entry.duration_seconds == null || entry.duration_seconds >= minDuration)
                .map(entry => ({
                    id: String(entry.prompt_path || entry.file_name).trim(),
                    label: entry.name || entry.prompt_path || entry.file_name,
                    gender: entry.gender || '',
                    locale: entry.language || '',
                    description: entry.description || entry.voice_design?.instruction || '',
                }));
            return { engine, mode: 'sample', catalog };
        }
        const select = row.querySelector('.voice-select');
        const known = voiceEntries();
        const catalog = Array.from(select?.options || [])
            .filter(option => option.value && !option.disabled)
            .map(option => {
                const entry = known.find(voice => (voice.short_name || voice.voice_id) === option.value) || {};
                const labels = entry.labels && typeof entry.labels === 'object' ? Object.values(entry.labels).join(', ') : '';
                return {
                    id: option.value,
                    label: option.textContent.trim(),
                    gender: entry.gender || '',
                    locale: entry.locale || option.dataset.locale || '',
                    description: [entry.description, labels, (entry.style_list || entry.styles || []).slice?.(0, 6).join(', ')].filter(Boolean).join('; '),
                };
            });
        return { engine, mode: 'voice', catalog };
    }

    async function castVoices() {
        if (!session.materialized) {
            notify('Apply the result to the manuscript first, so every character appears in the Cast list.', 'warning');
            return;
        }
        const { engine, catalog } = collectCatalog();
        if (!catalog.length) {
            notify('No voices are available for the selected engine. Choose an engine in Output and load or add voices first.', 'warning');
            return;
        }
        await run(async () => {
            lastCastSignature = '';
            const data = await api('POST', `/sessions/${session.id}/cast`, { engine, catalog });
            setSession(data.session);
        });
    }

    function castSignature(state) {
        if (!state) return '';
        return JSON.stringify([state.casting?.engine, state.characters.map(c => [c.tag, c.voice])]);
    }

    // Push the session's voices into the Cast list whenever they change (after
    // casting, an approved share, or re-applying the manuscript).
    function maybeApplyCasting() {
        if (!session || !session.materialized || session.status === 'running') return;
        if (!session.characters.some(character => character.voice)) return;
        if (session.casting?.engine && session.casting.engine !== currentEngine()) return;
        const signature = castSignature(session);
        if (signature === lastCastSignature) return;
        lastCastSignature = signature;
        applyCastingToUI();
    }

    function setSelectValue(select, value) {
        if (!select || !value) return;
        if (!Array.from(select.options).some(option => option.value === value)) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            select.appendChild(option);
        }
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function applyCastingToUI() {
        const row = firstAssignmentRow();
        if (!row) return;
        const sampleMode = usesSamples(row);
        let applied = 0;
        session.characters.forEach(character => {
            if (!character.voice || !character.tag) return;
            const selector = sampleMode ? '.reference-select' : '.voice-select';
            const targets = document.querySelectorAll(
                `#inline-voice-assignment-list ${selector}[data-speaker="${CSS.escape(character.tag)}"],` +
                `#speaker-edit-modal-body .voice-assignment-row[data-speaker="${CSS.escape(character.tag)}"] ${selector}`
            );
            if (sampleMode) {
                try { turboSelectionState[character.tag] = character.voice; } catch (_error) { /* not a sample engine */ }
                targets.forEach(select => {
                    if (typeof setReferenceSelectValue === 'function') setReferenceSelectValue(select, character.voice);
                    else setSelectValue(select, character.voice);
                });
            } else {
                targets.forEach(select => setSelectValue(select, character.voice));
            }
            if (targets.length || sampleMode) applied += 1;
        });
        if (typeof castViewRender === 'function') castViewRender();
        if (applied) notify(`Voices assigned to ${applied} character(s). Review them in the Cast list.`, 'success');
    }

    // ------------------------------------------------------ generate hooks
    function generationBlocker() {
        if (!session || session.status === 'cancelled' || !session.materialized) return '';
        if (session.status === 'running') return 'Auto cast is still working. Wait for it to finish or cancel the session.';
        if (session.questions.length) return `Answer the ${session.questions.length} Auto cast question(s) before generating audio.`;
        return '';
    }

    function decorateGeneratePayload(payload) {
        if (!session || session.status === 'cancelled' || !session.materialized) return payload;
        payload.story_cast_session_id = session.id;
        payload.strict_assignments = true;
        return payload;
    }

    // ------------------------------------------------------------ rendering
    function setLock(locked) {
        CONFLICTING_BUTTONS.forEach(id => {
            const node = $(id);
            if (!node) return;
            if (locked && !lockedButtons.has(id)) {
                lockedButtons.set(id, node.disabled);
                node.disabled = true;
                node.dataset.storyCastLock = '1';
            } else if (!locked && lockedButtons.has(id)) {
                node.disabled = lockedButtons.get(id);
                lockedButtons.delete(id);
                delete node.dataset.storyCastLock;
            }
        });
    }

    function render() {
        const panel = $('story-cast-panel');
        const launch = $('story-cast-btn');
        if (!panel) return;
        const running = session?.status === 'running';
        setLock(Boolean(running));
        if (launch) {
            launch.classList.toggle('has-pending', Boolean(session?.questions?.length));
            launch.disabled = busy;
        }
        if (!session) {
            panel.hidden = true;
            return;
        }
        const status = $('story-cast-status');
        status.textContent = STATUS_LABELS[session.status] || session.status;
        status.dataset.state = session.status;

        const progress = $('story-cast-progress');
        progress.hidden = !running;
        if (running) {
            const { done = 0, total = 0, label = '' } = session.progress || {};
            $('story-cast-progress-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '8%';
            $('story-cast-progress-label').textContent = total ? `${label} · ${done}/${total}` : label;
        }
        renderMeta();
        const error = $('story-cast-error');
        error.hidden = !session.error;
        error.textContent = session.error || '';

        $('story-cast-pause').hidden = !running;
        $('story-cast-resume').hidden = !['paused', 'interrupted', 'error'].includes(session.status);
        $('story-cast-cancel').hidden = session.status === 'cancelled';
        ['story-cast-pause', 'story-cast-resume', 'story-cast-cancel'].forEach(id => { $(id).disabled = busy; });

        const ready = session.phase !== 'attribution' && !running && session.status !== 'cancelled';
        $('story-cast-apply').disabled = busy || !ready;
        $('story-cast-cast').disabled = busy || !ready || !session.materialized;
        $('story-cast-cast').title = session.materialized
            ? 'Choose a voice for every character with the engine selected in Output'
            : 'Apply the result to the manuscript first';

        renderQuestions();
        renderCharacters();
        renderExamples();
        renderLog();
        if ($('story-cast-lines-details')?.open) renderLines();
    }

    function renderMeta() {
        const meta = $('story-cast-meta');
        meta.innerHTML = '';
        const add = (label, value, className) => {
            const item = el('span', { className }, [document.createTextNode(`${label} `), el('strong', { text: String(value) })]);
            meta.appendChild(item);
        };
        const counts = session.counts || {};
        add('Speech', counts.speech ?? 0);
        add('Unclear', counts.doubtful ?? 0);
        add('Corrected', counts.corrected ?? 0);
        if (session.language) add('Language', session.language);
        const budget = session.budget || {};
        const limit = Number(budget.limit) || 0;
        const used = Number(budget.paid_requests) || 0;
        add('Paid requests', limit ? `${used}/${limit}` : `${used} (no limit)`, limit && used >= limit * 0.8 ? 'is-near-limit' : '');
        if (budget.local_only) add('Mode', 'local models only');
        if (session.narration?.first_person && session.narration.voice) {
            const narrator = session.characters.find(c => c.id === session.narration.voice);
            if (narrator) add('Narrated by', narrator.name);
        }
    }

    function questionCard(question) {
        const card = el('div', { className: 'sc-question', dataset: { questionId: question.id } });
        const isLine = question.type === 'doubtful_line';
        card.appendChild(el('p', { className: `sc-question-title${isLine ? ' is-quote' : ''}`, text: question.title }));
        if (question.body) card.appendChild(el('p', { className: 'sc-question-body', text: question.body }));
        if (question.kind === 'review') {
            const list = el('div', { className: 'sc-review-items' });
            question.items.forEach(item => {
                const checkbox = el('input', { type: 'checkbox' });
                checkbox.checked = true;
                checkbox.value = item.id;
                const label = el('label', { className: 'sc-review-item' }, [
                    checkbox,
                    el('span', {}, [el('q', { text: item.text }), el('span', { className: 'sc-change', text: `${item.from} → ${item.to}` })]),
                ]);
                list.appendChild(label);
            });
            card.appendChild(list);
            const options = el('div', { className: 'sc-question-options' });
            options.appendChild(button('Apply selected', 'btn-primary btn-xs', () => {
                const accepted = Array.from(list.querySelectorAll('input:checked')).map(input => input.value);
                answer(question, { accepted });
            }));
            options.appendChild(button('Reject all', 'btn-ghost btn-xs', () => answer(question, { accepted: [] })));
            card.appendChild(options);
            return card;
        }
        const options = el('div', { className: 'sc-question-options' });
        question.options.forEach((option, index) => {
            const style = index === 0 && !isLine ? 'btn-primary btn-xs' : 'btn-secondary btn-xs';
            options.appendChild(button(option.label, style, () => answer(question, option.value), option.description));
        });
        card.appendChild(options);
        return card;
    }

    function renderQuestions() {
        const host = $('story-cast-questions');
        host.innerHTML = '';
        const questions = session.questions || [];
        const lineQuestions = questions.filter(q => q.type === 'doubtful_line');
        questions.filter(q => q.type !== 'doubtful_line').forEach(q => host.appendChild(questionCard(q)));
        if (!lineQuestions.length) return;
        const header = el('div', { className: 'sc-group-header' }, [
            el('span', { text: `Who says these ${lineQuestions.length} line(s)?` }),
        ]);
        host.appendChild(header);
        const visible = showAllLineQuestions ? lineQuestions : lineQuestions.slice(0, MAX_LINE_QUESTIONS_SHOWN);
        visible.forEach(q => host.appendChild(questionCard(q)));
        if (lineQuestions.length > visible.length) {
            host.appendChild(button(`Show ${lineQuestions.length - visible.length} more`, 'btn-ghost btn-xs', () => {
                showAllLineQuestions = true;
                renderQuestions();
            }));
        }
    }

    function voiceLabel(voiceId) {
        if (!voiceId) return '';
        const option = Array.from(document.querySelectorAll('#inline-voice-assignment-list option'))
            .find(candidate => candidate.value === voiceId);
        return option ? option.textContent.trim() : voiceId.split('/').pop();
    }

    function renderCharacters() {
        const host = $('story-cast-characters');
        host.innerHTML = '';
        const voiceUsers = {};
        session.characters.forEach(c => { if (c.voice) (voiceUsers[c.voice] = voiceUsers[c.voice] || []).push(c.name); });
        session.characters.filter(c => c.lines > 0).forEach(character => {
            const name = el('span', { className: 'sc-character-name', text: character.name }, character.tag ? [el('code', { text: character.tag })] : []);
            const stats = el('span', {
                className: 'sc-character-stats',
                text: `${character.lines} line${character.lines === 1 ? '' : 's'}${character.doubtful ? ` · ${character.doubtful} unclear` : ''}`,
            });
            const shared = character.voice && voiceUsers[character.voice].length > 1;
            let voiceText = '';
            let voiceClass = '';
            if (character.voice) {
                voiceText = `Voice: ${voiceLabel(character.voice)}${shared ? ` (shared with ${voiceUsers[character.voice].filter(n => n !== character.name).join(', ')})` : ''}`;
                voiceClass = shared ? ' is-shared' : '';
            } else if (session.phase === 'done') {
                voiceText = 'No voice yet: assign one in the Cast list';
                voiceClass = ' is-missing';
            }
            const row = el('div', { className: 'sc-character' }, [name, stats]);
            if (voiceText) row.appendChild(el('span', { className: `sc-character-voice${voiceClass}`, text: voiceText }));
            host.appendChild(row);
        });
    }

    function renderExamples() {
        const host = $('story-cast-examples');
        const examples = session.examples || [];
        $('story-cast-examples-count').textContent = examples.length ? `(${examples.filter(e => e.enabled).length}/${examples.length})` : '';
        host.innerHTML = '';
        if (!examples.length) {
            host.appendChild(el('p', { className: 'sc-empty', text: 'No corrections yet.' }));
            return;
        }
        examples.forEach(example => {
            const checkbox = el('input', { type: 'checkbox' });
            checkbox.checked = example.enabled !== false;
            checkbox.disabled = busy;
            checkbox.addEventListener('change', () => toggleExample(example.id, checkbox.checked));
            const speaker = session.characters.find(c => c.id === example.speaker_id);
            host.appendChild(el('label', { className: `sc-example${example.enabled === false ? ' is-disabled' : ''}` }, [
                checkbox,
                el('span', { text: `“${example.text.slice(0, 140)}” → ${speaker ? speaker.name : example.speaker_key}` }),
            ]));
        });
    }

    function renderLog() {
        const host = $('story-cast-log');
        host.innerHTML = '';
        (session.log || []).slice().reverse().forEach(entry => host.appendChild(el('li', { text: entry.message })));
    }

    async function loadSegments() {
        if (!session) return;
        try {
            const data = await api('GET', `/sessions/${session.id}?segments=1`);
            segmentsCache = data.session.segments || [];
            renderLines();
        } catch (error) {
            notify(error.message, 'error');
        }
    }

    function renderLines() {
        const host = $('story-cast-lines');
        if (!host) return;
        host.innerHTML = '';
        if (!segmentsCache) {
            host.appendChild(el('p', { className: 'sc-empty', text: 'Loading…' }));
            return;
        }
        const filter = $('story-cast-lines-filter')?.value || 'doubtful';
        const lines = segmentsCache.filter(line => filter === 'all' || line.doubtful);
        if (!lines.length) {
            host.appendChild(el('p', { className: 'sc-empty', text: filter === 'all' ? 'No speech lines.' : 'No unclear lines.' }));
            return;
        }
        const people = session.characters.filter(c => c.id !== 'narrator');
        lines.slice(0, 400).forEach(line => {
            const select = el('select', { className: 'select-compact' });
            select.setAttribute('aria-label', 'Speaker');
            if (line.speaker === 'unknown') select.appendChild(el('option', { text: 'Unclear' }));
            [{ id: 'narrator', name: 'Narrator' }, ...people].forEach(character => {
                const option = el('option', { text: character.name });
                option.value = character.id;
                select.appendChild(option);
            });
            select.value = line.speaker === 'unknown' ? select.options[0].value : line.speaker;
            select.disabled = busy || session.status === 'running';
            select.addEventListener('change', () => {
                if (select.value && select.value !== 'Unclear') correctLine(line.id, select.value);
            });
            const meta = el('div', { className: 'sc-line-meta' }, [
                select,
                el('span', { text: line.locked ? 'corrected by you' : (line.doubtful ? 'unclear' : `confidence ${Math.round(line.confidence * 100)}%`) }),
            ]);
            host.appendChild(el('div', { className: `sc-line${line.doubtful ? ' is-doubtful' : ''}` }, [
                el('div', { className: 'sc-line-text', text: line.text }),
                meta,
            ]));
        });
        if (lines.length > 400) host.appendChild(el('p', { className: 'sc-empty', text: `Showing the first 400 of ${lines.length} lines.` }));
    }

    // ------------------------------------------------------------- lifecycle
    async function attach(sessionId) {
        if (!sessionId) return;
        try {
            const data = await api('GET', `/sessions/${sessionId}`);
            if (data.session.status === 'cancelled') return;
            lastCastSignature = castSignature(data.session);
            setSession(data.session);
            const panel = $('story-cast-panel');
            if (panel) panel.hidden = false;
        } catch (_error) {
            rememberSession(null);
        }
    }

    function onProjectLoaded(project) {
        clearTimeout(pollTimer);
        session = null;
        segmentsCache = null;
        render();
        if (project && project.story_cast_session_id) attach(project.story_cast_session_id);
        else rememberSession(null);  // a project without a session must not reopen the previous one
    }

    function init() {
        $('story-cast-btn')?.addEventListener('click', start);
        $('story-cast-hide')?.addEventListener('click', () => { $('story-cast-panel').hidden = true; });
        $('story-cast-pause')?.addEventListener('click', () => run(async () => setSession((await api('POST', `/sessions/${session.id}/pause`)).session)));
        $('story-cast-resume')?.addEventListener('click', () => run(async () => setSession((await api('POST', `/sessions/${session.id}/resume`)).session)));
        $('story-cast-cancel')?.addEventListener('click', () => {
            if (!confirm('Cancel this Auto cast session? The manuscript and voices already applied are kept.')) return;
            run(async () => {
                const data = await api('POST', `/sessions/${session.id}/cancel`);
                setSession(data.session);
                $('story-cast-panel').hidden = true;
            });
        });
        $('story-cast-apply')?.addEventListener('click', applyToManuscript);
        $('story-cast-cast')?.addEventListener('click', castVoices);
        $('story-cast-lines-details')?.addEventListener('toggle', event => {
            if (event.target.open) loadSegments();
        });
        $('story-cast-lines-filter')?.addEventListener('change', renderLines);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && session) refresh();
        });
        let stored = null;
        try { stored = localStorage.getItem(STORAGE_KEY); } catch (_error) { stored = null; }
        if (stored) attach(stored);
    }

    window.storyCast = {
        getSessionId: () => (session && session.status !== 'cancelled' ? session.id : null),
        generationBlocker,
        decorateGeneratePayload,
        onProjectLoaded,
        reveal,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
