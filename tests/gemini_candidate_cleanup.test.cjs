const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'static/js/gemini-tts.js'), 'utf8');
const helpers = source.slice(source.indexOf('const geminiAuditionStorageKey'), source.indexOf('// Kept separate from local sample creation'));

test('audition refresh never adds narrator or other previously saved voices', async () => {
    const added = [];
    const voices = [
        {short_name: 'voice_narrator', display_name: 'Narrator', designed: true},
        {short_name: 'voice_a', display_name: 'Actor A', designed: true},
        {short_name: 'voice_b', display_name: 'Actor B', designed: true},
        {short_name: 'Kore', display_name: 'Kore'}
    ];
    const ids = new Set(['voice_a', 'voice_b']);
    const context = vm.createContext({window: {loadGeminiTtsCatalog: async () => ({voices})},
        auditionVoiceIds: ids, removedVoiceIds: new Set(), addVoice: id => added.push(id)});
    vm.runInContext(source.slice(source.indexOf('    const refresh = async () => {'),
        source.indexOf("    dialog.querySelector('[data-action=\"refresh\"]').onclick")) + '\n globalThis.refreshAudition = refresh;', context);
    await context.refreshAudition();
    assert.deepEqual(added, ['voice_a', 'voice_b']);
    added.length = 0;
    ids.clear();
    await context.refreshAudition();
    assert.deepEqual(added, []);
    assert.match(source, /auditionVoiceIds\.clear\(\);\s*results\.replaceChildren\(\)/);
    assert.match(source, /auditionVoiceIds\.add\(data.id\);\s*results\.replaceChildren\(\);\s*state.candidates.forEach/);
});

test('voice manager filters custom hosted voices without exposing presets for deletion', () => {
    const context = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function geminiManagedVoices('), source.indexOf('let geminiManagerDeleting')), context);
    const voices = [{short_name: 'Kore', display_name: 'Kore'},
        {short_name: 'voice_a', display_name: 'Alice', designed: true},
        {short_name: 'voice_b', display_name: 'Bob', designed: true},
        {short_name: '../invalid', display_name: 'Invalid', designed: true}];
    assert.equal(context.geminiManagedVoices(voices).length, 2);
    assert.equal(context.geminiManagedVoices(voices, 'ALICE')[0].short_name, 'voice_a');
    assert.equal(context.geminiManagedVoices(voices, 'voice_b')[0].display_name, 'Bob');
    assert.equal(context.geminiManagedVoices(voices, 'Kore').length, 0);
});

test('cleanup targets only siblings in the recorded audition, including after reload', () => {
    const context = vm.createContext({localStorage: {getItem: () => JSON.stringify({
        first: [{id: 'voice_keep'}, {id: 'voice_discard'}],
        unrelated: [{id: 'voice_other'}, {id: 'voice_other2'}]
    })}});
    vm.runInContext(helpers, context);
    assert.equal(JSON.stringify(context.geminiSiblingCandidates('voice_keep')), JSON.stringify([{id: 'voice_discard'}]));
    assert.equal(context.geminiSiblingCandidates('voice_legacy_unknown').length, 0);
});

test('selected voice is protected; failed deletion remains visible for retry', async () => {
    const calls = [];
    const context = vm.createContext({localStorage: {getItem: () => '{}'}, fetch: async (url, options) => {
        calls.push(url);
        assert.equal(options.method, 'DELETE');
        assert.equal(JSON.parse(options.body).confirm, true);
        const success = url.endsWith('voice_removed');
        return {ok: success, json: async () => ({success, error: 'quota'})};
    }});
    vm.runInContext(helpers, context);
    const result = await context.discardGeminiCandidates('voice_keep', [{id: 'voice_keep'}, {id: 'voice_removed'}, {id: 'voice_failed'}]);
    assert.equal(calls.length, 2);
    assert.equal(result.deleted[0], 'voice_removed');
    assert.equal(result.failed[0].id, 'voice_failed');
});

test('stale backend deletion route gives restart instruction, not JSON parse error', async () => {
    const context = vm.createContext({localStorage: {getItem: () => '{}'}, fetch: async () => ({status: 404})});
    vm.runInContext(helpers, context);
    const result = await context.discardGeminiCandidates('voice_keep', [{id: 'voice_other'}]);
    assert.equal(result.deleted.length, 0);
    assert.match(result.failed[0].error, /Restart TTS-Story/);
});

test('candidate selection happens before discard confirmation and is reapplied after refresh', () => {
    const start = source.indexOf('use.onclick = async () =>');
    const body = source.slice(start, source.indexOf('row.append(use)', start));
    assert.ok(body.indexOf('await onSelect(id, label,') >= 0);
    assert.ok(body.indexOf('await onSelect(id, label,') < body.indexOf('window.confirm'));
    assert.match(body, /await refresh\(\);\s*if \(onSelect\) await onSelect\(id, label\)/);
});

test('four independent creation requests start before any finishes; partial failures keep successes', async () => {
    const requests = [], received = [];
    const context = vm.createContext({localStorage: {getItem: () => '{}'}, fetch: (url, options) => new Promise(resolve => {
        requests.push({payload: JSON.parse(options.body), resolve});
    })});
    vm.runInContext(helpers, context);
    const pending = context.createGeminiCandidates(4, {name: 'Actor', description: 'Warm', engine: 'gemini_tts'},
        (candidate, index) => received.push({candidate, index}));
    assert.equal(requests.length, 4, 'all four requests must be in flight together');
    requests[2].resolve({ok: true, json: async () => ({success: true, id: 'voice_c'})});
    await new Promise(resolve => setImmediate(resolve));
    requests[0].resolve({ok: true, json: async () => ({success: true, id: 'voice_a'})});
    requests[1].resolve({ok: false, json: async () => ({success: false, error: 'rate limit'})});
    requests[3].resolve({ok: true, json: async () => ({success: true, id: 'voice_d'})});
    const outcomes = await pending;
    assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 3);
    assert.equal(received.length, 3);
    assert.deepEqual(received.map(v => v.index), [2, 0, 3]);
    assert.equal(received[0].candidate.name, 'Actor — Candidate C');
    assert.equal(requests.length, 4, 'no automatic billable retries');
});

test('pending audition restores from project or newer browser draft and remains speaker-scoped', () => {
    const storage = new Map();
    const context = vm.createContext({localStorage: {getItem: key => storage.get(key)}});
    vm.runInContext(helpers, context);
    const project = {updated_at: 1, group_id: 'g', candidates: [{id: 'voice_a', name: 'A'}, {id: 'voice_b', name: 'B'}]};
    assert.equal(context.restoreGeminiAudition(project, 'project1/actor').candidates.length, 2);
    storage.set(context.geminiAuditionDraftKey('project1/actor'), JSON.stringify({scope: 'project1/actor', state: {...project, updated_at: 2, selected_id: 'voice_a'}}));
    assert.equal(context.restoreGeminiAudition(project, 'project1/actor').selected_id, 'voice_a');
    assert.equal(context.restoreGeminiAudition(null, 'project1/narrator').candidates.length, 0);
    assert.equal(context.restoreGeminiAudition(null, 'project2/actor').candidates.length, 0);
    assert.equal(context.restoreGeminiAudition({...project, updated_at: 3}, 'project1/actor').selected_id, undefined);
});

test('speaker profile hydration and edits retain audition metadata for project serialization', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'static/js/main.js'), 'utf8');
    const profiles = {};
    const context = vm.createContext({speakerProfiles: profiles, normalizeSpeakerKey: v => v,
        normalizeVoiceDesignEngine: v => v, buildLocalVoiceDesignPrompt: (_, __, v) => v});
    vm.runInContext(main.slice(main.indexOf('function setSpeakerProfiles('), main.indexOf('function findGeneratedSpeakerProfile(')), context);
    const audition = {group_id: 'g', candidates: [{id: 'voice_a', name: 'A'}, {id: 'voice_b', name: 'B'}]};
    context.setSpeakerProfiles({actor: {name: 'actor', gemini_voice_audition: audition}});
    context.updateSpeakerProfileEntry('actor', {voice: 'Squeaky'});
    const saved = JSON.parse(JSON.stringify(profiles));
    context.setSpeakerProfiles(saved);
    assert.deepEqual(JSON.parse(JSON.stringify(profiles.actor.gemini_voice_audition)), audition);
});
