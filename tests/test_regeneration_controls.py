import app as module


def test_cancel_skips_queued_work_and_allows_new_work(monkeypatch):
    pending = []
    rendered = []
    monkeypatch.setattr(module, 'jobs', {'test': {'regen_tasks': {}}})
    monkeypatch.setattr(module, 'chunk_regen_controls', {})
    monkeypatch.setattr(module.chunk_regen_executor, 'submit', lambda task: pending.append(task))
    monkeypatch.setattr(module, '_perform_chunk_regeneration', lambda *a, **kw: rendered.append(a))
    monkeypatch.setattr(module, '_update_regen_status', lambda *a, **kw: None)
    module._schedule_chunk_regeneration('test', 'one', 'Hello')
    client = module.app.test_client()
    assert client.post('/api/library/test/regeneration-control', json={'action': 'pause'}).get_json()['paused']
    assert client.get('/api/library/test/regeneration-control').get_json()['paused']
    assert not client.post('/api/library/test/regeneration-control', json={'action': 'resume'}).get_json()['paused']
    response = client.post('/api/library/test/regeneration-control', json={'action': 'cancel'})
    assert response.status_code == 200
    assert module.jobs['test']['regen_tasks']['one']['status'] == 'failed'
    pending.pop(0)()
    assert rendered == []
    module._schedule_chunk_regeneration('test', 'two', 'Again')
    pending.pop(0)()
    assert len(rendered) == 1
    assert client.post('/api/library/test/regeneration-control', json={'action': 'invalid'}).status_code == 400


def test_cancel_keeps_running_chunk(monkeypatch):
    monkeypatch.setattr(module, 'jobs', {'test': {'regen_tasks': {'one': {'status': 'running'}, 'two': {'status': 'queued'}}}})
    monkeypatch.setattr(module, 'chunk_regen_controls', {})
    response = module.app.test_client().post('/api/library/test/regeneration-control', json={'action': 'cancel'})
    assert response.status_code == 200
    assert module.jobs['test']['regen_tasks']['one']['status'] == 'running'
    assert module.jobs['test']['regen_tasks']['two']['status'] == 'failed'
