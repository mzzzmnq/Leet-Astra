const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { installConversation } = require('./conversation-harness.cjs');

const source = fs.readFileSync(path.join(__dirname, '../openleet.user.js'), 'utf8');
const reader = source.slice(source.indexOf('  function readLanguageLabel()'), source.indexOf('  function currentSlug()'));
function setup(api, nodes = []) {
  const listeners = {};
  const context = vm.createContext({
    PAGE: { monaco: { editor: api, EditorOption: { readOnly: 1 } } },
    document: {
      addEventListener: (name, fn) => { listeners[name] = fn; },
      querySelector: () => null,
      querySelectorAll: () => nodes,
    },
  });
  vm.runInContext(reader, context);
  return { context, read: () => context.readCode(), focus: (node) => listeners.focusin({ target: { closest: () => node } }) };
}
const model = (value) => ({ getValue: () => value, getLanguageId: () => 'cpp' });
const node = (visible = true, lines = []) => ({
  isConnected: true,
  getClientRects: () => visible ? [{}] : [],
  querySelectorAll: () => lines.map(textContent => ({ textContent })),
});
const editor = (dom, getModel, extra = {}) => ({ getDomNode: () => dom, getModel, ...extra });

test('repeated reads use edited code, shorter code, and intentional empty code', () => {
  let value = 'initial code';
  const active = { ...model(''), getValue: () => value };
  const stale = model('old code that is much longer than the active editor');
  const dom = node();
  const { read } = setup({ getEditors: () => [editor(dom, () => active)], getModels: () => [stale, active] });
  assert.equal(read().code, value);
  value = 'new';
  assert.equal(read().code, 'new');
  value = '';
  assert.equal(read().code, '');
  assert.equal(read().codeIncomplete, false);
});

test('model replacement and hidden/disposed editors do not return previous code', () => {
  let active = model('first');
  const dom = node();
  const { read } = setup({ getEditors: () => [
    { getDomNode: () => { throw Error('disposed'); } },
    editor(node(false), () => model('hidden')),
    editor(dom, () => active),
  ] });
  assert.equal(read().code, 'first');
  active = model('replacement');
  assert.equal(read().code, 'replacement');
});

test('last focused editor remains selected after clicking the panel', () => {
  const first = node(), second = node();
  const { read, focus } = setup({ getEditors: () => [
    editor(first, () => model('first')),
    editor(second, () => model('second')),
  ] });
  focus(second);
  assert.equal(read().code, 'second');
});

test('read-only comparison editor is skipped', () => {
  const { read } = setup({ getEditors: () => [
    editor(node(), () => model('original'), { getOption: () => true }),
    editor(node(), () => model('modified'), { getOption: () => false }),
  ] });
  assert.equal(read().code, 'modified');
});

test('single-model compatibility path reads changes and ignores disposed models', () => {
  let value = 'first';
  const { read } = setup({ getModels: () => [
    { ...model('disposed'), isDisposed: () => true },
    { ...model(''), getValue: () => value },
  ] });
  assert.equal(read().code, 'first');
  value = 'second';
  assert.equal(read().code, 'second');
});

test('ambiguous models do not select longest code; DOM fallback is marked incomplete', () => {
  const dom = node(true, ['new\u00a0code']);
  const { read } = setup({ getModels: () => [model('old long code'), model('new')] }, [dom]);
  assert.equal(read().code, 'new code');
  assert.equal(read().codeSource, 'dom');
  assert.equal(read().codeIncomplete, true);
});

test('DOM fallback does not merge different editors and stays fresh', () => {
  const lines = ['first'];
  const first = node(true, lines), second = node(true, ['other']);
  const { read, focus } = setup({}, [first, second]);
  assert.equal(read().codeSource, 'unavailable');
  focus(first);
  assert.equal(read().code, 'first');
  lines[0] = 'changed';
  assert.equal(read().code, 'changed');
});

test('each chat request receives the latest code through readProblem and buildSystem', async () => {
  let value = 'FIRST_VERSION';
  const { context } = setup({ getModels: () => [{ ...model(''), getValue: () => value }] });
  const requests = [];
  Object.assign(context, {
    IS_DEMO: false, location: { hostname: 'leetcode.com', pathname: '/problems/two-sum/', href: 'https://leetcode.com/problems/two-sum/' },
    store: { get: () => null, set: () => true }, clearTimeout, setTimeout,
    chatStatusEl: {}, problemEl: {}, codeStatusEl: {}, resetMessages: () => {}, renderCodeChip: () => {},
    readTitle: () => 'Two Sum', readDifficulty: () => 'Easy', readTags: () => [], readDescription: () => 'Description',
    BASE_SYSTEM: 'Assistant', SKILLS: { hint: { system: 'Hint' } }, cfg: { mode: 'hint', model: 'test', includeCode: true },
    busy: false, history: [], inputEl: { value: 'Explain' }, sendBtn: {}, stopReplyBtn: {},
    addMessage: () => {}, renderProblemChip: () => {}, setStatus: () => {},
    addAssistant: () => ({ done() {}, text: () => 'Reply', fail: (message) => assert.fail(message) }),
    directChat: async (payload) => { requests.push(payload); },
  });
  vm.runInContext(source.slice(source.indexOf('  function currentSlug()'), source.indexOf('  /* ------------------------------------------------------------- upstream API */')), context);
  installConversation(context);
  vm.runInContext(source.slice(source.indexOf('  function buildSystem('), source.indexOf('  /* ---------------------------------------------------------- LeetNote export */')), context);
  context.syncConversation(true);
  context.inputEl.value = 'Explain';
  await context.onSend();
  value = 'SECOND_VERSION';
  context.inputEl.value = 'Explain again';
  await context.onSend();
  assert.match(requests[0].messages[0].content, /FIRST_VERSION/);
  assert.match(requests[1].messages[0].content, /SECOND_VERSION/);
  assert.doesNotMatch(requests[1].messages[0].content, /FIRST_VERSION/);
  value = '';
  context.inputEl.value = 'Now empty';
  await context.onSend();
  assert.doesNotMatch(requests[2].messages[0].content, /FIRST_VERSION|SECOND_VERSION/);
  assert.match(requests[2].messages[0].content, /当前编辑器代码为空/);
});
