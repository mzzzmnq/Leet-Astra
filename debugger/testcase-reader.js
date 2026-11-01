function parseDescriptionCases(text) {
  const cases = [];
  const pattern = /(?:\bInput|输入)\s*[:：]\s*([\s\S]*?)(?:\bOutput|输出)\s*[:：]/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    const input = match[1].trim();
    if (input) cases.push({ name: `题目示例 ${cases.length + 1}`, input, source: 'question' });
  }
  return cases;
}

function readDebugTestCases() {
  const inputSelector = '[data-e2e-locator="console-testcase-input"], [data-cy="testcase-input"]';
  const containerSelector = '[data-e2e-locator="console-testcase"], [data-ocleet-testcase], [role="tabpanel"]';
  const fieldSelector = 'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), [contenteditable="true"], .monaco-editor';
  const visible = (node) => !!node && node.isConnected !== false
    && !node.closest('.ocleet-panel, [hidden], [aria-hidden="true"]')
    && node.getClientRects().length > 0;
  const isCasePanel = (node) => {
    if (node.getAttribute('role') !== 'tabpanel') return true;
    const labels = (node.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '').join(' ');
    return /test\s*cases?|测试用例/i.test(`${node.getAttribute('aria-label') || ''} ${labels}`);
  };
  const containers = Array.from(document.querySelectorAll(containerSelector)).filter((node) => visible(node) && isCasePanel(node));
  const roots = containers.filter((node) => !containers.some((other) => other !== node && other.contains(node)));
  const orphans = Array.from(document.querySelectorAll(inputSelector))
    .filter((node) => visible(node) && !roots.some((root) => root.contains(node)));
  const groups = roots.map((root) => [root]);
  if (orphans.length) groups.push(orphans);

  // Only an editor whose DOM belongs to a recognized testcase can supply a model.
  const models = new Map();
  try {
    for (const editor of PAGE.monaco?.editor?.getEditors?.() || []) {
      try {
        const node = editor.getDomNode();
        if (visible(node) && groups.some((group) => group.some((root) => root === node || root.contains(node)))) {
          const model = editor.getModel();
          if (model && !model.isDisposed?.()) models.set(node, model.getValue());
        }
      } catch { /* An editor may be disposed while reading the page. */ }
    }
  } catch { /* DOM inputs remain available when Monaco is inaccessible. */ }

  const results = parseDescriptionCases(readDescription());
  for (const group of groups) {
    const fields = [];
    for (const root of group) {
      const candidates = root.matches(fieldSelector) ? [root] : Array.from(root.querySelectorAll(fieldSelector));
      for (const field of candidates) {
        if (!visible(field) || fields.includes(field)) continue;
        // Monaco's hidden textarea is an accessibility buffer, not the full input.
        if (field.closest('.monaco-editor') && !field.matches('.monaco-editor')) continue;
        if (candidates.some((other) => other !== field && other.contains(field))) continue;
        fields.push(field);
      }
      if (!candidates.length && root.matches(inputSelector)) fields.push(root);
    }
    const values = fields.map((field) => {
      if (field.matches('.monaco-editor')) return models.get(field);
      return typeof field.value === 'string' ? field.value : field.textContent;
    });
    // A missing parameter must not silently shift the remaining arguments.
    if (values.length && values.every((value) => typeof value === 'string' && value.trim())) {
      results.push({ name: `当前可见用例 ${results.filter((item) => item.source === 'visible-testcase').length + 1}`, input: values.map((value) => value.trim()).join('\n'), source: 'visible-testcase' });
    }
  }
  const seen = new Set();
  return results.filter((item) => {
    if (seen.has(item.input)) return false;
    seen.add(item.input);
    return true;
  });
}

// Read live page state on every chat send, independently of the Python debugger.
function readChatExecution() {
  const visible = node => node.isConnected !== false
    && !node.closest('.ocleet-panel, [hidden], [aria-hidden="true"]')
    && node.getClientRects().length > 0;
  const selectors = '[data-e2e-locator="console-result"], [data-e2e-locator="console-result-content"], [data-cy="test-result"], [role="tabpanel"]';
  const panels = Array.from(document.querySelectorAll(selectors)).filter(node => {
    if (!visible(node)) return false;
    if (node.getAttribute('role') !== 'tabpanel') return true;
    const labels = (node.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    return /test\s*result|测试结果|运行结果|执行结果/i.test((node.getAttribute('aria-label') || '') + ' ' + labels);
  });
  // LeetCode's dock layout also uses plain divs, without tabpanel roles.
  for (const label of document.querySelectorAll('span, button, div')) {
    if (!visible(label) || !/^(测试结果|运行结果|执行结果|Test Result|Test Results)$/i.test(label.textContent.trim())) continue;
    let container = label.parentElement;
    for (let depth = 0; container && depth < 9; depth++, container = container.parentElement) {
      if (container.matches('body, html') || container.querySelector('.ocleet-panel, .monaco-editor')) break;
      const text = container.innerText || '';
      if (/解答错误|执行出错|编译出错|通过|超出时间限制|Wrong Answer|Runtime Error|Compile Error|Accepted|Time Limit Exceeded/i.test(text)
          && /输入|输出|Input|Output|Error|错误/.test(text)) {
        if (!panels.includes(container)) panels.push(container);
        break;
      }
    }
  }
  const roots = panels.filter(node => !panels.some(other => other !== node && other.contains(node)));
  return {
    testCases: readDebugTestCases(),
    runResult: roots.map(node => node.innerText || node.textContent || '').join('\n').trim().slice(0, 12000),
  };
}
