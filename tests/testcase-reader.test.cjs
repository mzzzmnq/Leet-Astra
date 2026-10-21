const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../debugger/testcase-reader.js'), 'utf8');

class Element {
  constructor(tag = 'div', attrs = {}, children = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children;
    this.textContent = attrs.text || '';
    this.isConnected = true;
    if ('value' in attrs) this.value = attrs.value;
    for (const child of children) child.parent = this;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getClientRects() { return this.attrs.invisible ? [] : [{}]; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    return selector.split(',').some((part) => {
      part = part.trim();
      if (part.startsWith('input:')) return this.tag === 'input' && !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(this.attrs.type);
      if (part.startsWith('.')) return (this.attrs.class || '').split(' ').includes(part.slice(1));
      const attribute = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attribute) return attribute[2] === undefined ? attribute[1] in this.attrs : this.attrs[attribute[1]] === attribute[2];
      return this.tag === part;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
const field = (value) => new Element('textarea', { value });
const panel = (...children) => new Element('div', { 'data-e2e-locator': 'console-testcase' }, children);
function setup(children = [], description = '', editors = []) {
  const body = new Element('body', {}, children);
  const context = vm.createContext({
    document: { querySelectorAll: (s) => body.querySelectorAll(s), getElementById: (id) => body.querySelectorAll(`[id="${id}"]`)[0] },
    readDescription: () => description,
    PAGE: { monaco: { editor: { getEditors: () => editors } } },
  });
  vm.runInContext(source, context);
  return { read: () => JSON.parse(JSON.stringify(context.readDebugTestCases())), parse: (s) => JSON.parse(JSON.stringify(context.parseDescriptionCases(s))) };
}

test('parses English, Chinese and multiline example inputs', () => {
  const { parse } = setup();
  assert.deepEqual(parse('Example 1:\nInput: nums = [1,\n2], target = 3\nOutput: [0,1]\n示例2：\n输入：s = "hi"\n输出：2').map((x) => x.input), ['nums = [1,\n2], target = 3', 's = "hi"']);
  assert.deepEqual(parse('Input: unfinished'), []);
});

test('combines visible parameter fields in order, reads live values and deduplicates', () => {
  const first = field('[1,2]');
  const second = field('3');
  const { read } = setup([panel(first, second)], 'Input: [1,2]\n3\nOutput: 1');
  assert.equal(read().length, 1);
  second.value = '4';
  assert.deepEqual(read()[1], { name: '当前可见用例 1', input: '[1,2]\n4', source: 'visible-testcase' });
});

test('ignores unrelated editors, own panel, hidden tabs and hidden controls', () => {
  const own = new Element('div', { class: 'ocleet-panel' }, [panel(field('private'))]);
  const hidden = panel(field('hidden'));
  hidden.attrs['aria-hidden'] = 'true';
  const unrelated = new Element('div', { role: 'tabpanel', 'aria-label': 'Code' }, [field('code')]);
  assert.deepEqual(setup([field('unrelated'), own, hidden, unrelated, panel(new Element('input', { type: 'hidden', value: 'secret' }))]).read(), []);
});

test('accepts testcase labelled tabpanels and contenteditable manual input', () => {
  const label = new Element('button', { id: 'cases', text: '测试用例' });
  const manual = new Element('div', { contenteditable: 'true', text: '[8,9]' });
  const tab = new Element('div', { role: 'tabpanel', 'aria-labelledby': 'cases' }, [panel(manual, field('8'))]);
  assert.equal(setup([label, tab]).read()[0].input, '[8,9]\n8');
});

test('input-only wrappers form one ordered case and demo containers remain separate', () => {
  const wrappers = ['[1]', '2'].map((value) => new Element('div', { 'data-cy': 'testcase-input' }, [field(value)]));
  assert.equal(setup(wrappers).read()[0].input, '[1]\n2');
  const demos = ['1', '2'].map((value) => new Element('div', { 'data-ocleet-testcase': '' }, [field(value)]));
  assert.deepEqual(setup(demos).read().map((x) => x.input), ['1', '2']);
});

test('reads complete Monaco model only for visible testcase editor', () => {
  const scoped = new Element('div', { class: 'monaco-editor' }, [field('buffer')]);
  const code = new Element('div', { class: 'monaco-editor' });
  const editor = (node, value) => ({ getDomNode: () => node, getModel: () => ({ getValue: () => value }) });
  const { read } = setup([panel(scoped), code], '', [editor(code, 'unrelated code'), editor(scoped, '[1,2,3]\n4')]);
  assert.equal(read()[0].input, '[1,2,3]\n4');
  assert.deepEqual(setup([panel(scoped)]).read(), []);
});

test('ignores disposed Monaco models and zero-layout fields', () => {
  const node = new Element('div', { class: 'monaco-editor' });
  const hidden = field('old');
  hidden.attrs.invisible = true;
  const editor = { getDomNode: () => node, getModel: () => ({ isDisposed: () => true, getValue: () => 'stale' }) };
  assert.deepEqual(setup([panel(node, hidden)], '', [editor]).read(), []);
});

test('omits incomplete cases instead of shifting parameters', () => {
  const unavailable = new Element('div', { class: 'monaco-editor' });
  assert.deepEqual(setup([panel(unavailable, field('2'))]).read(), []);
  assert.deepEqual(setup([panel(field(''), field('2'))]).read(), []);
});
