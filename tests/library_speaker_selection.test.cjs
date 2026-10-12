const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/library.js'), 'utf8');
test('speaker defaults use chunk assignments and distinguish mixed recordings', () => {
    const context = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function reviewSpeakerSelections('), source.indexOf('function bindLibrarySpeakerPreview(')), context);
    const records = context.reviewSpeakerSelections([
        {speaker: 'actor', engine: 'gemini_tts', voice_assignment: {voice: 'voice_a'}, voice_label: 'Actor A'},
        {speaker: 'actor', engine: 'gemini_tts', voice_assignment: {voice: 'voice_a'}},
        {speaker: 'mixed', engine: 'breeze_tts_2', voice_assignment: {audio_prompt_path: 'actor.wav'}},
        {speaker: 'mixed', engine: 'gemini_tts', voice_assignment: {voice: 'voice_b'}},
    ], 'kokoro');
    assert.equal(records.get('actor').engines.size, 1);
    assert.equal(records.get('actor').voices.size, 1);
    assert.equal(records.get('mixed').engines.size, 2);
    assert.equal(records.get('mixed').voices.size, 2);
    assert.equal(records.get('mixed').voices.get('actor.wav').isPrompt, true);
});
