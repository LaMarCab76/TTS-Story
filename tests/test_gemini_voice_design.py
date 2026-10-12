from unittest.mock import Mock
from types import SimpleNamespace

import pytest
import requests

from src.engines.gemini_tts_engine import GeminiVoiceLibrary, GeminiTTSError, GeminiTTSEngine, GEMINI_TTS_MODELS
from test_gemini_tts_engine import response


def reply(data, status=200):
    return SimpleNamespace(status_code=status, json=lambda: data)


@pytest.mark.parametrize('model', GEMINI_TTS_MODELS)
def test_design_uses_dedicated_key_and_hosted_identity(model):
    request = Mock(return_value=reply({'id': 'voice_abc'}))
    result = GeminiVoiceLibrary('tts-key', request).create('Actor', 'Warm alto.', model)
    assert result['id'] == 'voice_abc'
    args, kw = request.call_args
    assert args == ('POST', 'https://generativelanguage.googleapis.com/v1beta/voices')
    assert kw['headers'] == {'x-goog-api-key': 'tts-key'}
    assert kw['json'] == {'store': True, 'voice': {'model': GEMINI_TTS_MODELS[model],
        'type': 'prompted', 'display_name': 'Actor', 'prompted': {'input': 'Warm alto.'}}}
    assert kw['allow_redirects'] is False


def test_list_paginates_without_fetching_audio():
    request = Mock(side_effect=[reply({'voices': [{'id': 'voice_a'}], 'nextPageToken': 'next'}),
                                reply({'voices': [{'id': 'voice_b'}]})])
    voices = GeminiVoiceLibrary('key', request).list()
    assert [v['id'] for v in voices] == ['voice_a', 'voice_b']
    assert request.call_args.kwargs['params']['pageToken'] == 'next'


def test_create_does_not_repeat_after_ambiguous_failure():
    request = Mock(side_effect=requests.Timeout('secret-detail'))
    with pytest.raises(GeminiTTSError, match='may already have been created') as exc:
        GeminiVoiceLibrary('key', request).create('Actor', 'Warm alto.')
    assert 'secret-detail' not in str(exc.value)
    assert request.call_count == 1


def test_voice_failure_exposes_google_reason_but_redacts_key():
    request = Mock(return_value=reply({'error': {'message': 'Invalid prompt: secret-key'}}, 400))
    with pytest.raises(GeminiTTSError, match='Invalid prompt:') as exc:
        GeminiVoiceLibrary('secret-key', request).create('Actor', 'Warm alto.')
    assert 'secret-key' not in str(exc.value)
    assert '[redacted]' in str(exc.value)
    assert request.call_count == 1


@pytest.mark.parametrize('voice', ['../private', 'Kore', 'voice_../../secret'])
def test_preview_rejects_invalid_paths(voice):
    request = Mock()
    with pytest.raises(ValueError):
        GeminiVoiceLibrary('key', request).get(voice)
    request.assert_not_called()


@pytest.mark.parametrize('status', [200, 204, 404])
def test_delete_handles_empty_or_already_removed_voice(status):
    request = Mock(return_value=SimpleNamespace(status_code=status,
        json=Mock(side_effect=ValueError('No JSON body'))))
    assert GeminiVoiceLibrary('key', request).delete('voice_unused') == {}
    assert request.call_args.args == ('DELETE', 'https://generativelanguage.googleapis.com/v1beta/voices/voice_unused')
    request.return_value.json.assert_not_called()


@pytest.mark.parametrize('voice', ['Kore', '../private', 'voice_../../file'])
def test_delete_rejects_presets_and_invalid_paths(voice):
    request = Mock()
    with pytest.raises(ValueError):
        GeminiVoiceLibrary('key', request).delete(voice)
    request.assert_not_called()


@pytest.mark.parametrize('model', GEMINI_TTS_MODELS)
def test_designed_voice_sent_to_both_synthesis_models(model, tmp_path):
    request = Mock(return_value=response())
    engine = GeminiTTSEngine('key', engine_name=model, request_func=request, audio_converter=lambda raw, **kw: raw)
    engine.generate_batch([{'speaker': 'actor', 'chunks': ['Hello.'], 'delivery_instruction': 'Quietly.'}],
                          {'actor': {'voice': 'voice_designed123'}}, tmp_path)
    payload = request.call_args.kwargs['json']
    assert payload['generationConfig']['speechConfig']['voiceConfig']['voice'] == 'voice_designed123'
    assert payload['contents'][0]['parts'][0]['speech_metadata']['style'] == 'Quietly.'
