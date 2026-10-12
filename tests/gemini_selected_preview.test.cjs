const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/main.js'), 'utf8');

test('selected custom voice plays lazily, toggles stop, and supports changed selections', async () => {
    const select = {value: 'voice_saved'}, button = {};
    const row = {querySelector: s => s === '.voice-select' ? select : button};
    const audio = [], notices = [];
    const context = vm.createContext({window: {geminiTtsVoices: [{short_name: 'voice_saved', designed: true}, {short_name: 'voice_new', designed: true}]},
        localAIVoiceReferenceToPromptPath: () => '', findChatterboxVoiceByPath: () => null, availableChatterboxVoices: [],
        getSelectedJobEngine: () => 'gemini_tts', currentFxPreviewAudio: null, currentFxPreviewButton: null,
        showNotification: text => notices.push(text),
        Audio: class { constructor(src) {this.src = src; audio.push(this);} play() {return Promise.resolve();} },
        stopSpeakerPreviewAudio: () => {context.currentFxPreviewAudio = null; context.currentFxPreviewButton = null; button.textContent = 'Play';}});
    vm.runInContext(source.slice(source.indexOf('function selectedVoicePreviewUrl('), source.indexOf('function openSpeakerEditModal(')), context);
    context.updateGeminiSelectedVoicePreview(row);
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
    assert.equal(audio.length, 0);
    await button.onclick();
    assert.equal(audio[0].src, '/api/gemini-tts/voices/voice_saved/preview');
    assert.equal(button.textContent, 'Stop');
    await button.onclick();
    assert.equal(button.textContent, 'Play');
    assert.equal(audio.length, 1);
    select.value = 'voice_new';
    context.updateGeminiSelectedVoicePreview(row);
    await button.onclick();
    assert.equal(audio[1].src, '/api/gemini-tts/voices/voice_new/preview');
    audio[1].onerror();
    assert.equal(button.textContent, 'Play');
    assert.equal(notices.length, 1);
    select.value = 'Kore';
    context.updateGeminiSelectedVoicePreview(row);
    assert.equal(button.disabled, true);
    context.getSelectedJobEngine = () => 'breeze_tts_2';
    context.updateGeminiSelectedVoicePreview(row);
    assert.equal(button.hidden, false);
    select.value = 'voice_saved';
    context.updateGeminiSelectedVoicePreview(row);
    assert.equal(button.disabled, false, 'saved preview is independent of narration engine');
    context.availableChatterboxVoices.push({id: 'local_saved'});
    select.value = 'local_saved';
    assert.equal(context.selectedVoicePreviewUrl(select), '/api/chatterbox-voices/local_saved/preview');
    context.findChatterboxVoiceByPath = v => v === 'sample.wav' ? {id: 'sample'} : null;
    context.localAIVoiceReferenceToPromptPath = v => v === 'tts-story://voice-prompts/sample.wav' ? 'sample.wav' : '';
    select.value = 'tts-story://voice-prompts/sample.wav';
    assert.equal(context.selectedVoicePreviewUrl(select), '/api/chatterbox-voices/sample/preview');
    select.value = 'hosted';
    select.selectedOptions = [{dataset: {previewUrl: 'https://example.com/sample.mp3'}}];
    assert.equal(context.selectedVoicePreviewUrl(select), 'https://example.com/sample.mp3');
    select.selectedOptions[0].dataset.previewUrl = 'javascript:alert(1)';
    assert.equal(context.selectedVoicePreviewUrl(select), '');
});
