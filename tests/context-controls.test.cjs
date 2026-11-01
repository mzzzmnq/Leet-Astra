const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { setup } = require('./conversation-harness.cjs');

test('problem reader never accesses the code editor', () => {
  const app = setup();
  const source = fs.readFileSync(path.join(__dirname, '../openleet.user.js'), 'utf8');
  Object.assign(app.context, {
    readTitle: () => 'Two Sum', readDifficulty: () => 'Easy', readTags: () => ['Array'], readDescription: () => 'Find two numbers',
    readCode: () => { throw Error('Problem-only reading must not access Monaco'); },
  });
  vm.runInContext(source.slice(source.indexOf('  function readProblem()'), source.indexOf('  function readChatContext(')), app.context);
  assert.equal(app.context.readProblem().description, 'Find two numbers');
  assert.equal('code' in app.context.readProblem(), false);
  assert.equal(app.context.codeStatusEl.textContent, undefined);
});

test('code button reads only current code and refreshes its independent status', () => {
  const app = setup();
  app.context.readProblem = () => { throw Error('Code-only reading must not access the problem'); };
  let code = 'print(1)';
  app.context.readCode = () => ({ code, lang: 'python', codeSource: 'model', codeIncomplete: false });
  app.context.onReadCode();
  assert.match(app.context.codeStatusEl.textContent, /8 字符/);
  code = '';
  app.context.onReadCode();
  assert.match(app.context.codeStatusEl.textContent, /0 字符/);
  assert.match(app.rendered.at(-1).content, /代码为空/);
});

test('Python mode attaches explicitly requested code, refreshing it at send time without reading the problem', async () => {
  const app = setup();
  app.context.cfg.mode = 'knowledge';
  app.context.readProblem = () => { throw Error('Do not read a problem in knowledge mode'); };
  let code = 'OLD_CODE';
  app.context.readCode = () => ({ code, lang: 'python', codeSource: 'model' });
  app.context.onReadCode();
  code = 'nums[::-1]';
  const pending = app.send('解释这段语法');
  const system = app.requests[0].payload.messages[0].content;
  assert.match(system, /nums\[::-1\]/);
  assert.doesNotMatch(system, /OLD_CODE|【题目】/);
  app.requests[0].resolve();
  await pending;
});

test('disabled code sending remains respected after explicitly reading code', async () => {
  const app = setup();
  app.context.cfg.mode = 'knowledge';
  app.context.cfg.includeCode = false;
  app.context.onReadCode();
  assert.match(app.context.codeStatusEl.textContent, /已关闭发送代码/);
  app.context.readCode = () => { throw Error('Disabled code must not be read during sending'); };
  const pending = app.send('问个语法');
  assert.doesNotMatch(app.requests[0].payload.messages[0].content, /CURRENT_CODE|【用户当前代码/);
  app.requests[0].resolve();
  await pending;
});

test('problem and code controls do not overwrite each other, and changing problems clears explicit code selection', async () => {
  const app = setup();
  app.context.onReadCode();
  const codeStatus = app.context.codeStatusEl.textContent;
  app.context.renderProblemChip(app.context.readProblem());
  assert.equal(app.context.codeStatusEl.textContent, codeStatus);
  app.context.cfg.mode = 'knowledge';
  app.navigate('add-two-numbers');
  assert.equal(app.context.codeStatusEl.hidden, true);
  app.context.readCode = () => { throw Error('Previous problem code must not carry over'); };
  const pending = app.send('Python 问题');
  assert.doesNotMatch(app.requests[0].payload.messages[0].content, /【用户当前代码/);
  app.requests[0].resolve();
  await pending;
});

test('chat reads newly added cases and latest run errors on each send without debugger', async () => {
 const h=setup();
 let input='nums = [1, 1, 1, 1]', error='IndexError: list index out of range';
 h.context.readChatExecution=()=>({testCases:[{name:'手动用例 4',input}],runResult:error});
 const first=h.send('分析新增用例的错误');
 assert.match(h.requests[0].payload.messages[0].content,/手动用例 4/);
 assert.match(h.requests[0].payload.messages[0].content,/IndexError/);
 h.requests[0].resolve();await first;
 input='nums = []';error='Wrong Answer';
 const second=h.send('现在呢');
 const system=h.requests[1].payload.messages[0].content;
 assert.ok(system.includes(input));assert.match(system,/Wrong Answer/);assert.doesNotMatch(system,/IndexError/);
 h.requests[1].resolve();await second;
 h.context.cfg.mode='knowledge';
 h.context.readChatExecution=()=>{throw Error('Knowledge mode must not read execution');};
 const third=h.send('解释切片');h.requests[2].resolve();await third;
});
