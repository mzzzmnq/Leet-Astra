const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../openleet.user.js'), 'utf8');
const messageSource = source.slice(source.indexOf('  function addMessage('), source.indexOf('  function renderProblemChip('));

function element(tagName = 'div') {
  const node = {
    tagName, className: '', hidden: false, children: [], parentNode: null,
    innerHTML: '', textContent: '',
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    querySelectorAll() { return []; },
  };
  node.classList = {
    add(name) { node.className = [...new Set([...node.className.split(/\s+/), name])].join(' '); },
    remove(name) { node.className = node.className.split(/\s+/).filter(value => value !== name).join(' '); },
    contains(name) { return node.className.split(/\s+/).includes(name); },
  };
  return node;
}

function harness() {
  const messages = element();
  const fades = [];
  const frames = new Map();
  let nextFrame = 0;
  const context = vm.createContext({
    document: { createElement: element },
    messagesEl: messages,
    renderMarkdown: text => text ? `<p>${text}</p>` : '',
    scroll() {},
    fadeInMessage(node) {
      assert.ok(node.parentNode, 'Messages must be mounted before their fade starts');
      fades.push({ node, html: node.innerHTML, text: node.textContent, hidden: node.hidden });
    },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  vm.runInContext(messageSource, context);
  return {
    messages, fades, frames,
    addMessage: context.addMessage,
    addAssistant() {
      const response = context.addAssistant();
      const wrap = messages.children.at(-1);
      return { response, wrap, reason: wrap.children[0], body: wrap.children[1] };
    },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback());
    },
    fadesFor(node) { return fades.filter(fade => fade.node === node); },
  };
}

test('new user and completed assistant messages fade after insertion', () => {
  const h = harness();
  const question = h.addMessage('user', 'How does enumerate work?');
  const answer = h.addMessage('assistant', 'It yields an index and a value.');
  assert.deepEqual(h.messages.children, [question, answer]);
  assert.equal(h.fadesFor(question).length, 1);
  assert.equal(h.fadesFor(answer).length, 1);
  assert.equal(h.fadesFor(question)[0].text, 'How does enumerate work?');
  assert.equal(h.fadesFor(answer)[0].html, '<p>It yields an index and a value.</p>');
});

test('delayed first AI text fades when it arrives, independently of its placeholder', () => {
  const h = harness();
  const { response, wrap, body } = h.addAssistant();
  assert.equal(h.fadesFor(wrap).length, 1);
  assert.equal(h.fadesFor(body).length, 0);
  h.flush();
  response.onDelta('');
  h.flush();
  assert.equal(h.fadesFor(body).length, 0);
  response.onDelta('First words');
  assert.equal(h.fadesFor(body).length, 0, 'The fade must start after the scheduled text render');
  h.flush();
  assert.equal(h.fadesFor(body).length, 1);
  assert.equal(h.fadesFor(body)[0].html, '<p>First words</p>');
});

test('streaming chunks update text without restarting the first-text fade', () => {
  const h = harness();
  const { response, body } = h.addAssistant();
  response.onDelta('Use ');
  response.onDelta('enumerate');
  assert.equal(h.frames.size, 1);
  h.flush();
  response.onDelta('(items)');
  h.flush();
  response.onDelta(' for indexed iteration.');
  h.flush();
  response.done();
  assert.equal(h.fadesFor(body).length, 1);
  assert.equal(body.innerHTML, '<p>Use enumerate(items) for indexed iteration.</p>');
  assert.equal(response.text(), 'Use enumerate(items) for indexed iteration.');
});

test('a complete AI response received before the next frame still fades its rendered body', () => {
  const h = harness();
  const { response, body } = h.addAssistant();
  response.onDelta('Complete response');
  assert.equal(h.frames.size, 1);
  response.done();
  assert.equal(h.frames.size, 0);
  assert.equal(h.fadesFor(body).length, 1);
  assert.equal(h.fadesFor(body)[0].html, '<p>Complete response</p>');
  h.flush();
  response.done();
  assert.equal(h.fadesFor(body).length, 1);
});

test('reasoning fades on its first nonempty chunk and leaves the answer fade available', () => {
  const h = harness();
  const { response, reason, body } = h.addAssistant();
  response.onReasoning('');
  assert.equal(h.fadesFor(reason).length, 0);
  response.onReasoning('Consider the indices.');
  assert.equal(h.fadesFor(reason).length, 1);
  assert.equal(h.fadesFor(reason)[0].hidden, false);
  response.onReasoning(' Then inspect the values.');
  assert.equal(h.fadesFor(reason).length, 1);
  assert.equal(reason.children[1].textContent, 'Consider the indices. Then inspect the values.');
  assert.equal(h.fadesFor(body).length, 0);
  response.onDelta('Use enumerate.');
  h.flush();
  assert.equal(h.fadesFor(body).length, 1);
});

test('a failed response fades its error text and prevents a pending chunk from overwriting it', () => {
  const h = harness();
  const { response, wrap, body } = h.addAssistant();
  response.onDelta('Unrendered partial text');
  response.fail('Request failed');
  assert.equal(h.frames.size, 0);
  assert.equal(wrap.classList.contains('error'), true);
  assert.equal(h.fadesFor(body).length, 1);
  assert.equal(h.fadesFor(body)[0].text, 'Request failed');
  h.flush();
  assert.equal(body.textContent, 'Request failed');
});

test('an error replacing an already rendered partial reply gets its own fade', () => {
  const h = harness();
  const { response, body } = h.addAssistant();
  response.onDelta('Partial reply');
  h.flush();
  assert.equal(h.fadesFor(body).length, 1);
  response.fail('Connection interrupted');
  assert.equal(h.fadesFor(body).length, 2);
  assert.equal(h.fadesFor(body).at(-1).text, 'Connection interrupted');
});

function motionHarness({ reduced = false, animate = true } = {}) {
  const animations = [];
  const node = element();
  if (animate) node.animate = (keyframes, options) => {
    const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  };
  const context = vm.createContext({ window: { matchMedia: () => ({ matches: reduced }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/motion.js'), 'utf8'), context);
  return { animations, node, fade: () => context.fadeInMessage(node) };
}

test('message fade changes only opacity and removes its fill effect on completion', () => {
  const h = motionHarness();
  h.fade();
  const animation = h.animations[0];
  assert.deepEqual(JSON.parse(JSON.stringify(animation.keyframes)), [{ opacity: '0' }, { opacity: '1' }]);
  assert.equal(animation.options.duration, 400);
  assert.equal(animation.options.fill, 'both');
  assert.equal(animation.cancelled, false);
  animation.onfinish();
  assert.equal(animation.cancelled, true);
});

test('message fade leaves content immediately available with reduced motion or no animation API', () => {
  for (const options of [{ reduced: true }, { animate: false }]) {
    const h = motionHarness(options);
    h.node.textContent = 'Readable reply';
    h.fade();
    assert.equal(h.animations.length, 0);
    assert.equal(h.node.textContent, 'Readable reply');
    assert.equal(h.node.hidden, false);
  }
});
