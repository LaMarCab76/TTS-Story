const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/main.js'), 'utf8');

for (const status of [200, 404, 405]) {
    test(`project loader supports backend response ${status} without parsing HTML errors`, async () => {
        const project = { id: 'book', text: 'Story', speaker_profiles: { narrator: {} } };
        const calls = [];
        const context = vm.createContext({ fetch: async url => {
            calls.push(url);
            if (url === '/api/projects') return { ok: true, json: async () => ({ success: true, projects: [project] }) };
            return { status, ok: status === 200, json: async () => {
                assert.equal(status, 200, 'HTML error pages must not be parsed as JSON');
                return { success: true, project };
            } };
        } });
        const start = source.indexOf('async function fetchSavedProject(');
        vm.runInContext(source.slice(start, source.indexOf('async function saveProject(', start)), context);
        assert.equal(await context.fetchSavedProject('book'), project);
        assert.equal(calls.length, status === 200 ? 1 : 2);
    });
}

test('library defers audio sources until interaction and releases replaced players', () => {
    const library = fs.readFileSync(require('node:path').join(__dirname, '../static/js/library.js'), 'utf8');
    assert.match(library, /<audio controls preload="none" id="player-/);
    assert.match(library, /if \(isCollapsed\) ensurePlayerSource\(\)/);
    assert.match(library, /\/\/ Start playing\s+ensurePlayerSource\(\)/);
    assert.match(library, /player\.removeAttribute\('src'\);\s+player\.load\(\)/);
    const setup = library.slice(library.indexOf('const player = itemCard.querySelector'), library.indexOf('const summaryHeader = itemCard.querySelector'));
    assert.doesNotMatch(setup, /player\.load\(\)/);
    assert.match(setup, /const ensurePlayerSource = \(\) =>/);
});

function fixture() {
    let scans = 0;
    const voices = Array.from({ length: 1000 }, (_, i) => ({ name: `Voice ${i}`, prompt_path: `${i}.wav`, transcript: 'Hello.', duration_seconds: 12 }));
    const context = vm.createContext({
        turboSelectionState: {}, availableChatterboxVoices: voices,
        document: { createElement: () => ({ dataset: {}, style: {} }) },
        getSelectedJobEngine: () => 'breeze_tts_2', getMinDurationForEngine: () => 0,
        voiceDropdownFilters: {}, getLanguageDisplayName: x => x,
        CSS: { escape: x => x }, window: {},
    });
    const filter = voices.filter.bind(voices);
    voices.filter = (...args) => { scans++; return filter(...args); };
    const start = source.indexOf('function setReferenceSelectValue(');
    const end = source.indexOf('function updateVoiceDropdownFilterOptions(', start);
    vm.runInContext(source.slice(start, end), context);
    function select(speaker) {
        return {
            dataset: { speaker }, options: [], hiddenRow: true, _value: '',
            get value() { return this._value; },
            set value(v) { this._value = this.options.some(o => o.value === v) ? v : ''; },
            set innerHTML(v) { this.options = []; this._value = ''; },
            appendChild(option) { this.options.push(option); },
            closest() { return this.hiddenRow ? {} : null; },
            querySelector(query) { return this.options.find(o => query === `option[value="${o.value}"]`); },
        };
    }
    return { context, select, scans: () => scans };
}

test('66 hidden speakers keep assignments without cloning or scanning a 1000-voice catalog', () => {
    const { context, select, scans } = fixture();
    for (let i = 0; i < 66; i++) {
        const s = select(`speaker-${i}`);
        context.turboSelectionState[s.dataset.speaker] = `${i}.wav`;
        context.populateReferenceDropdown(s);
        assert.equal(s.options.length, 2);
        assert.equal(s.value, `${i}.wav`);
        context.setReferenceSelectValue(s, '999.wav');
        assert.equal(s.value, '999.wav');
    }
    assert.equal(scans(), 0);
});

test('opening loads the full library and closing releases it without losing the selection', () => {
    const { context, select, scans } = fixture();
    const s = select('narrator');
    context.turboSelectionState.narrator = '5.wav';
    context.populateReferenceDropdown(s);
    s.hiddenRow = false;
    context.populateReferenceDropdown(s);
    assert.equal(s.options.length, 1001);
    assert.equal(s.value, '5.wav');
    assert.equal(scans(), 1);
    context.turboSelectionState.narrator = '25.wav';
    s.hiddenRow = true;
    context.populateReferenceDropdown(s);
    assert.equal(s.options.length, 2);
    assert.equal(s.value, '25.wav');
});

test('candidate audio waits for playback and speaker opening avoids global repopulation', () => {
    assert.match(source, /<audio controls preload="none" src="\$\{candidate.audio_base64/);
    const open = source.slice(source.indexOf('function openSpeakerEditModal('), source.indexOf('function closeSpeakerEditModal('));
    assert.doesNotMatch(open, /populateReferenceSelects\(/);
    assert.match(open, /syncSpeakerReferenceAssignment\(speaker\)/);
});
