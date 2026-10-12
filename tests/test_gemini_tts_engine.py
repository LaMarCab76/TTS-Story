import base64
import io
import wave
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from src.engines.gemini_tts_engine import GeminiTTSEngine, GeminiTTSError, GEMINI_TTS_MODELS


def audio():
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        stream.writeframes(b'\0\0' * 2400)
    return buf.getvalue()


def response(status=200, finish='STOP', raw=None):
    return SimpleNamespace(status_code=status, headers={}, json=lambda: {
        'candidates': [{'finishReason': finish, 'content': {'parts': [{'inlineData': {
            'mimeType': 'audio/wav', 'data': base64.b64encode(audio() if raw is None else raw).decode()}}]}}]})


@pytest.mark.parametrize('name', GEMINI_TTS_MODELS)
def test_models_separate_style_and_identity(name, tmp_path):
    request = Mock(return_value=response())
    engine = GeminiTTSEngine('tts-only-secret', engine_name=name, request_func=request,
                            audio_converter=lambda raw, **kw: raw)
    paths = engine.generate_batch([{'speaker': 'alice', 'chunks': ['Hello.'], 'delivery_instruction': 'Whisper urgently.'}],
        {'alice': {'voice': 'Leda', 'extra': {'speaker_profile': {'voice': 'High squeaky voice'}}}}, tmp_path)
    assert len(paths) == 1
    args, kw = request.call_args
    assert GEMINI_TTS_MODELS[name] in args[1]
    assert kw['headers']['x-goog-api-key'] == 'tts-only-secret'
    assert kw['allow_redirects'] is False
    assert kw['json']['contents'][0]['parts'] == [{'text': 'Hello.', 'speech_metadata': {'style': 'Whisper urgently.'}}]
    assert kw['json']['generationConfig']['speechConfig']['voiceConfig'] == {'voice': 'Leda'}


@pytest.mark.parametrize('voice', ['local.wav', 'voice_../../file', 'af_heart'])
def test_rejects_non_google_presets(voice):
    request = Mock()
    engine = GeminiTTSEngine('key', request_func=request)
    with pytest.raises(GeminiTTSError, match='preset'):
        engine.generate_audio('Hello', voice=voice)
    request.assert_not_called()


def test_requires_separate_key():
    with pytest.raises(GeminiTTSError, match='API key'):
        GeminiTTSEngine('')


@pytest.mark.parametrize('text', ['', '[direction]Happy[/direction]Hello'])
def test_never_speaks_unparsed_directions(text):
    engine = GeminiTTSEngine('key', request_func=Mock())
    with pytest.raises(GeminiTTSError):
        engine.generate_audio(text)
    engine._request.assert_not_called()


def test_rate_limit_retries_but_connection_failure_does_not():
    request = Mock(side_effect=[response(429), response()])
    engine = GeminiTTSEngine('key', request_func=request, sleep_func=Mock(), audio_converter=lambda raw, **kw: raw)
    assert engine.generate_audio('Hello')[:4] == b'RIFF'
    assert request.call_count == 2
    request.reset_mock(side_effect=True)
    request.side_effect = requests.Timeout()
    with pytest.raises(GeminiTTSError, match='may have been billed'):
        engine.generate_audio('Hello')
    assert request.call_count == 1


@pytest.mark.parametrize('reply', [response(finish='MAX_TOKENS'), response(raw=b'broken'), response(403)])
def test_bad_responses_do_not_save_audio(reply, tmp_path):
    engine = GeminiTTSEngine('key', request_func=Mock(return_value=reply))
    with pytest.raises(GeminiTTSError):
        engine.generate_batch([{'speaker': 'a', 'chunks': ['Hello']}], {}, tmp_path)
    assert not list(tmp_path.iterdir())


def test_empty_direction_clears_default():
    request = Mock(return_value=response())
    engine = GeminiTTSEngine('key', instructions='Cheerful', request_func=request, audio_converter=lambda raw, **kw: raw)
    engine.generate_audio('Hello', voice_options={'delivery_instruction': ''})
    assert request.call_args.kwargs['json']['contents'][0]['parts'] == [{'text': 'Hello'}]
