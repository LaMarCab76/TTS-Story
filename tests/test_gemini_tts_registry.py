"""Exercise route validation without starting a backend or making paid requests."""
import ast
from contextlib import nullcontext
import logging
from pathlib import Path

from flask import Flask
import pytest

from src.engines.gemini_tts_engine import GEMINI_TTS_MODELS
from src.tts_engine import AVAILABLE_ENGINES, get_engine


@pytest.mark.parametrize('name', GEMINI_TTS_MODELS)
def test_gemini_registered_and_factory_preserves_model(name):
    assert name in AVAILABLE_ENGINES
    engine = get_engine(name, api_key='test-only')
    assert engine.name == name
    assert engine.model_id == GEMINI_TTS_MODELS[name]


@pytest.mark.parametrize('name', GEMINI_TTS_MODELS)
def test_analyze_accepts_gemini(name):
    from flask import request, jsonify
    source = Path(__file__).resolve().parents[1] / 'app.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    route = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'analyze_text')
    app = Flask(__name__)

    class Processor:
        def get_statistics(self, text):
            return {'test_text': text}

    def processor(engine, chunk_size, config):
        assert engine == name
        return Processor()

    scope = dict(app=app, request=request, jsonify=jsonify,
                 log_request_timing=lambda *args: nullcontext(),
                 load_config=lambda: {'tts_engine': 'kokoro', 'chunk_size': 500},
                 _normalize_engine_name=lambda value: value.strip().lower(),
                 AVAILABLE_ENGINES=AVAILABLE_ENGINES,
                 _create_text_processor_for_engine=processor,
                 split_text_into_book_sections=lambda *args: {},
                 logger=logging.getLogger(__name__))
    exec(compile(ast.Module(body=[route], type_ignores=[]), str(source), 'exec'), scope)
    response = app.test_client().post('/api/analyze', json={
        'tts_engine': name, 'text': '[narrator]Hello.[/narrator]'})
    assert response.status_code == 200, response.json
    assert response.json['success'] is True
