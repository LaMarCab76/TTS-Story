const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/library.js'), 'utf8');

test('chunk engine menus initialize once on pointer or keyboard interaction', () => {
    const context = vm.createContext({});
    const start = source.indexOf('function initializeReviewCardOnDemand(');
    vm.runInContext(source.slice(start, source.indexOf('function deferLibraryVoiceOptions(', start)), context);
    const handlers = {};
    const card = { addEventListener: (name, fn) => handlers[name] = fn, removeEventListener: name => delete handlers[name] };
    let calls = 0;
    context.initializeReviewCardOnDemand(card, () => calls++);
    assert.equal(calls, 0);
    const pointer = handlers.pointerdown;
    handlers.focusin();
    pointer();
    assert.equal(calls, 1);
    assert.equal(Object.keys(handlers).length, 0);
});

test('voice options do no work until interaction and populate once', async () => {
    const context = vm.createContext({ console });
    const start = source.indexOf('function deferLibraryVoiceOptions(');
    vm.runInContext(source.slice(start, source.indexOf('async function populateLibraryVoiceSelects(', start)), context);
    const events = {};
    const select = { dataset: {}, addEventListener: (name, fn) => { events[name] = fn; } };
    let calls = 0;
    context.deferLibraryVoiceOptions(select, async () => { calls++; });
    assert.equal(calls, 0);
    await events.focus();
    await events.pointerenter();
    assert.equal(calls, 1);
    context.deferLibraryVoiceOptions(select, async () => { calls += 2; });
    await events.focus();
    assert.equal(calls, 3);
});

test('large library renders only one page and search covers every page', () => {
    const controls = {};
    const navigation = { querySelector: key => controls[key] ||= {} };
    let rendered;
    const context = vm.createContext({ document: { getElementById: () => navigation }, renderLibraryPage: items => { rendered = items; } });
    const start = source.indexOf('const LIBRARY_PAGE_SIZE');
    vm.runInContext(source.slice(start, source.indexOf('function renderLibraryPage(', start)), context);
    const items = Array.from({ length: 285 }, (_, i) => ({ title: `Book ${i}` }));
    context.displayLibraryItems(items);
    assert.equal(rendered.length, 20);
    vm.runInContext('libraryBrowsePage = 14', context);
    context.displayLibraryItems(items, true);
    assert.equal(rendered.length, 5);
    assert.equal(rendered[0].title, 'Book 280');
    vm.runInContext("libraryBrowseQuery = 'Book 284'", context);
    context.displayLibraryItems(items);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].title, 'Book 284');
});
