const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../debugger/worker.js'), 'utf8');

function harness() {
  const timers = new Map(), workers = [], revoked = [];
  let nextTimer = 0;
  class Worker {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage({ data }); }
  }
  const context = vm.createContext({ Worker, Blob, PYTHON_TRACE_SOURCE: 'engine',
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) },
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  const run = context.createPythonDebugRun({ code: 'code', input: '1', entry: 'f' }, () => {});
  return { run, worker: workers[0], timers, revoked };
}

test('worker loads engine then runs the exact snapshot and releases resources', async () => {
  const h = harness();
  assert.equal(h.worker.messages[0].type, 'load');
  h.worker.emit({ type: 'ready' });
  assert.equal(h.worker.messages[1].code, 'code');
  assert.equal([...h.timers.values()][0].ms, 8000);
  h.worker.emit({ type: 'result', result: { result: '2' } });
  assert.equal((await h.run.promise).result, '2');
  assert.equal(h.worker.terminated, true);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.revoked, ['blob:test']);
});

test('cancel terminates worker and ignores late results', async () => {
  const h = harness();
  h.run.cancel();
  h.worker.emit({ type: 'result', result: {} });
  await assert.rejects(h.run.promise, /已停止/);
  assert.equal(h.worker.terminated, true);
  assert.equal(h.timers.size, 0);
  h.run.cancel();
  assert.equal(h.revoked.length, 1);
});

test('both environment loading and execution have terminating deadlines', async () => {
  for (const ready of [false, true]) {
    const h = harness();
    if (ready) h.worker.emit({ type: 'ready' });
    const timer = [...h.timers.values()][0];
    assert.equal(timer.ms, ready ? 8000 : 90000);
    timer.fn();
    await assert.rejects(h.run.promise, ready ? /8 秒/ : /90 秒/);
    assert.equal(h.worker.terminated, true);
    assert.equal(h.revoked.length, 1);
  }
});
