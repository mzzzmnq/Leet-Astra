function debugVariableChanges(events, index) {
  const current = events[index];
  if (!current) return { first: true, rows: [] };
  let previous;
  if (current.frameId !== undefined) {
    for (let i = index - 1; i >= 0; i--) {
      if (events[i].frameId === current.frameId) { previous = events[i]; break; }
    }
  }
  const before = previous?.locals || {}, after = current.locals || {};
  const names = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  const has = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
  return { first: !previous, rows: names.map(name => ({
    name,
    kind: !previous ? 'initial' : !has(after, name) ? 'removed' : !has(before, name) ? 'added' : before[name] !== after[name] ? 'changed' : 'unchanged',
    before: before[name], value: after[name],
  })) };
}

function installPythonDebugger() {
  addStyle(`
.ocleet-panel.ocleet-debug-open{width:960px;height:88vh;max-height:calc(100vh - 24px)}
.ocleet-debugger{position:absolute;inset:49px 0 0;z-index:3;background:var(--ocleet-surface);display:flex;flex-direction:column;padding:12px;gap:10px;overflow:auto;font-size:var(--ocleet-font-size,14px)}
.ocleet-debugger[hidden]{display:none}
.ocleet-debug-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ocleet-debug-toolbar strong{margin-right:auto}
.ocleet-debugger label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ocleet-muted)}
.ocleet-debugger :is(select,input,textarea){min-width:0;border:1px solid var(--ocleet-line-strong);border-radius:7px;background:var(--ocleet-input);color:var(--ocleet-text);padding:7px;font:inherit}
.ocleet-debugger textarea{width:100%;resize:vertical;min-height:62px;max-height:120px;font-family:Consolas,monospace}
.ocleet-debug-case{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ocleet-debug-status{font-size:12px;color:var(--ocleet-muted);white-space:pre-wrap;overflow-wrap:anywhere}
.ocleet-debug-workspace{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:10px;flex:1;min-height:210px}
.ocleet-debug-code{overflow:auto;border:1px solid var(--ocleet-line);border-radius:8px;background:var(--ocleet-code);min-width:0;min-height:0;max-height:48vh}
.ocleet-debug-line{display:block;text-align:left;border:0;border-bottom:1px solid var(--ocleet-line);border-radius:0;background:transparent;color:var(--ocleet-text);padding:3px 8px;white-space:pre;min-width:100%;width:max-content;font:var(--ocleet-font-size,14px)/1.6 Consolas,monospace;cursor:pointer}
.ocleet-debug-line span{display:inline-block;width:3em;color:var(--ocleet-subtle);user-select:none}
.ocleet-debug-line.active{background:var(--ocleet-selected);color:var(--ocleet-text)}
.ocleet-debug-line.visited span{color:var(--ocleet-accent)}
.ocleet-debug-inspect{overflow:auto;min-width:0;max-height:48vh}
.ocleet-debug-vars{margin:8px 0;border-top:1px solid var(--ocleet-line)}
.ocleet-debug-vars div{display:grid;grid-template-columns:minmax(60px,auto) 1fr;gap:10px;padding:6px 0;border-bottom:1px solid var(--ocleet-line)}
.ocleet-debug-vars dt{color:var(--ocleet-accent);font-family:Consolas,monospace}
.ocleet-debug-vars dd{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:Consolas,monospace}
.ocleet-debug-vars .changed{background:var(--ocleet-changed)}.ocleet-debug-vars .added{background:var(--ocleet-added)}.ocleet-debug-vars .removed{background:var(--ocleet-removed)}
.ocleet-debug-result{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:110px;overflow:auto;margin:0;color:var(--ocleet-muted)}
@media(max-width:650px){.ocleet-debug-workspace{grid-template-columns:1fr}.ocleet-debug-code,.ocleet-debug-inspect{max-height:32vh}.ocleet-debug-case{grid-template-columns:1fr}}
`);
  const view = document.createElement('section');
  view.className = 'ocleet-debugger';
  view.hidden = true;
  view.setAttribute('aria-label', 'Python 逐行调试');
  view.innerHTML = `
    <div class="ocleet-debug-toolbar"><strong>Python 3 · 逐行调试</strong><button class="ocleet-btn" data-debug="back">返回对话</button></div>
    <div class="ocleet-debug-toolbar"><button class="ocleet-btn" data-debug="read">读取代码与用例</button><button class="ocleet-btn" data-debug="add">添加用例</button><button class="ocleet-btn" data-debug="delete">删除用例</button><button class="ocleet-btn primary" data-debug="run">运行当前用例</button><button class="ocleet-btn" data-debug="stop" disabled>停止</button></div>
    <div class="ocleet-debug-case"><label>测试用例<select data-debug="case" aria-label="调试测试用例"></select></label><label>入口方法（单一方法自动识别）<input data-debug="entry" placeholder="例如 twoSum" autocomplete="off" /></label></div>
    <label>当前用例输入（可编辑；每行一个参数，或 nums=[…], target=9）<textarea data-debug="input" aria-label="调试用例输入" spellcheck="false"></textarea></label>
    <label>预期输出（留空则不比较）<textarea data-debug="expected" aria-label="预期输出" maxlength="16000" spellcheck="false"></textarea></label>
    <div class="ocleet-debug-status" data-debug="status" role="status">读取后运行用例，再点击代码行查看变量。</div>
    <div class="ocleet-debug-toolbar"><button class="ocleet-btn" data-debug="prev">上一步</button><button class="ocleet-btn" data-debug="next">下一步</button><label>所选行的执行记录<select data-debug="occurrence" aria-label="执行记录"></select></label></div>
    <div class="ocleet-debug-workspace"><div class="ocleet-debug-code" data-debug="code" aria-label="点击代码行查看执行状态"></div><div class="ocleet-debug-inspect"><div data-debug="position" class="ocleet-debug-status">尚未运行</div><dl class="ocleet-debug-vars" data-debug="vars"></dl><pre class="ocleet-debug-result" data-debug="result"></pre></div></div>`;
  panel.appendChild(view);
  const el = name => view.querySelector(`[data-debug="${name}"]`);
  let cases = [], selected = 0, snapshot = '', events = [], cursor = -1, activeRun = null;
  let pageKey = location.pathname, runVersion = 0, lineButtons = [];
  const savedKey = () => 'debug-cases:' + location.hostname + ':' + (currentSlug() || location.pathname);
  const status = text => { el('status').textContent = text; };
  function saveCases() {
    store.set(savedKey(), cases.filter(c => c.manual).slice(0, 30).map(c => ({ name: c.name, input: c.input, expected: (c.expected || '').slice(0, 16000) })));
  }
  function cancel() {
    runVersion++;
    activeRun?.cancel(); activeRun = null;
    el('run').disabled = false; el('stop').disabled = true;
  }
  function invalidate() {
    cancel(); events = []; cursor = -1;
    el('vars').replaceChildren(); el('result').textContent = '';
    el('position').textContent = '输入已更新，请运行当前用例。';
    el('occurrence').replaceChildren();
    for (const button of lineButtons) button.classList.remove('active', 'visited');
    el('prev').disabled = el('next').disabled = true;
  }
  function populateCases() {
    el('case').replaceChildren();
    for (const [i, c] of cases.entries()) {
      const option = document.createElement('option'); option.value = i;
      option.textContent = c.name + (c.manual ? ' · 手动' : c.source === 'question' ? ' · 题目示例' : ' · 页面用例');
      el('case').appendChild(option);
    }
    selected = Math.max(0, Math.min(selected, cases.length - 1));
    el('case').value = String(selected);
    el('input').value = cases[selected]?.input || '';
    el('expected').value = cases[selected]?.expected || '';
  }
  function getCode() {
    const data = readCode();
    if (!data.code?.trim()) throw new Error('未读取到代码。请先在题目编辑器中输入 Python 3 代码。');
    if (data.codeIncomplete) throw new Error('仅获取到代码片段。请等完整编辑器加载后再读取。');
    if (data.lang && !/^(python(?:\s*3)?|py)$/i.test(data.lang.trim())) throw new Error('逐行调试支持 Python 3，请切换题目编辑器语言。当前语言：' + data.lang);
    if (data.code.length > 30000) throw new Error('当前代码超过 30,000 字符，请缩小后调试。');
    return data.code;
  }
  function renderCode() {
    el('code').replaceChildren(); lineButtons = [];
    snapshot.split('\n').forEach((line, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'ocleet-debug-line';
      button.setAttribute('aria-label', '第 ' + (index + 1) + ' 行：' + line);
      const number = document.createElement('span'); number.textContent = index + 1;
      button.append(number, document.createTextNode(line || ' '));
      button.addEventListener('click', () => selectLine(index + 1));
      el('code').appendChild(button); lineButtons.push(button);
    });
  }
  function refresh() {
    invalidate();
    try {
      snapshot = getCode(); renderCode();
      const imported = readDebugTestCases();
      const retained = cases.filter(c => c.manual || c.source === 'visible-testcase');
      const merged = [...retained];
      for (const item of imported) {
        if (!merged.some(c => c.input.trim() === item.input.trim())) merged.push(item);
      }
      cases = merged.slice(0, 40);
      if (!cases.length) cases.push({ name: '用例 1', input: '', manual: true });
      populateCases();
      status(`已读取 ${snapshot.split('\n').length} 行代码、${imported.length} 个页面用例。手动新增的页面用例请先切到该用例，再点「读取代码与用例」；也可在此添加。`);
    } catch (error) { status(error.message); }
  }
  function selectLine(line) {
    const indices = events.flatMap((event, i) => event.line === line ? [i] : []);
    for (const [i, button] of lineButtons.entries()) button.classList.toggle('active', i + 1 === line);
    if (!indices.length) {
      cursor = -1;
      el('prev').disabled = el('next').disabled = true;
      el('occurrence').replaceChildren(); el('vars').replaceChildren();
      el('position').textContent = `第 ${line} 行没有执行记录（空行、注释、未执行分支或尚未运行）。`;
      return;
    }
    showEvent(indices.includes(cursor) ? cursor : indices[0]);
  }
  function showEvent(index) {
    cursor = index;
    const event = events[index]; if (!event) return;
    for (const [i, button] of lineButtons.entries()) button.classList.toggle('active', i + 1 === event.line);
    el('occurrence').replaceChildren();
    let visit = 0;
    events.forEach((item, i) => {
      if (item.line !== event.line) return;
      const option = document.createElement('option'); option.value = i;
      option.textContent = `第 ${++visit} 次到达 · ${item.function} · ${item.event === 'return' ? '返回' : item.event === 'exception' ? '异常' : '执行前'}`;
      el('occurrence').appendChild(option);
    });
    el('occurrence').value = index;
    const loops = (event.loops || []).map(loop => `第 ${loop.line} 行循环：第 ${loop.iteration} 次`).join('；');
    el('position').textContent = `步骤 ${index + 1}/${events.length} · 第 ${event.line} 行 · ${event.function} · 调用深度 ${event.depth}\n${event.event === 'before' ? '该行执行前的变量（下一步查看后续状态）' : event.event === 'return' ? '函数返回：' + event.returnValue : '此行抛出异常：' + event.exception}${loops ? '\n' + loops : ''}`;
    el('vars').replaceChildren();
    const changes = debugVariableChanges(events, index);
    el('position').textContent += changes.first ? '\n首次状态' : '\n变量变化：对比同一调用帧的上一条执行记录';
    for (const { name, value, before, kind } of changes.rows) {
      const row = document.createElement('div'), key = document.createElement('dt'), val = document.createElement('dd');
      row.className = kind;
      key.textContent = name;
      val.textContent = kind === 'changed' ? before + ' → ' + value : kind === 'added' ? '新增：' + value : kind === 'removed' ? '删除：' + before : value;
      row.append(key, val); el('vars').appendChild(row);
    }
    el('prev').disabled = index <= 0; el('next').disabled = index >= events.length - 1;
  }
  async function run() {
    invalidate();
    const version = runVersion, path = location.pathname;
    try {
      if (pageKey !== location.pathname) { onRouteChange(); throw new Error('题目已切换，请重新读取代码与用例。'); }
      snapshot = getCode(); renderCode();
      if (el('input').value.length > 16000) throw new Error('用例输入过长，请缩小后重试。');
      if (el('expected').value.length > 16000) throw new Error('预期输出超过 16,000 字符，请缩小后重试。');
      el('run').disabled = true; el('stop').disabled = false;
      activeRun = createPythonDebugRun({ code: snapshot, input: el('input').value, entry: el('entry').value.trim(), expected: el('expected').value }, status);
      const result = await activeRun.promise;
      if (version !== runVersion || path !== location.pathname) return;
      events = result.events || [];
      const visited = new Set(events.map(event => event.line));
      lineButtons.forEach((button, i) => button.classList.toggle('visited', visited.has(i + 1)));
      const comparison = result.comparison || { status: 'skip', message: '未提供比较结果。' };
      const comparisonLabel = { pass: '通过', fail: '失败', skip: '未比较', error: '无法比较' }[comparison.status] || '未比较';
      el('result').textContent = `${comparisonLabel}：${comparison.message}\n返回值：${result.result}\n${result.error ? '错误：' + result.error + '\n' : ''}${result.stdout ? '标准输出：\n' + result.stdout : ''}`;
      status(`${result.error ? '执行结束，发生错误。' : '执行完成。'}记录 ${events.length} 步。点击代码行查看每次到达时的变量。${result.limited ? '已达到记录限制，轨迹不完整。' : ''}${readCode().code !== snapshot ? '编辑器代码已改变；当前结果对应本次运行的代码快照。' : ''}`);
      el('status').textContent += '变量快照可能截断，变化高亮按显示的快照比较。';
      if (events.length) showEvent(0);
    } catch (error) {
      if (version === runVersion && path === location.pathname) status(error.message);
    } finally {
      if (version === runVersion) { activeRun = null; el('run').disabled = false; el('stop').disabled = true; }
    }
  }
  el('run').addEventListener('click', run);
  el('stop').addEventListener('click', () => { cancel(); status('已停止。可缩小用例后重新运行。'); });
  el('read').addEventListener('click', refresh);
  el('case').addEventListener('change', () => { invalidate(); selected = Number(el('case').value); el('input').value = cases[selected]?.input || ''; el('expected').value = cases[selected]?.expected || ''; });
  el('entry').addEventListener('input', invalidate);
  el('input').addEventListener('input', () => {
    invalidate();
    if (!cases[selected]) cases.push({ name: '用例 1', input: '', manual: true });
    cases[selected].input = el('input').value; cases[selected].manual = true; saveCases();
  });
  el('expected').addEventListener('input', () => {
    invalidate();
    if (!cases[selected]) { cases.push({ name: '用例 1', input: el('input').value, manual: true }); selected = cases.length - 1; }
    cases[selected].expected = el('expected').value.slice(0, 16000); cases[selected].manual = true; saveCases();
  });
  el('add').addEventListener('click', () => {
    if (cases.filter(c => c.manual).length >= 30) return status('最多保存 30 个手动用例，请先删除不需要的用例。');
    invalidate(); cases.push({ name: '自定义 ' + (cases.length + 1), input: '', manual: true }); selected = cases.length - 1; populateCases(); saveCases(); el('input').focus();
  });
  el('delete').addEventListener('click', () => { invalidate(); cases.splice(selected, 1); populateCases(); saveCases(); });
  el('prev').addEventListener('click', () => { if (cursor > 0) showEvent(cursor - 1); });
  el('next').addEventListener('click', () => { if (cursor < events.length - 1) showEvent(cursor + 1); });
  el('occurrence').addEventListener('change', () => showEvent(Number(el('occurrence').value)));
  function loadSavedCases() {
    const saved = store.get(savedKey(), []);
    cases = Array.isArray(saved) ? saved.filter(c => c && typeof c.input === 'string' && typeof c.name === 'string').slice(0, 30).map(c => ({ ...c, expected: typeof c.expected === 'string' ? c.expected.slice(0, 16000) : '', manual: true })) : [];
  }
  function onRouteChange() {
    invalidate(); pageKey = location.pathname; snapshot = ''; renderCode(); el('entry').value = '';
    loadSavedCases(); populateCases(); status('题目已切换，请读取新题目的代码与用例。');
  }
  $('open-debugger').addEventListener('click', () => {
    if (pageKey !== location.pathname) onRouteChange();
    view.hidden = false; panel.classList.add('ocleet-debug-open'); restorePanelPosition();
    if (!snapshot) { loadSavedCases(); refresh(); }
  });
  el('back').addEventListener('click', () => { cancel(); view.hidden = true; panel.classList.remove('ocleet-debug-open'); restorePanelPosition(); });
  window.addEventListener('pagehide', cancel);
  invalidate();
  return { onRouteChange };
}
