const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../static/js/main.js'), 'utf8');
const gemini = fs.readFileSync(path.join(__dirname, '../static/js/gemini-tts.js'), 'utf8');
function setup(fail = false) {
    const profiles = {narrator: {voice: 'Warm and clear', voice_candidate_count: 2}, actor: {voice_design_prompt: 'Squeaky', voice_candidate_count: 4}};
    const calls = [], storage = new Map();
    const context = vm.createContext({window: {geminiTtsVoices: []}, activeProjectId: 'book', bulkVoiceGenerationState: {gemini_model: 'gemini_tts_lite'},
        findSpeakerProfile: name => ({profile: profiles[name]}), normalizeSpeakerKey: v => v,
        updateSpeakerProfileEntry: (name, values) => Object.assign(profiles[name], values),
        localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
        fetch: async (url, options) => {
            const request = JSON.parse(options.body); calls.push(request); const id = 'voice_' + calls.length;
            const ok = !(fail && request.name.endsWith('Candidate B'));
            return {ok, json: async () => ({success: ok, id, name: request.name, error: 'rate limit'})};
        }});
    vm.runInContext(gemini.slice(gemini.indexOf('const geminiAuditionStorageKey'), gemini.indexOf('// Kept separate from local sample creation')), context);
    vm.runInContext(main.slice(main.indexOf('async function generateGeminiSpeakerBatch('), main.indexOf('function bulkVoiceSpeakerSignature(')), context);
    return {context, profiles, calls, storage};
}
test('Gemini model controls are hidden and disabled for local engines on initial load and switches', () => {
    const engine = {value: 'qwen3', addEventListener: (_, fn) => {engine.change = fn;}};
    const options = {}, model = {}, count = {value: '8'};
    const elements = {'speaker-batch-gemini-options': options, 'speaker-batch-gemini-model': model, 'speaker-batch-candidate-count': count};
    const context = vm.createContext({batchDesignEngineSelect: engine, document: {getElementById: id => elements[id]}});
    const start = main.indexOf('    const updateBatchGeminiControls =');
    vm.runInContext(main.slice(start, main.indexOf('    const batchStatus', start)), context);
    assert.equal(options.hidden, true); assert.equal(model.disabled, true);
    engine.value = 'gemini'; engine.change();
    assert.equal(options.hidden, false); assert.equal(model.disabled, false); assert.equal(count.max, '4');
    engine.value = 'breeze'; engine.change();
    assert.equal(options.hidden, true); assert.equal(model.disabled, true); assert.equal(count.max, '10');
    const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
    assert.match(html, /id="speaker-batch-gemini-options" hidden/);
});
test('bulk Gemini creates isolated hosted auditions using the requested model and per-speaker description', async () => {
    const {context, profiles, calls, storage} = setup();
    await context.generateGeminiSpeakerBatch('narrator', 'Book narrator', {});
    await context.generateGeminiSpeakerBatch('actor', 'Book actor', {});
    assert.equal(calls.length, 6);
    assert.ok(calls.every(v => v.engine === 'gemini_tts_lite'));
    assert.equal(calls[0].description, 'Warm and clear');
    assert.equal(calls[2].description, 'Squeaky');
    assert.equal(profiles.narrator.gemini_voice_audition.candidates.length, 2);
    assert.equal(profiles.actor.gemini_voice_audition.candidates.length, 4);
    assert.equal(profiles.actor.voice_design_engine, 'gemini');
    assert.equal(profiles.actor.gemini_voice_audition.selected_id, '');
    assert.notEqual(profiles.actor.gemini_voice_audition.group_id, profiles.narrator.gemini_voice_audition.group_id);
    assert.ok([...storage.keys()].some(key => key.startsWith('ttsStory.geminiPending')));
    await context.generateGeminiSpeakerBatch('actor', 'Book actor', {});
    assert.equal(calls.length, 6, 'resume/start-over must not rebill an existing audition');
});
test('partial Gemini bulk failures retain completed candidates and never call local save APIs', async () => {
    const {context, profiles, calls} = setup(true);
    await assert.rejects(context.generateGeminiSpeakerBatch('narrator', 'Narrator', {}), /1\/2 candidates saved/);
    assert.equal(profiles.narrator.gemini_voice_audition.candidates.length, 1);
    assert.match(profiles.narrator.gemini_voice_audition.last_error, /rate limit/);
    assert.equal(calls.length, 2);
    await context.generateGeminiSpeakerBatch('narrator', 'Narrator', {});
    assert.equal(calls.length, 2);
});

test('the next cloud speaker starts while the preceding checkpoint is still saving', async () => {
    const processed = [];
    let release;
    const context = vm.createContext({currentStats: {speakers: ['first', 'second']}, bulkVoiceGenerationState: null,
        window: {loadGeminiTtsCatalog: async () => ({success: true})},
        document: {getElementById: () => ({value: '2'})}, hasResumableBulkVoiceGeneration: () => false,
        normalizeVoiceDesignEngine: v => v, bulkVoiceSpeakerSignature: v => v.join('|'), buildBatchVoiceName: (_, v) => v,
        persistBulkVoiceGenerationState: () => context.bulkVoiceGenerationState.next_index === 1
            ? new Promise(resolve => {release = resolve;}) : Promise.resolve(),
        generateSpeakerVoicePromptBatch: async speaker => {processed.push(speaker); return {success: true};},
        getVoiceDesignEngineConfig: () => ({label: 'Gemini'}), showNotification() {}});
    vm.runInContext(main.slice(main.indexOf('async function runBatchVoiceGeneration('), main.indexOf('function buildBatchVoiceName(')), context);
    const run = context.runBatchVoiceGeneration('', {}, {}, {}, {designEngine: 'gemini'});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(processed, ['first', 'second']);
    assert.equal(typeof release, 'function');
    release();
    await run;
    assert.equal(context.bulkVoiceGenerationState.status, 'completed');
});
test('Gemini preflight checks the dedicated cloud key rather than local engine health', async () => {
    let data = {success: true, design_available: true};
    const context = vm.createContext({normalizeVoiceDesignEngine: v => v, window: {loadGeminiTtsCatalog: async () => data}});
    const start = main.indexOf('async function requireVoiceDesignBackend(');
    const end = main.indexOf('    const engineConfig', start);
    vm.runInContext(main.slice(start, end) + '\n}', context);
    await context.requireVoiceDesignBackend('gemini');
    data = {success: true, design_available: false};
    await assert.rejects(context.requireVoiceDesignBackend('gemini'), /dedicated Gemini TTS API key/);
});

test('bulk pause/resume checkpoints speakers and preserves the Gemini model without local voice refreshes', async () => {
    const processed = [], checkpoints = [];
    const context = vm.createContext({currentStats: {speakers: ['narrator', 'actor']}, bulkVoiceGenerationState: null,
        window: {loadGeminiTtsCatalog: async () => ({success: true})},
        document: {getElementById: id => ({value: id === 'speaker-batch-gemini-model' ? 'gemini_tts_lite' : '2'})},
        hasResumableBulkVoiceGeneration: () => context.bulkVoiceGenerationState?.status === 'paused',
        normalizeVoiceDesignEngine: v => v, bulkVoiceSpeakerSignature: v => v.join('|'),
        buildBatchVoiceName: (_, speaker) => speaker,
        persistBulkVoiceGenerationState: async () => checkpoints.push(JSON.parse(JSON.stringify(context.bulkVoiceGenerationState))),
        generateSpeakerVoicePromptBatch: async (speaker, _, __, engine) => {assert.equal(engine, 'gemini'); processed.push(speaker); return {success: true};},
        getVoiceDesignEngineConfig: () => ({label: 'Gemini'}), showNotification() {},
        refreshChatterboxVoices: () => {throw Error('Cloud casting must not use local sample refresh');}});
    vm.runInContext(main.slice(main.indexOf('async function runBatchVoiceGeneration('), main.indexOf('function buildBatchVoiceName(')), context);
    const paused = await context.runBatchVoiceGeneration('', {}, {}, {}, {designEngine: 'gemini', shouldPause: () => true});
    assert.equal(paused.paused, true);
    assert.equal(context.bulkVoiceGenerationState.next_index, 1);
    assert.equal(context.bulkVoiceGenerationState.gemini_model, 'gemini_tts_lite');
    context.document.getElementById = () => ({value: 'gemini_tts'});
    await context.runBatchVoiceGeneration('', {}, {}, {}, {designEngine: 'gemini', resume: true});
    assert.deepEqual(processed, ['narrator', 'actor']);
    assert.equal(context.bulkVoiceGenerationState.gemini_model, 'gemini_tts_lite');
    assert.equal(checkpoints.at(-1).status, 'completed');
});
