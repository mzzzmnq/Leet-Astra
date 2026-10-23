const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');

function trace(code, input = '', entry = '', expected_text = '') {
  const script = `import json,runpy,sys\nm=runpy.run_path(sys.argv[1])\np=json.load(sys.stdin)\nprint(json.dumps(m['trace_code'](**p)))`;
  const executable = process.env.PYTHON || (fs.existsSync(bundledPython) ? bundledPython : (process.platform === 'win32' ? 'py' : 'python3'));
  const args = [...(executable === 'py' ? ['-3'] : []), '-c', script, path.join(__dirname, '../debugger/python-tracer.py')];
  const run = spawnSync(executable, args, {
    input: JSON.stringify({ code, case_text: input, entry, expected_text }), encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('Python line snapshots are before execution; nested loops reset', () => {
  const r = trace('def solve(n):\n    out = []\n    for i in range(n):\n        for j in range(2):\n            out.append([i,j])\n    return out', '2');
  assert.equal(r.error, '');
  const body = r.events.filter(e => e.line === 5 && e.event === 'before');
  assert.deepEqual(body.map(e => e.loops.map(l => l.iteration)), [[1,1],[1,2],[2,1],[2,2]]);
  assert.equal(body[0].locals.out, '[]');
  assert.equal(body[1].locals.out, '[[0, 0]]');
  assert.equal(r.result, '[[0, 0], [0, 1], [1, 0], [1, 1]]');
  assert.ok(r.events.every(e => e.line > 0));
});

test('while loops and recursion retain independent frames', () => {
  const r = trace('def solve(n):\n    i = 0\n    while i < n:\n        i += 1\n    return n * solve(n-1) if n else 1', '3');
  assert.equal(r.result, '6');
  assert.deepEqual(r.events.filter(e => e.line === 4 && e.event === 'before').map(e => e.loops[0].iteration), [1,2,3,1,2,1]);
  assert.ok(r.events.some(e => e.depth === 3));
  assert.equal(r.events.at(-1).returnValue, '6');
});

test('named inputs and JSON literals are parsed without execution', () => {
  const r = trace('class Solution:\n    def solve(self, nums, target):\n        return [nums, target]', 'nums=[true, null], target=9');
  assert.equal(r.result, '[[True, None], 9]');
  assert.match(trace('def solve(x):\n    return x', '__import__("os").getcwd()').error, /ValueError/);
});

test('empty cases, ambiguity, explicit entry and errors', () => {
  assert.equal(trace('def solve():\n    return 7').result, '7');
  assert.match(trace('def solve(x):\n    return x').error, /missing/);
  const code = 'def a():\n    return 1\ndef b():\n    return 2';
  assert.match(trace(code).error, /Choose an entry/);
  assert.equal(trace(code, '', 'b').result, '2');
  const r = trace('def solve():\n    x = 1\n    return x / 0');
  assert.match(r.error, /ZeroDivisionError/);
  assert.ok(r.events.some(e => e.event === 'exception'));
});

test('execution and output are bounded', () => {
  const r = trace('def solve():\n    while True:\n        pass');
  assert.equal(r.limited, true);
  assert.equal(r.events.length, 2000);
  const output = trace('print("x" * 5000)');
  assert.equal(output.limited, true);
  assert.equal(output.stdout.length, 4000);
});

test('annotated linked lists and level-order trees', () => {
  assert.equal(trace('def solve(head: Optional[ListNode]):\n    return head.next.val', '[1,2]').result, '2');
  assert.equal(trace('def solve(root: TreeNode):\n    return root.right.val', '[1,null,3]').result, '3');
});

test('multiline arrays, matrices and argument rows', () => {
  const code = 'def solve(matrix, target):\n    return [matrix, target]';
  assert.equal(trace(code, 'matrix = [\n  [1, 2],\n  [3, 4]\n]\ntarget = 9').result, '[[[1, 2], [3, 4]], 9]');
  assert.equal(trace(code, '[\n [1, 2],\n [3, 4]\n]\n9').result, '[[[1, 2], [3, 4]], 9]');
  assert.equal(trace(code, 'matrix = [\n [true, null]\n],\ntarget = false').result, '[[[True, None]], False]');
});

test('Solution methods with loops use an unmangled instrumentation helper', () => {
  const r = trace('class Solution:\n    def twoSum(self, nums: List[int], target: int):\n        seen = {}\n        for i, n in enumerate(nums):\n            if target - n in seen:\n                return [seen[target - n], i]\n            seen[n] = i', 'nums=[2,7,11,15]\ntarget=9');
  assert.equal(r.error, '');
  assert.equal(r.result, '[0, 1]');
  assert.deepEqual(r.events.filter(e => e.line === 5 && e.event === 'before').map(e => e.loops[0].iteration), [1,2]);
  assert.ok(r.events.every(e => !('_openleet_tick' in e.locals)));
});

test('condition checks start at zero; break and continue reset inner activation', () => {
  const r = trace('def solve():\n    for i in range(2):\n        j = 0\n        while j < 3:\n            j += 1\n            if j == 1:\n                continue\n            break\n    return j');
  assert.equal(r.error, '');
  assert.deepEqual(r.events.filter(e => e.line === 4 && e.event === 'before').map(e => e.loops.map(l => l.iteration)), [[1,0],[1,1],[2,0],[2,1]]);
  assert.deepEqual(r.events.filter(e => e.line === 5 && e.event === 'before').map(e => e.loops.map(l => l.iteration)), [[1,1],[1,2],[2,1],[2,2]]);
  assert.deepEqual(r.events.find(e => e.line === 9).loops, []);
  const zero = trace('def solve():\n    while False:\n        pass\n    return 0');
  assert.deepEqual(zero.events.find(e => e.line === 2).loops, [{line:2, iteration:0}]);
});

test('single-line loops expose pre-body snapshots and loop else is outside body', () => {
  const r = trace('def solve():\n    n = 0\n    while n < 2: n += 1\n    for i in range(2): n += i\n    else:\n        n += 10\n    return n');
  assert.equal(r.error, '');
  assert.equal(r.result, '13');
  const whileBody = r.events.filter(e => e.line === 3 && e.event === 'before');
  assert.deepEqual(whileBody.map(e => e.loops[0].iteration), [0,1,2]);
  assert.deepEqual(whileBody.map(e => e.locals.n), ['0','0','1']);
  assert.deepEqual(r.events.find(e => e.line === 6).loops, []);
});

test('functions declared inside loops have their own loop scope', () => {
  const r = trace('def solve():\n    for i in range(2):\n        def inner():\n            for j in range(2):\n                pass\n        inner()\n    return 1');
  assert.equal(r.error, '');
  const inner = r.events.filter(e => e.function === 'inner' && e.line === 5 && e.event === 'before');
  assert.deepEqual(inner.map(e => e.loops), [[{line:4,iteration:1}],[{line:4,iteration:2}],[{line:4,iteration:1}],[{line:4,iteration:2}]]);
});

test('comparison uses complete values beyond snapshot truncation', () => {
  const expected = Array.from({length: 80}, (_, i) => i);
  expected[65] = -1;
  const r = trace('def solve():\n    return list(range(80))', '', '', JSON.stringify(expected));
  assert.equal(r.comparison.status, 'fail');
  assert.match(r.comparison.message, /\$\[65\]/);
  assert.equal(trace('def solve():\n    return list(range(80))', '', '', JSON.stringify(Array.from({length:80}, (_,i)=>i))).comparison.status, 'pass');
});

test('comparison handles omitted, malformed, failed and limited executions', () => {
  assert.equal(trace('def solve():\n    return 1').comparison.status, 'skip');
  const invalid = trace('def solve():\n    return 1', '', '', '__import__("os").getcwd()');
  assert.equal(invalid.comparison.status, 'error');
  assert.equal(invalid.result, '1');
  assert.equal(trace('def solve():\n    return 1 / 0', '', '', '1').comparison.status, 'error');
  const limited = trace('def solve():\n    while True:\n        pass', '', '', 'null');
  assert.equal(limited.limited, true);
  assert.equal(limited.comparison.status, 'error');
});

test('comparison is typed, recursive and explicit about float precision', () => {
  assert.equal(trace('def solve():\n    return True', '', '', '1').comparison.status, 'fail');
  assert.equal(trace('def solve():\n    return {True: 2}', '', '', '{1: 2}').comparison.status, 'fail');
  assert.equal(trace('def solve():\n    return {(True,): 2}', '', '', '{(1,): 2}').comparison.status, 'fail');
  assert.equal(trace('def solve():\n    return (1, 2)', '', '', '[1, 2]').comparison.status, 'fail');
  assert.equal(trace('def solve():\n    return {"x": [True, None]}', '', '', '{"x": [true, null]}').comparison.status, 'pass');
  const r = trace('def solve():\n    return {"x": [0.1 + 0.2]}', '', '', '{"x": [0.3]}');
  assert.equal(r.comparison.status, 'fail');
  assert.match(r.comparison.message, /\$\['x'\]\[0\]/);
  assert.match(r.comparison.message, /容差为 0/);
});

test('comparison skips complex objects, cycles and excessive traversal', () => {
  assert.equal(trace('def solve():\n    return ListNode(1)', '', '', '[1]').comparison.status, 'skip');
  assert.equal(trace('def solve():\n    x = []\n    x.append(x)\n    return x', '', '', '[]').comparison.status, 'skip');
  const large = JSON.stringify(Array(6000).fill(0));
  assert.equal(trace('def solve():\n    return [0] * 6000', '', '', large).comparison.status, 'skip');
});

test('recursive and sequential calls receive unique stable monotonic frame IDs', () => {
  const code = 'def recurse(n):\n    if n:\n        recurse(n-1)\n    return n\ndef solve():\n    recurse(2)\n    recurse(2)\n    return 1';
  const r = trace(code, '', 'solve', '1');
  assert.equal(r.comparison.status, 'pass');
  const calls = r.events.filter(e => e.function === 'recurse');
  const firstIds = [...new Set(calls.map(e => e.frameId))];
  assert.equal(firstIds.length, 6);
  assert.deepEqual(firstIds, [...firstIds].sort((a,b)=>a-b));
  for (const id of firstIds) {
    const events = calls.filter(e => e.frameId === id);
    assert.equal(events.at(-1).event, 'return');
    assert.equal(new Set(events.map(e => e.locals.n)).size, 1);
  }
  assert.ok(r.events.every(e => Number.isInteger(e.frameId) && e.frameId > 0));
});
