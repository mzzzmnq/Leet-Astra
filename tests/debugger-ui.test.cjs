const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../debugger/ui.js'), 'utf8');
class Element {
  constructor() { this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
  set innerHTML(text) { this.controls = Object.fromEntries([...text.matchAll(/data-debug="([^"]+)"/g)].map(m => [m[1], new Element()])); }
  querySelector(selector) { return this.controls[selector.match(/"([^"]+)"/)[1]]; }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  focus() {}
  emit(name) { return this.listeners[name]?.(); }
}
function harness(saved = []) {
  const panel = new Element(), open = new Element();
  let persisted, payload, result = { events: [], result: '1', comparison: { status: 'pass', message: '结果符合预期。' } };
  const context = vm.createContext({
    document: { createElement: () => new Element(), createTextNode: text => ({ textContent: text }) },
    panel, addStyle() {}, location: { hostname: 'example.test', pathname: '/problems/demo/' }, currentSlug: () => 'demo',
    store: { get: () => saved, set: (key, value) => { persisted = value; } },
    readCode: () => ({ code: 'def solve():\n    return 1', lang: 'python' }), readDebugTestCases: () => [],
    createPythonDebugRun: value => { payload = value; return { promise: Promise.resolve(result), cancel() {} }; },
    $: () => open, restorePanelPosition() {}, panelVisibility: { finish() {} }, window: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/motion.js'), 'utf8'), context);
  vm.runInContext(source, context);
  context.installPythonDebugger(); open.emit('click');
  return { context, controls: panel.children[0].controls, saved: () => persisted, payload: () => payload, result: value => { result = value; } };
}
const event = (frameId, locals) => ({ frameId, locals, line: 1, function: 'solve', depth: 1, event: 'before' });

test('variable changes use previous event of same frame, including backward and recursive navigation', () => {
  const { context } = harness();
  const events = [event(1, { a: '1', removed: 'old' }), event(2, { a: '900' }), event(1, { a: '2', added: '[1]' }), event(1, { a: '3' })];
  const changes = index => JSON.parse(JSON.stringify(context.debugVariableChanges(events, index)));
  assert.equal(changes(0).first, true);
  assert.equal(changes(0).rows[0].kind, 'initial');
  assert.equal(changes(1).first, true);
  assert.equal(changes(3).rows[0].before, '2');
  assert.deepEqual(changes(2).rows.map(row => row.kind), ['changed', 'added', 'removed']);
  assert.equal(changes(2).rows[0].before, '1');
  assert.equal(context.debugVariableChanges([event(undefined, { a: '1' }), event(undefined, { a: '2' })], 1).first, true);
});

test('expected output defaults for legacy cases, persists and follows case switching', () => {
  const h = harness([{ name: 'old', input: '1' }, { name: 'new', input: '2', expected: '3' }]);
  const c = h.controls;
  assert.equal(c.expected.value, '');
  c.expected.value = '2'; c.expected.emit('input');
  assert.equal(h.saved()[0].expected, '2');
  c.case.value = '1'; c.case.emit('change');
  assert.equal(c.expected.value, '3');
  c.case.value = '0'; c.case.emit('change');
  assert.equal(c.expected.value, '2');
  c.expected.value = 'x'.repeat(16001); c.expected.emit('input');
  assert.equal(h.saved()[0].expected.length, 16000);
});

test('run sends expected output and renders each explicit comparison status', async () => {
  const h = harness();
  h.controls.expected.value = '1';
  for (const [status, label] of Object.entries({ pass: '通过', fail: '失败', skip: '未比较', error: '无法比较' })) {
    h.result({ events: [], result: '1', comparison: { status, message: '比较说明' } });
    await h.controls.run.emit('click');
    assert.equal(h.payload().expected, '1');
    assert.match(h.controls.result.textContent, new RegExp(label + '：比较说明'));
  }
  h.controls.expected.value = 'x'.repeat(16001);
  await h.controls.run.emit('click');
  assert.match(h.controls.status.textContent, /16,000/);
});

test('rendered variables distinguish initial, added, changed and deleted values', async () => {
  const h = harness();
  h.result({ result: '2', events: [event(1, { x: '1', old: '0' }), event(1, { x: '2', next: '3' })] });
  await h.controls.run.emit('click');
  assert.match(h.controls.position.textContent, /首次状态/);
  h.controls.next.emit('click');
  assert.deepEqual(h.controls.vars.children.map(row => row.children[1].textContent), ['1 → 2', '新增：3', '删除：0']);
  h.controls.prev.emit('click');
  assert.match(h.controls.position.textContent, /首次状态/);
});

test('worker supplies expected text as a separate Python global', async () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '../debugger/worker.js'), 'utf8');
  const globals = new Map(); let command;
  const context = vm.createContext({ self: { postMessage() {}, fetch: async () => ({ok:true,text:async()=>""}), importScripts() {} }, URL: {createObjectURL:()=>"blob:test",revokeObjectURL(){}}, Blob, importScripts() {}, loadPyodide: async () => ({ globals, runPython: code => { command = code; return '{}'; } }) });
  vm.runInContext(workerSource, context); context.pythonDebugWorker();
  await context.self.onmessage({ data: { type: 'load', engine: 'setup' } });
  await context.self.onmessage({ data: { type: 'run', code: 'code', input: '1', entry: 'solve', expected: '[2]' } });
  assert.equal(globals.get('_oc_expected'), '[2]');
  assert.match(command, /trace_code\(_oc_code, _oc_case, _oc_entry, _oc_expected\)/);
});
