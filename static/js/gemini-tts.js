/* Google presets and hosted designs; no local sample uploads. */
window.isGeminiTtsEngine = engine => ['gemini_tts', 'gemini_tts_lite'].includes(engine);
window.geminiTtsVoices = [];
window.ensureGeminiVoiceOption = (select, id) => {
    if (select && /^voice_[A-Za-z0-9_-]+$/.test(id || '') && !Array.from(select.options).some(option => option.value === id)) {
        select.add(new Option(`Saved Google voice: ${id}`, id));
    }
};
const geminiTtsDefaults = {api_key: '', default_voice: 'Kore', instructions: '', timeout: 180, max_parallel: 1, chunk_size: 1000};
const geminiTtsInput = key => document.getElementById('gemini-tts-' + key.replaceAll('_', '-'));
window.loadGeminiTtsSettings = settings => {
    for (const [key, fallback] of Object.entries(geminiTtsDefaults)) {
        if (key === 'default_voice' && geminiTtsInput(key)) {
            const voice = settings.gemini_tts_default_voice || 'Kore';
            if (!Array.from(geminiTtsInput(key).options).some(o => o.value === voice)) {
                geminiTtsInput(key).add(new Option(voice, voice));
            }
        }
        if (geminiTtsInput(key)) geminiTtsInput(key).value = settings['gemini_tts_' + key] ?? fallback;
    }
};
window.collectGeminiTtsSettings = () => Object.fromEntries(Object.entries(geminiTtsDefaults).map(([key, fallback]) => {
    const raw = geminiTtsInput(key)?.value ?? fallback;
    return ['gemini_tts_' + key, typeof fallback === 'number' ? Number(raw) : String(raw).trim()];
}));
let geminiCatalogPromise;
window.loadGeminiTtsCatalog = (refresh = false) => {
    if (refresh) geminiCatalogPromise = null;
    if (!geminiCatalogPromise) geminiCatalogPromise = fetch('/api/gemini-tts/catalog').then(r => {
        if (!r.ok) throw new Error('Cannot load Gemini preset voices. Restart the backend and reload.');
        return r.json();
    }).then(data => {
        window.geminiTtsVoices = data.voices || [];
        window.renderGeminiVoiceManager?.();
        if (data.warning) showNotification(data.warning, 'warning');
        const select = geminiTtsInput('default_voice');
        if (select) {
            const value = select.value || 'Kore';
            select.replaceChildren(...data.voices.map(v => new Option(v.display_name, v.short_name)));
            window.ensureGeminiVoiceOption(select, value);
            select.value = value;
        }
        if (window.isGeminiTtsEngine(getSelectedJobEngine())) {
            populateVoiceSelects();
            populateDefaultVoiceSelect();
        }
        return data;
    }).catch(error => {
        geminiCatalogPromise = null;
        showNotification(error.message, 'warning');
        return {success: false, voices: []};
    });
    return geminiCatalogPromise;
};
document.addEventListener('DOMContentLoaded', () => {
    window.loadGeminiTtsCatalog().then(data => {
        // The automatic load already lists hosted designs; replace the "click refresh" prompt.
        const status = document.getElementById('gemini-voices-manager-status');
        if (!status || !data || data.success === false) return;
        status.textContent = data.warning || (!data.design_available ? 'Save your Gemini TTS API key in Settings to list and design hosted voices.' : '');
    });
    document.getElementById('gemini-voices-refresh')?.addEventListener('click', async event => {
        const status = document.getElementById('gemini-voices-manager-status');
        event.currentTarget.disabled = true;
        const button = event.currentTarget;
        status.textContent = 'Loading custom voices from Google…';
        try {
            const data = await window.loadGeminiTtsCatalog(true);
            status.textContent = data.warning || (!data.success ? 'Could not load voices. Try again.' : !data.design_available ? 'Save your Gemini TTS API key in Settings first.' : `${(data.voices || []).filter(v => v.designed).length} custom voices loaded.`);
        } finally { button.disabled = false; }
    });
    document.getElementById('gemini-voices-filter')?.addEventListener('input', () => window.renderGeminiVoiceManager());
    document.getElementById('gemini-tts-test')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const status = document.getElementById('gemini-tts-status');
        button.disabled = true;
        status.textContent = 'Checking model access…';
        try {
            const response = await fetch('/api/gemini-tts/test', {method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({api_key: geminiTtsInput('api_key').value})});
            const data = await response.json();
            status.textContent = data.success ? data.message : data.error;
        } catch { status.textContent = 'Connection test failed. Check that the backend is running.'; }
        finally { button.disabled = false; }
    });
});

function geminiManagedVoices(voices, query = '') {
    const term = query.trim().toLowerCase();
    return voices.filter(v => v.designed && /^voice_[A-Za-z0-9_-]+$/.test(v.short_name)
        && `${v.display_name} ${v.short_name}`.toLowerCase().includes(term));
}
let geminiManagerDeleting = false;
const geminiManagerSelection = new Set();
window.renderGeminiVoiceManager = () => {
    const list = document.getElementById('gemini-voices-manager-list');
    if (!list) return;
    const status = document.getElementById('gemini-voices-manager-status');
    const player = document.getElementById('gemini-voices-manager-player');
    const voices = geminiManagedVoices(window.geminiTtsVoices, document.getElementById('gemini-voices-filter')?.value || '');
    const managedCount = geminiManagedVoices(window.geminiTtsVoices).length;
    window.studioVoicesCount?.('gemini-hosted', managedCount || '');
    list.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'gemini-voice-toolbar';
    const summary = document.createElement('span');
    summary.className = 'gemini-voice-toolbar-summary';
    toolbar.append(summary);
    const action = (label, handler, className = 'btn btn-ghost btn-sm') => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = className; button.textContent = label;
        button.disabled = geminiManagerDeleting; button.onclick = handler; toolbar.append(button);
        return button;
    };
    action('Select visible', () => { voices.forEach(v => geminiManagerSelection.add(v.short_name)); window.renderGeminiVoiceManager(); });
    action('Clear selection', () => { geminiManagerSelection.clear(); window.renderGeminiVoiceManager(); });
    const selected = geminiManagedVoices(window.geminiTtsVoices).filter(v => geminiManagerSelection.has(v.short_name));
    const plural = managedCount === 1 ? '' : 's';
    summary.textContent = selected.length ? `${selected.length} selected`
        : (voices.length === managedCount ? `${managedCount} custom voice${plural}` : `${voices.length} of ${managedCount} custom voice${plural}`);
    // Nothing to select or delete yet: the empty message below says what to do.
    toolbar.hidden = !managedCount;
    const bulkDelete = action(`Delete selected (${selected.length})`, async () => {
        if (geminiManagerDeleting || !selected.length || !window.confirm(`Permanently delete ${selected.length} Google voices?\n\n${selected.map(v => v.display_name + ' (' + v.short_name + ')').join('\n')}\n\nProjects using these voices will need replacements for future generation. Existing audio is unchanged. This cannot be undone.`)) return;
        geminiManagerDeleting = true; window.renderGeminiVoiceManager();
        status.textContent = 'Deleting selected voices…';
        try {
            const {deleted, failed} = await discardGeminiCandidates('', selected.map(v => ({id: v.short_name, name: v.display_name})));
            deleted.forEach(id => geminiManagerSelection.delete(id));
            if (deleted.includes(player.dataset.voiceId)) { player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true; }
            window.geminiTtsVoices = window.geminiTtsVoices.filter(v => !deleted.includes(v.short_name));
            for (const [key, items] of Object.entries(geminiAuditionGroups)) {
                if (Array.isArray(items)) geminiAuditionGroups[key] = items.filter(v => !deleted.includes(v.id));
            }
            saveGeminiAuditionGroups();
            await window.loadGeminiTtsCatalog(true);
            status.textContent = `${deleted.length} voice(s) deleted. Existing audio is unchanged.` + (failed.length ? ` Failed: ${failed.map(v => v.name + ': ' + v.error).join('; ')}` : '');
        } finally { geminiManagerDeleting = false; window.renderGeminiVoiceManager(); }
    }, 'btn btn-danger btn-sm');
    bulkDelete.disabled = geminiManagerDeleting || !selected.length;
    list.append(toolbar);
    if (!voices.length) {
        const empty = document.createElement('p');
        empty.className = 'gemini-manager-empty';
        empty.textContent = managedCount
            ? 'No matching custom voices. Clear the search or refresh to check Google’s saved voice library.'
            : 'No custom voices yet. Design a new voice, or refresh to check Google’s saved voice library.';
        list.append(empty);
    }
    for (const voice of voices) {
        const row = document.createElement('div');
        row.className = 'gemini-voice-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.className = 'voices-check'; checkbox.checked = geminiManagerSelection.has(voice.short_name);
        checkbox.disabled = geminiManagerDeleting; checkbox.setAttribute('aria-label', `Select ${voice.display_name}`);
        checkbox.onchange = () => { if (checkbox.checked) geminiManagerSelection.add(voice.short_name); else geminiManagerSelection.delete(voice.short_name); window.renderGeminiVoiceManager(); };
        const title = document.createElement('strong');
        // Every row here is a designed voice, so the catalog's "Designed: " prefix is redundant.
        title.textContent = String(voice.display_name || '').replace(/^Designed:\s*/, '') || voice.short_name;
        const id = document.createElement('small');
        id.textContent = voice.short_name;
        const identity = document.createElement('div'); identity.className = 'gemini-voice-identity'; identity.append(title, id);
        const play = document.createElement('button');
        play.type = 'button'; play.className = 'btn-circle gemini-play'; play.textContent = '▶'; play.setAttribute('aria-label', `Play ${voice.display_name}`);
        play.onclick = () => {
            player.hidden = false;
            player.dataset.voiceId = voice.short_name;
            player.src = `/api/gemini-tts/voices/${encodeURIComponent(voice.short_name)}/preview`;
            player.onerror = () => { status.textContent = 'Preview unavailable. Refresh the list; the voice may have expired or belong to another Google project.'; };
            player.play().catch(() => { status.textContent = 'Preview could not be played.'; });
        };
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'btn btn-ghost btn-sm gemini-delete'; remove.textContent = 'Delete';
        remove.disabled = geminiManagerDeleting;
        remove.onclick = async () => {
            if (geminiManagerDeleting || !window.confirm(`Permanently delete "${voice.display_name}" (${voice.short_name}) from Google?\n\nAny projects using this voice will need another voice for future generation or regeneration. Existing audio files are not changed. This cannot be undone.`)) return;
            geminiManagerDeleting = true;
            window.renderGeminiVoiceManager();
            status.textContent = 'Deleting hosted voice…';
            try {
                const response = await fetch(`/api/gemini-tts/voices/${encodeURIComponent(voice.short_name)}`, {method: 'DELETE',
                    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirm: true})});
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Deletion failed.');
                recordGeminiVoiceDeletion([voice.short_name]);
                if (player.dataset.voiceId === voice.short_name) {
                    player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true;
                }
                for (const [group, items] of Object.entries(geminiAuditionGroups)) {
                    if (!Array.isArray(items)) continue;
                    geminiAuditionGroups[group] = items.filter(v => v.id !== voice.short_name);
                    if (!geminiAuditionGroups[group].length) delete geminiAuditionGroups[group];
                }
                saveGeminiAuditionGroups();
                window.geminiTtsVoices = window.geminiTtsVoices.filter(v => v.short_name !== voice.short_name);
                // Keep existing assignments identifiable rather than silently changing the speaker.
                document.querySelectorAll('.voice-select option, #gemini-tts-default-voice option').forEach(option => {
                    if (option.value === voice.short_name) option.textContent = `Deleted Google voice: ${voice.short_name} — select a replacement`;
                });
                const refreshed = await window.loadGeminiTtsCatalog(true);
                status.textContent = 'Voice deleted from Google. Existing audio is unchanged.' + (refreshed.warning ? ` Refresh warning: ${refreshed.warning}` : '');
            } catch (error) { status.textContent = error.message; }
            finally { geminiManagerDeleting = false; window.renderGeminiVoiceManager(); }
        };
        row.append(checkbox, play, identity, remove);
        list.append(row);
    }
};

const geminiAuditionStorageKey = 'ttsStory.geminiAuditions.v1';
const geminiDeletedVoiceIds = new Set();
try {
    const ids = JSON.parse(localStorage.getItem('ttsStory.geminiDeleted.v1') || '[]');
    if (Array.isArray(ids)) ids.forEach(id => geminiDeletedVoiceIds.add(id));
} catch { /* Deletion markers are best-effort browser recovery data. */ }
function recordGeminiVoiceDeletion(ids) {
    ids.forEach(id => geminiDeletedVoiceIds.add(id));
    try { localStorage.setItem('ttsStory.geminiDeleted.v1', JSON.stringify([...geminiDeletedVoiceIds])); } catch { /* Keep in memory. */ }
}
let geminiAuditionGroups = {};
try {
    const saved = JSON.parse(localStorage.getItem(geminiAuditionStorageKey) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) geminiAuditionGroups = saved;
} catch { /* Storage may be unavailable; current-session grouping still works. */ }
function saveGeminiAuditionGroups() {
    try { localStorage.setItem(geminiAuditionStorageKey, JSON.stringify(geminiAuditionGroups)); } catch { /* Keep in memory. */ }
}
function geminiSiblingCandidates(selectedId) {
    const group = Object.values(geminiAuditionGroups).find(items => Array.isArray(items) && items.some(v => v.id === selectedId));
    return (group || []).filter(v => v.id !== selectedId && /^voice_[A-Za-z0-9_-]+$/.test(v.id));
}
async function discardGeminiCandidates(selectedId, candidates) {
    const deleted = [], failed = [];
    for (const candidate of candidates) {
        if (candidate.id === selectedId || deleted.includes(candidate.id)) continue;
        try {
            const response = await fetch(`/api/gemini-tts/voices/${encodeURIComponent(candidate.id)}`, {
                method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirm: true})});
            if (response.status === 404 || response.status === 405) throw new Error('The running backend does not support voice deletion. Restart TTS-Story and retry cleanup.');
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Deletion failed');
            deleted.push(candidate.id);
            recordGeminiVoiceDeletion([candidate.id]);
        } catch (error) { failed.push({...candidate, error: error.message}); }
    }
    return {deleted, failed};
}

function geminiAuditionDraftKey(scope) {
    // Compact, stable project/speaker key; manuscript contents are not stored in keys.
    let hash = 2166136261;
    for (const char of scope) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return 'ttsStory.geminiPending.v1.' + (hash >>> 0).toString(16);
}
function restoreGeminiAudition(audition, scope) {
    let state = audition || {};
    try {
        const draft = scope && JSON.parse(localStorage.getItem(geminiAuditionDraftKey(scope)) || 'null');
        if (draft && draft.scope === scope && Number(draft.state?.updated_at) > Number(state.updated_at || 0)) state = draft.state;
    } catch { /* Project metadata remains available when browser storage is disabled. */ }
    return {...state, candidates: (Array.isArray(state.candidates) ? state.candidates : [])
        .filter(v => /^voice_[A-Za-z0-9_-]+$/.test(v?.id) && !geminiDeletedVoiceIds.has(v.id)).map(v => ({id: v.id, name: String(v.name || v.id)}))};
}
async function createGeminiCandidates(count, payload, onCandidate) {
    // Independent billable requests: bounded at four, with no automatic retries.
    return Promise.allSettled(Array.from({length: Math.max(1, Math.min(4, count))}, async (_, index) => {
        const label = payload.name + (count > 1 ? ` — Candidate ${String.fromCharCode(65 + index)}` : '');
        const response = await fetch('/api/gemini-tts/voices', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({...payload, name: label})});
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Voice creation failed.');
        const candidate = {id: data.id, name: data.name || label};
        onCandidate(candidate, index);
        return candidate;
    }));
}
// Kept separate from local sample creation: these IDs belong to the Google project.
window.openGeminiVoiceDesigner = ({name = '', description = '', onSelect = null, container = null, candidateCount = 1,
    audition = null, onAuditionChange = null, storageScope = '', reveal = true, compact = false, getGenerationInputs = null, lastGenerationError = ''} = {}) => {
    const existing = container?.querySelector('[data-gemini-inline-designer]');
    if (existing) { existing.scrollIntoView({block: 'nearest', behavior: 'smooth'}); return existing; }
    const dialog = document.createElement(container ? 'section' : 'dialog');
    if (container) dialog.dataset.geminiInlineDesigner = 'true';
    dialog.style.cssText = container
        ? 'width:100%;box-sizing:border-box;border:1px solid var(--border-color,#777);border-radius:12px;padding:16px;margin-top:16px'
        : 'width:min(640px,92vw);max-height:85vh;overflow:auto;background:var(--st-panel,#1f1c19);color:var(--st-text,#ece6dc);border:1px solid var(--st-border-control,#36322c);border-radius:10px;padding:22px 24px;box-shadow:0 24px 48px rgba(0,0,0,0.45)';
    dialog.innerHTML = `
        <div data-design-form>
        <h2>Gemini Voice Design</h2>
        <p>Creates hosted Google voices using your saved Gemini TTS key. Each candidate is saved to Google immediately and may incur charges. Selecting a candidate offers to permanently delete its other audition candidates. Unrelated voices are kept. Up to 200 voices per Google project; stored voices expire after one year. Local cloning samples are not uploaded.</p>
        <label style="display:block">Name<input data-field="name" style="display:block;width:100%" maxlength="150"></label>
        <label style="display:block">Voice description<textarea data-field="description" rows="4" style="display:block;width:100%" placeholder="Warm, resonant alto, gentle rasp, relaxed pace, British accent. Describe stable identity, not a scene's emotion."></textarea></label>
        <label style="display:block">Design model<select data-field="engine"><option value="gemini_tts">Gemini Flash TTS</option><option value="gemini_tts_lite">Gemini Flash-Lite TTS</option></select></label>
        <label style="display:block">Candidates<input data-field="count" type="number" min="1" max="4" value="1"></label>
        <p>Google supplies the audition text. Its preview is not the standardized local-engine passage.</p>
        <button type="button" class="btn btn-primary" data-action="create">Create voices (billable)</button>
        <button type="button" class="btn btn-secondary" data-action="refresh">Refresh current candidates</button>
        <p>This audition shows only the candidates generated here. Browse all saved designs under Voices → Gemini cloud voices.</p>
        </div>
        <p data-status role="status"></p>
        <div data-results></div>
        <button type="button" class="btn btn-secondary" data-action="close">Close</button>`;
    const field = key => dialog.querySelector(`[data-field="${key}"]`);
    field('name').value = name;
    field('description').value = description;
    field('count').value = Math.max(1, Math.min(4, Number(candidateCount) || 1));
    if (window.isGeminiTtsEngine(getSelectedJobEngine())) field('engine').value = getSelectedJobEngine();
    const status = dialog.querySelector('[data-status]');
    const results = dialog.querySelector('[data-results]');
    if (compact) {
        dialog.querySelector('[data-design-form]').hidden = true;
        dialog.querySelector('[data-action="close"]').hidden = true;
        dialog.className = 'voice-design-candidates';
        dialog.style.cssText = 'margin-top:12px';
    }
    let state = restoreGeminiAudition(audition, storageScope);
    if (!state.candidates.length && !state.last_error && lastGenerationError) state.last_error = lastGenerationError;
    if (window.isGeminiTtsEngine(state.engine)) field('engine').value = state.engine;
    const persist = (changed = true) => {
        // Opening a stale view is not a newer audition. Only user actions and
        // generation results should win over a saved project on restoration.
        if (changed) state.updated_at = Date.now();
        const copy = JSON.parse(JSON.stringify(state));
        onAuditionChange?.(copy);
        if (storageScope) {
            try { localStorage.setItem(geminiAuditionDraftKey(storageScope), JSON.stringify({scope: storageScope, state: copy})); }
            catch { status.textContent = 'Browser draft storage unavailable. Save your project to retain these candidates.'; }
        }
    };
    const auditionVoiceIds = new Set();
    const removedVoiceIds = new Set();
    let busy = false;
    let player = null;
    const controls = Array.from(dialog.querySelectorAll('input, textarea, select, [data-action]'));
    const setBusy = value => { busy = value; dialog.dataset.busy = String(value); controls.forEach(control => control.disabled = value); };
    const addVoice = (id, label) => {
        if (Array.from(results.children).some(row => row.dataset.id === id)) return;
        const row = document.createElement('div');
        row.dataset.id = id;
        row.className = 'gemini-voice-row';
        const title = document.createElement('span');
        title.className = 'gemini-voice-identity';
        title.textContent = label; title.title = id;
        row.append(title);
        const play = document.createElement('button');
        play.type = 'button'; play.className = 'btn btn-secondary'; play.textContent = '▶'; play.setAttribute('aria-label', `Play ${label}`);
        play.onclick = () => {
            if (!player) { player = document.createElement('audio'); player.controls = true; player.preload = 'none'; player.className = 'gemini-preview-player'; dialog.insertBefore(player, results); }
            player.hidden = false;
            player.src = `/api/gemini-tts/voices/${encodeURIComponent(id)}/preview`;
            player.play().catch(() => { status.textContent = 'Preview could not be played. Check that this voice still exists in your Google project.'; });
            player.onerror = () => { status.textContent = 'Preview unavailable. The voice may have expired or belong to another Google project.'; };
        };
        row.prepend(play);
        {
            const use = document.createElement('button');
            use.type = 'button'; use.className = 'btn btn-primary'; use.textContent = 'Use voice';
            use.onclick = async () => {
                if (busy) return;
                const siblings = geminiSiblingCandidates(id);
                setBusy(true);
                try {
                    // Assign first: if assignment fails, do not remove any candidates.
                    if (onSelect && await onSelect(id, label, state.engine || field('engine').value) === false) {
                        status.textContent = 'Engine switch cancelled. All candidates are still saved; select a Gemini narration engine to use them.';
                        return;
                    }
                    state.selected_id = id; persist();
                    // Selection is independent of cleanup consent. Cancelling deletion
                    // must not undo the user's chosen speaker voice.
                    if (siblings.length && !window.confirm(`Voice selected: "${label}". Permanently delete these other audition candidates from Google?\n\n${siblings.map(v => `${v.name} (${v.id})`).join('\n')}\n\nCancel keeps all candidates but does not undo your selection.`)) {
                        status.textContent = `Selected voice: ${label}. Other candidates were kept. Save the project to retain the assignment.`;
                        return;
                    }
                    status.textContent = 'Keeping selected voice and removing other audition candidates…';
                    const {deleted, failed} = await discardGeminiCandidates(id, siblings);
                    deleted.forEach(voiceId => { removedVoiceIds.add(voiceId); auditionVoiceIds.delete(voiceId); });
                    state.candidates = state.candidates.filter(v => !deleted.includes(v.id)); persist();
                    for (const [groupId, items] of Object.entries(geminiAuditionGroups)) {
                        if (!Array.isArray(items) || !items.some(v => v.id === id)) continue;
                        const remaining = items.filter(v => !deleted.includes(v.id));
                        if (remaining.length <= 1) delete geminiAuditionGroups[groupId];
                        else geminiAuditionGroups[groupId] = remaining;
                    }
                    saveGeminiAuditionGroups();
                    window.geminiTtsVoices = window.geminiTtsVoices.filter(v => !deleted.includes(v.short_name));
                    Array.from(results.children).filter(row => deleted.includes(row.dataset.id)).forEach(row => row.remove());
                    if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
                    await refresh();
                    if (onSelect) await onSelect(id, label);
                    if (failed.length) {
                        status.textContent = `Selected voice kept, but ${failed.length} candidate(s) could not be removed: ${failed.map(v => v.name + ': ' + v.error).join('; ')}. Click the selected voice again to retry cleanup.`;
                    } else if (container) {
                        status.textContent = `Selected voice: ${label}. ${deleted.length} unused candidate(s) deleted from Google. Save the project to retain the speaker assignment.`;
                        Array.from(results.children).filter(row => row.dataset.id !== id).forEach(row => row.remove());
                        results.hidden = true;
                        if (player) player.hidden = true;
                    } else dialog.close();
                } catch (error) { status.textContent = error.message; }
                finally { setBusy(false); }
            };
            row.append(use);
        }
        results.append(row);
    };
    const refresh = async () => {
        const data = await window.loadGeminiTtsCatalog(true);
        (data.voices || []).filter(v => v.designed && auditionVoiceIds.has(v.short_name) && !removedVoiceIds.has(v.short_name))
            .forEach(v => addVoice(v.short_name, v.display_name));
        return data;
    };
    dialog.querySelector('[data-action="refresh"]').onclick = async () => {
        setBusy(true);
        try { await refresh(); status.textContent = auditionVoiceIds.size
            ? 'Current audition refreshed. Other saved voices are available in the voice library.'
            : 'Generate candidates to begin this audition. Existing voices are in Voices → Gemini cloud voices.'; }
        finally { setBusy(false); }
    };
    dialog.querySelector('[data-action="create"]').onclick = async () => {
        if (busy) return;
        const input = getGenerationInputs?.();
        if (input) {
            field('name').value = input.name;
            field('description').value = input.description;
            field('count').value = input.count;
            field('engine').value = input.engine;
        }
        if (!field('name').value.trim() || !field('description').value.trim()) {
            status.textContent = 'Enter a name and voice description.'; return;
        }
        const count = Math.max(1, Math.min(4, parseInt(field('count').value, 10) || 1));
        if (state.candidates.length && !state.selected_id) {
            if (!window.confirm(`Discard these pending candidates permanently from Google and generate ${count} new candidate(s)? New generation is billable. Your previously assigned voice is not part of this audition and will be kept.\n\n${state.candidates.map(v => `${v.name} (${v.id})`).join('\n')}\n\nCancel keeps these candidates and makes no new requests.`)) return;
            setBusy(true);
            try {
                status.textContent = 'Discarding pending candidates before creating replacements…';
                const {deleted, failed} = await discardGeminiCandidates('', state.candidates);
                deleted.forEach(id => {removedVoiceIds.add(id); auditionVoiceIds.delete(id);});
                state.candidates = state.candidates.filter(v => !deleted.includes(v.id));
                if (state.group_id) {
                    if (state.candidates.length) geminiAuditionGroups[state.group_id] = state.candidates;
                    else delete geminiAuditionGroups[state.group_id];
                    saveGeminiAuditionGroups();
                }
                window.geminiTtsVoices = window.geminiTtsVoices.filter(v => !deleted.includes(v.short_name));
                Array.from(results.children).filter(row => deleted.includes(row.dataset.id)).forEach(row => row.remove());
                if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
                state.last_error = failed.length ? `Could not discard ${failed.length} candidate(s): ${failed.map(v => v.name + ': ' + v.error).join('; ')}. No new generation requests were sent. Try Generate Voice again to retry cleanup.` : '';
                persist();
                if (failed.length) {status.textContent = state.last_error; return;}
            } catch (error) {
                status.textContent = `Candidate cleanup failed: ${error.message}. No new generation requests were sent.`;
                return;
            } finally {setBusy(false);}
        }
        const groupId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        geminiAuditionGroups[groupId] = [];
        state = {group_id: groupId, candidates: [], selected_id: '', engine: field('engine').value}; persist();
        // A new attempt is a new audition, not an extension of the previous one.
        // Older voices remain hosted and manageable in the separate voice library.
        auditionVoiceIds.clear();
        results.replaceChildren();
        results.hidden = false;
        if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
        setBusy(true);
        try {
            status.textContent = `Creating ${count} candidates concurrently… Please leave this window open.`;
            const completed = [];
            const outcomes = await createGeminiCandidates(count, {name: field('name').value.trim(),
                description: field('description').value, engine: field('engine').value}, (data, index) => {
                completed[index] = data;
                state.candidates = completed.filter(Boolean);
                geminiAuditionGroups[groupId] = state.candidates;
                saveGeminiAuditionGroups();
                persist();
                auditionVoiceIds.add(data.id);
                results.replaceChildren();
                state.candidates.forEach(v => addVoice(v.id, v.name));
                // Keep newly created identities selectable even if a later catalog refresh fails.
                window.geminiTtsVoices.push({short_name: data.id, display_name: data.name, designed: true, locale: ''});
                status.textContent = `${state.candidates.length} of ${count} candidates saved. Remaining requests are still running…`;
            });
            await refresh();
            const failures = outcomes.filter(result => result.status === 'rejected');
            state.last_error = failures.length ? `${state.candidates.length} candidates saved; ${failures.length} request(s) failed: ${failures.map(result => result.reason.message).join('; ')}. No automatic retries were made.` : '';
            persist();
            status.textContent = `${state.candidates.length} candidates saved. Select your favorite; closing keeps pending candidates. Save the project to carry them with it.` +
                (failures.length ? ` ${failures.length} request(s) failed: ${failures.map(result => result.reason.message).join('; ')}. No automatic retries were made.` : '');
        } catch (error) {
            status.textContent = error.message + ' Any completed candidates remain saved; refresh before retrying.';
        } finally { setBusy(false); }
    };
    const dispose = () => {
        if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
        dialog.remove();
    };
    dialog.geminiDispose = dispose;
    dialog.geminiGenerate = () => dialog.querySelector('[data-action="create"]').onclick();
    dialog.querySelector('[data-action="close"]').textContent = container ? 'Hide voice designer' : 'Close';
    dialog.querySelector('[data-action="close"]').onclick = () => { if (!busy) { if (container) dispose(); else dialog.close(); } };
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', dispose);
    if (state.candidates.length) {
        if (state.group_id) { geminiAuditionGroups[state.group_id] = state.candidates; saveGeminiAuditionGroups(); }
        state.candidates.forEach(v => { auditionVoiceIds.add(v.id); addVoice(v.id, v.name); });
        results.hidden = !!state.selected_id && state.candidates.length === 1;
        persist(false);
        status.textContent = state.last_error || (state.selected_id ? 'Saved audition restored. Your selected voice is retained.' : `${state.candidates.length} Gemini candidates saved for review. Your current voice stays selected until you choose a replacement.`);
    } else if (compact) status.textContent = state.last_error || 'No Gemini candidates yet. Use Generate Voice above to create them (billable).';
    if (container) {
        container.append(dialog);
        if (reveal) dialog.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    } else {
        document.body.append(dialog);
        dialog.showModal();
    }
    return dialog;
};
