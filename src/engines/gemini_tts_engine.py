"""Gemini 3.8 hosted speech: preset identity and separate delivery metadata."""
import base64
from dataclasses import replace
import logging
import re
import requests

from .base import EngineCapabilities
from .openai_tts_engine import OpenAITTSEngine
from .cloud_audio import apply_wav_effects
from ..audio_effects import VoiceFXSettings

logger = logging.getLogger(__name__)
GEMINI_TTS_MODELS = {
    "gemini_tts": "gemini-3.8-flash-tts",
    "gemini_tts_lite": "gemini-3.8-flash-lite-tts",
}
GEMINI_TTS_VOICES = (
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
)


class GeminiTTSError(RuntimeError):
    pass


def is_gemini_voice(value):
    return value in GEMINI_TTS_VOICES or bool(re.fullmatch(r'voice_[A-Za-z0-9_-]+', str(value or '')))


class GeminiVoiceLibrary:
    """Hosted identities only. Never retries a billable create after a timeout."""
    def __init__(self, api_key, request_func=requests.request):
        if not str(api_key or '').strip():
            raise GeminiTTSError('Save the dedicated Gemini TTS API key in Settings first.')
        self.key = api_key
        self.request = request_func

    def call(self, method, path='', **kwargs):
        try:
            response = self.request(method, 'https://generativelanguage.googleapis.com/v1beta/voices' + path,
                                    headers={'x-goog-api-key': self.key}, timeout=(10, 240 if method == 'POST' else 30),
                                    allow_redirects=False, **kwargs)
        except requests.RequestException:
            if method == 'DELETE':
                raise GeminiTTSError('Google voice deletion could not be confirmed. Refresh the voice list before retrying.') from None
            raise GeminiTTSError('Google voice request timed out or disconnected. Refresh the voice list before trying again; the voice may already have been created.') from None
        if method == 'DELETE' and (response.status_code == 404 or 200 <= response.status_code < 300):
            return {}  # Delete may return an empty body; missing means already removed.
        if not 200 <= response.status_code < 300:
            detail = ''
            try:
                error = response.json().get('error', {})
                if isinstance(error, dict) and isinstance(error.get('message'), str):
                    detail = ' '.join(error['message'].replace(self.key, '[redacted]').split())[:500]
            except (ValueError, AttributeError, TypeError):
                pass
            raise GeminiTTSError(f'Google voice request failed (HTTP {response.status_code}). ' +
                                 (detail or 'Check key permissions, quota, and the 200-voice project limit.'))
        return response.json()

    def list(self):
        voices, token, seen = [], '', set()
        while True:
            params = {'type': 'prompted'}
            if token:
                params['pageToken'] = token
            data = self.call('GET', params=params)
            voices.extend(data.get('voices') or [])
            token = data.get('nextPageToken') or data.get('next_page_token') or ''
            if not token or token in seen:
                return voices
            seen.add(token)

    def create(self, name, description, engine_name='gemini_tts'):
        name, description = str(name or '').strip(), str(description or '').strip()
        if not name or not description:
            raise ValueError('A voice name and voice description are required.')
        if engine_name not in GEMINI_TTS_MODELS:
            raise ValueError('Select a supported Gemini TTS model.')
        return self.call('POST', json={'store': True, 'voice': {
            'model': GEMINI_TTS_MODELS[engine_name], 'type': 'prompted',
            'display_name': name, 'prompted': {'input': description}}})

    def get(self, voice_id):
        if not re.fullmatch(r'voice_[A-Za-z0-9_-]+', str(voice_id or '')):
            raise ValueError('Invalid Google voice ID.')
        return self.call('GET', '/' + voice_id)

    def delete(self, voice_id):
        if not re.fullmatch(r'voice_[A-Za-z0-9_-]+', str(voice_id or '')):
            raise ValueError('Invalid Google designed voice ID.')
        return self.call('DELETE', '/' + voice_id)


class GeminiTTSEngine(OpenAITTSEngine):
    name = "gemini_tts"
    capabilities = EngineCapabilities(False, True, None)

    def __init__(self, api_key="", *, engine_name="gemini_tts", **kwargs):
        if not str(api_key or "").strip():
            raise GeminiTTSError("Configure an API key in Settings → Gemini TTS.")
        kwargs.setdefault('default_voice', 'Kore')
        super().__init__(api_key, model_id=GEMINI_TTS_MODELS[engine_name], **kwargs)
        self.name = engine_name

    @property
    def headers(self):
        return {"x-goog-api-key": self.api_key, "Content-Type": "application/json"}

    def _work_items(self, segments, voice_config):
        items = super()._work_items(segments, voice_config)
        for item in items:
            segment = segments[item["segment_index"]]
            direction = segment.get("delivery_instruction", segment.get("emotion"))
            if direction is not None:
                item["assignment"] = replace(item["assignment"], extra={
                    **item["assignment"].extra, "delivery_instruction": direction})
        return items

    def _synthesize(self, text, assignment, *, fallback_speed):
        text = str(text or "").strip()
        if not text or "[direction]" in text.lower() or "[/direction]" in text.lower():
            raise GeminiTTSError("Empty text or unparsed direction tags reached Gemini TTS.")
        voice = assignment.voice or self.default_voice
        if not is_gemini_voice(voice):
            raise GeminiTTSError("Select a Google preset or designed voice. Local voice samples are not supported by Gemini TTS.")
        extra = assignment.extra or {}
        # Never prepend the permanent speaker profile: Google anchors identity
        # to the selected preset. An explicit empty direction clears the default.
        style = str(extra.get("delivery_instruction", extra.get("instructions", self.instructions)) or "").strip()
        part = {"text": text}
        if style:
            part["speech_metadata"] = {"style": style}
        payload = {"contents": [{"role": "user", "parts": [part]}],
                   "generationConfig": {"responseModalities": ["AUDIO"],
                                        "speechConfig": {"voiceConfig": {"voice": voice}}}}
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model_id}:generateContent"
        for attempt in range(self.max_retries + 1):
            try:
                response = self._request("POST", url, headers=self.headers, json=payload, timeout=(10, self.timeout), allow_redirects=False)
            except requests.RequestException as exc:
                raise GeminiTTSError("Gemini TTS connection failed. The request may have been billed; automatic retry was stopped.") from exc
            if response.status_code == 429 and attempt < self.max_retries:
                try:
                    delay = float(response.headers.get("Retry-After", 2 ** attempt))
                except (ValueError, TypeError):
                    delay = 2 ** attempt
                self._sleep(max(0, min(delay, 60)))
                continue
            if not 200 <= response.status_code < 300:
                try:
                    detail = str(response.json().get("error", {}).get("message", ""))
                except (ValueError, AttributeError):
                    detail = ""
                raise GeminiTTSError(f"Gemini TTS HTTP {response.status_code}: {detail.replace(self.api_key, '[redacted]')[:300]}")
            break
        try:
            data = response.json()
            candidate = (data.get("candidates") or [{}])[0]
            if candidate.get("finishReason") not in (None, "STOP"):
                raise GeminiTTSError(f"Gemini TTS did not finish successfully: {candidate.get('finishReason')}")
            audio_parts = [p["inlineData"] for p in candidate.get("content", {}).get("parts", []) if "inlineData" in p]
            if len(audio_parts) != 1:
                raise GeminiTTSError("Gemini TTS returned no usable single audio result (possibly blocked).")
            audio = audio_parts[0]
            raw = base64.b64decode(audio["data"], validate=True)
            if audio.get("mimeType", "").split(';')[0] not in ("audio/wav", "audio/x-wav") or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
                raise GeminiTTSError("Gemini TTS returned an unexpected audio format; expected WAV.")
            wav = self._audio_converter(raw, input_format="wav", sample_rate=None, channels=1)
        except (KeyError, ValueError, TypeError) as exc:
            raise GeminiTTSError("Gemini TTS returned invalid audio data.") from exc
        logger.info("Gemini TTS completed model=%s voice=%s usage=%s", self.model_id, voice, data.get("usageMetadata", {}))
        original = VoiceFXSettings.from_payload(assignment.fx_payload)
        speed = self._clamp(assignment.speed_override if assignment.speed_override is not None else fallback_speed, .25, 4, 1)
        fx = VoiceFXSettings(pitch_semitones=original.pitch_semitones if original else 0,
                             tone=original.tone if original else "neutral", speed=speed)
        return apply_wav_effects(wav, None if fx.is_identity() else fx)
