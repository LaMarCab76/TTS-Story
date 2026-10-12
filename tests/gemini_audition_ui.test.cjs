const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/gemini-tts.js'), 'utf8');

// Small DOM double: exercise handlers and remounts without a server or paid API calls.
class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.value = ''; this.fields = {}; }
    set innerHTML(html) {
        for (const match of html.matchAll(/data-(field|action)="([^"]+)"/g)) this.fields[`[data-${match[1]}="${match[2]}"]`] = new Element();
        this.fields['[data-status]'] = new Element(); this.fields['[data-results]'] = new Element();
        this.fields['[data-design-form]'] = new Element();
    }
    querySelector(selector) { return this.fields[selector] || this.children.find(v => selector === '[data-gemini-inline-designer]' && v.dataset.geminiInlineDesigner) || null; }
    querySelectorAll() { return Object.values(this.fields); }
    append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); }
    prepend(node) { node.parent = this; this.children.unshift(node); }
    insertBefore(node) { this.append(node); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(v => v !== this); }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    addEventListener() {}
    scrollIntoView() {}
    pause() {}
    load() {}
    play() { return Promise.resolve(); }
}
function harness(storage = new Map()) {
    const created = [], requests = [], elements = {};
    const window = {confirm: () => true};
    const context = vm.createContext({window, console, localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
        getSelectedJobEngine: () => 'gemini_tts', document: {addEventListener() {}, getElementById: id => elements[id], querySelectorAll: () => [],
            createElement: tag => { created.push(tag); return new Element(tag); }},
        fetch: async (url, options) => {
            requests.push({url, options});
            const number = requests.length;
            if (options.method === 'DELETE') return {ok: true, json: async () => ({success: true})};
            return {ok: true, json: async () => ({success: true, id: 'voice_' + number, name: JSON.parse(options.body).name})};
        }});
    vm.runInContext(source, context);
    window.loadGeminiTtsCatalog = async () => ({success: true, voices: window.geminiTtsVoices});
    return {window, context, created, requests, storage, elements};
}
test('closing, reopening, project reload and candidate selection retain the correct audition', async () => {
    const h = harness();
    let profile = null, selected;
    const container = new Element();
    const options = {container, name: 'Actor', description: 'Squeaky', candidateCount: 2, storageScope: 'project/actor',
        onAuditionChange: value => { profile = value; }, onSelect: id => { selected = id; }};
    h.window.openGeminiVoiceDesigner(options);
    let dialog = container.children[0];
    await dialog.querySelector('[data-action="create"]').onclick();
    assert.equal(profile.candidates.length, 2);
    assert.equal(h.created.filter(tag => tag === 'audio').length, 0, 'no eager media players');
    dialog.geminiDispose();
    h.window.openGeminiVoiceDesigner({...options, audition: JSON.parse(JSON.stringify(profile))});
    dialog = container.children[0];
    assert.equal(dialog.querySelector('[data-results]').children.length, 2);
    h.window.confirm = () => false;
    await dialog.querySelector('[data-action="create"]').onclick();
    assert.equal(h.requests.length, 2, 'unselected candidates cannot be silently replaced');
    h.window.confirm = () => true;
    const reloaded = harness(h.storage);
    const other = new Element();
    reloaded.window.openGeminiVoiceDesigner({...options, container: other, audition: null});
    assert.equal(other.children[0].querySelector('[data-results]').children.length, 2, 'browser draft survives reload');
    const rows = dialog.querySelector('[data-results]').children;
    rows[0].children.find(v => v.textContent === '▶').onclick();
    await rows[0].children.find(v => v.textContent === 'Use voice').onclick();
    assert.equal(selected, 'voice_1');
    assert.equal(profile.candidates.length, 1);
    assert.equal(profile.selected_id, 'voice_1');
    assert.equal(dialog.querySelector('[data-results]').hidden, true);
    assert.equal(dialog.children.find(v => v.tag === 'audio').hidden, true);
    assert.equal(h.requests.filter(r => r.options.method === 'DELETE').length, 1);
    dialog.geminiDispose();
    h.window.openGeminiVoiceDesigner({...options, audition: profile});
    assert.equal(container.children[0].querySelector('[data-results]').children.length, 1);
});

test('confirmed regeneration discards only pending candidates before sending new requests', async () => {
    const h = harness();
    let saved;
    h.window.geminiTtsVoices = [{short_name: 'voice_approved', designed: true}];
    const dialog = h.window.openGeminiVoiceDesigner({container: new Element(), name: 'Actor', description: 'Warm', candidateCount: 2,
        audition: {group_id: 'old', selected_id: '', candidates: [{id: 'voice_old_a'}, {id: 'voice_old_b'}]},
        onAuditionChange: value => {saved = value;}});
    await dialog.geminiGenerate();
    assert.deepEqual(h.requests.map(r => r.options.method), ['DELETE', 'DELETE', 'POST', 'POST']);
    assert.equal(saved.candidates.length, 2);
    assert.equal(saved.selected_id, '');
    assert.ok(h.window.geminiTtsVoices.some(v => v.short_name === 'voice_approved'));
    assert.ok(h.requests.every(r => !r.url.includes('voice_approved')));
});

test('partial discard failure retains failed candidate and does not bill for replacements', async () => {
    const h = harness();
    let saved;
    h.context.fetch = async (url, options) => {
        h.requests.push({url, options});
        return {ok: url.endsWith('voice_a'), json: async () => ({success: url.endsWith('voice_a'), error: 'Unavailable'})};
    };
    const dialog = h.window.openGeminiVoiceDesigner({container: new Element(), name: 'Actor', description: 'Warm', candidateCount: 2,
        audition: {candidates: [{id: 'voice_a'}, {id: 'voice_b'}]}, onAuditionChange: value => {saved = value;}});
    await dialog.geminiGenerate();
    assert.deepEqual(h.requests.map(r => r.options.method), ['DELETE', 'DELETE']);
    assert.equal(saved.candidates.length, 1);
    assert.equal(saved.candidates[0].id, 'voice_b');
    assert.match(dialog.querySelector('[data-status]').textContent, /No new generation requests/);
    assert.equal(dialog.dataset.busy, 'false');
});

test('declining the narration-engine switch does not approve or delete candidates', async () => {
    const h = harness();
    const container = new Element();
    let profile;
    h.window.openGeminiVoiceDesigner({container, name: 'Actor', description: 'Warm', candidateCount: 2,
        onAuditionChange: value => {profile = value;}, onSelect: async () => false});
    const dialog = container.children[0];
    await dialog.querySelector('[data-action="create"]').onclick();
    await dialog.querySelector('[data-results]').children[0].children.find(v => v.textContent === 'Use voice').onclick();
    assert.equal(profile.selected_id, '');
    assert.equal(profile.candidates.length, 2);
    assert.equal(h.requests.filter(r => r.options.method === 'DELETE').length, 0);
    assert.match(dialog.querySelector('[data-status]').textContent, /cancelled/);
});

test('bulk-generated candidates render immediately in compact speaker review without a second form', async () => {
    const h = harness();
    const main = fs.readFileSync(path.join(__dirname, '../static/js/main.js'), 'utf8');
    const profile = {voice: 'Warm', voice_candidate_count: 2,
        selected_voice_id: 'voice_approved', selected_voice_name: 'Approved voice',
        gemini_voice_audition: {selected_id: 'voice_approved', candidates: [{id: 'voice_approved', name: 'Approved voice'}]}};
    Object.assign(h.context, {activeProjectId: 'book', bulkVoiceGenerationState: {gemini_model: 'gemini_tts_lite'},
        findSpeakerProfile: () => ({profile}), normalizeSpeakerKey: v => v,
        updateSpeakerProfileEntry: (_, update) => Object.assign(profile, update)});
    vm.runInContext(main.slice(main.indexOf('async function generateGeminiSpeakerBatch('), main.indexOf('function bulkVoiceSpeakerSignature(')), h.context);
    await h.context.generateGeminiSpeakerBatch('actor', 'Book Actor', {});
    const container = new Element();
    const dialog = h.window.openGeminiVoiceDesigner({container, compact: true, reveal: false, audition: profile.gemini_voice_audition});
    assert.equal(dialog.querySelector('[data-results]').children.length, 2);
    assert.equal(dialog.querySelector('[data-results]').hidden, false);
    assert.equal(profile.selected_voice_id, 'voice_approved', 'new choices must not replace the approved voice');
    assert.equal(profile.gemini_voice_audition.selected_id, '');
    assert.equal(h.requests.filter(r => r.options.method === 'DELETE').length, 0);
    assert.equal(dialog.querySelector('[data-design-form]').hidden, true);
    assert.equal(dialog.querySelector('[data-action="close"]').hidden, true);
    assert.equal(h.created.filter(tag => tag === 'audio').length, 0);
});

test('compact Generate Voice uses shared speaker fields and shows saved batch errors', async () => {
    const h = harness();
    const dialog = h.window.openGeminiVoiceDesigner({container: new Element(), compact: true,
        audition: {last_error: 'Google HTTP 500: no candidates created.'},
        getGenerationInputs: () => ({name: 'Actor', description: 'Shared voice prompt', count: 2, engine: 'gemini_tts_lite'})});
    assert.match(dialog.querySelector('[data-status]').textContent, /HTTP 500/);
    await dialog.geminiGenerate();
    assert.equal(h.requests.length, 2);
    assert.equal(JSON.parse(h.requests[0].options.body).description, 'Shared voice prompt');
    assert.equal(JSON.parse(h.requests[0].options.body).engine, 'gemini_tts_lite');
});

test('empty audition displays the batch failure and opening review does not make stale data newer', () => {
    const h = harness();
    const failed = h.window.openGeminiVoiceDesigner({container: new Element(), compact: true,
        audition: {candidates: []}, lastGenerationError: 'Google HTTP 400: rejected prompt'});
    assert.match(failed.querySelector('[data-status]').textContent, /HTTP 400/);
    let saved;
    h.window.openGeminiVoiceDesigner({container: new Element(), compact: true,
        audition: {updated_at: 123, candidates: [{id: 'voice_pending', name: 'Pending'}]},
        onAuditionChange: value => {saved = value;}});
    assert.equal(saved.updated_at, 123);
});

test('library select-visible and bulk deletion exclude presets and preserve failed candidates', async () => {
    const h = harness();
    for (const id of ['gemini-voices-manager-list', 'gemini-voices-manager-status', 'gemini-voices-manager-player', 'gemini-voices-filter']) h.elements[id] = new Element();
    h.window.geminiTtsVoices = [{short_name: 'Kore', display_name: 'Kore'},
        {short_name: 'voice_a', display_name: 'Actor A', designed: true}, {short_name: 'voice_b', display_name: 'Actor B', designed: true},
        {short_name: 'voice_n', display_name: 'Narrator', designed: true}];
    h.elements['gemini-voices-filter'].value = 'Actor';
    h.window.renderGeminiVoiceManager();
    const list = h.elements['gemini-voices-manager-list'];
    list.children[0].children.find(v => v.textContent === 'Select visible').onclick();
    h.context.fetch = async (url, options) => {
        h.requests.push({url, options});
        const success = url.endsWith('voice_a');
        return {ok: success, json: async () => ({success, error: 'busy'})};
    };
    await list.children[0].children.find(v => v.textContent === 'Delete selected (2)').onclick();
    assert.deepEqual(h.requests.map(v => v.url), ['/api/gemini-tts/voices/voice_a', '/api/gemini-tts/voices/voice_b']);
    assert.ok(h.window.geminiTtsVoices.some(v => v.short_name === 'voice_n'));
    assert.ok(h.window.geminiTtsVoices.some(v => v.short_name === 'Kore'));
    assert.ok(list.children[0].children.some(v => v.textContent === 'Delete selected (1)'));
    assert.match(h.elements['gemini-voices-manager-status'].textContent, /Failed: Actor B/);
    const restored = h.context.restoreGeminiAudition({candidates: [{id: 'voice_a'}, {id: 'voice_b'}]}, 'project/actor');
    assert.equal(restored.candidates.length, 1, 'deleted voices do not return from old saved auditions');
});
