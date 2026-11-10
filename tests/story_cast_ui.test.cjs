const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/story-cast.js'), 'utf8');

function load(sessionPayload) {
    const listeners = {};
    const context = vm.createContext({
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        CSS: { escape: value => value },
        document: {
            readyState: 'complete',
            getElementById: () => null,
            querySelectorAll: () => [],
            addEventListener: (name, fn) => { listeners[name] = fn; },
        },
        fetch: async url => ({
            ok: true,
            status: 200,
            json: async () => ({ success: true, session: { ...sessionPayload, id: url.split('/').pop() } }),
        }),
    });
    context.window = context;
    vm.runInContext(source, context);
    return context;
}

function baseSession(overrides = {}) {
    return {
        status: 'idle', phase: 'review', questions: [], characters: [], materialized: { hash: 'x' },
        casting: {}, budget: { paid_requests: 0, limit: 200 }, counts: {}, narration: {}, examples: [], log: [],
        ...overrides,
    };
}

async function attached(overrides) {
    const context = load(baseSession(overrides));
    context.window.storyCast.onProjectLoaded({ story_cast_session_id: 'a'.repeat(32) });
    await new Promise(resolve => setImmediate(resolve));
    return context.window.storyCast;
}

test('pending Auto cast questions block audio generation', async () => {
    const storyCast = await attached({ status: 'waiting_user', questions: [{ id: 'q0001' }] });
    assert.match(storyCast.generationBlocker(), /Answer the 1 Auto cast question/);
});

test('applied Auto cast sessions request strict assignments', async () => {
    const storyCast = await attached();
    assert.equal(storyCast.generationBlocker(), '');
    const payload = storyCast.decorateGeneratePayload({ text: 'x' });
    assert.equal(payload.strict_assignments, true);
    assert.equal(payload.story_cast_session_id, 'a'.repeat(32));
});

test('sessions not yet applied to the manuscript do not change generation', async () => {
    const storyCast = await attached({ materialized: null, status: 'running' });
    assert.equal(storyCast.generationBlocker(), '');
    assert.deepEqual(storyCast.decorateGeneratePayload({ text: 'x' }), { text: 'x' });
});

test('story text is never rendered as HTML', () => {
    const assignments = source.match(/innerHTML\s*=\s*[^;]+;/g) || [];
    assert.ok(assignments.length > 0);
    assignments.forEach(statement => assert.match(statement, /innerHTML\s*=\s*''/));
    assert.doesNotMatch(source, /insertAdjacentHTML|outerHTML\s*=/);
});
