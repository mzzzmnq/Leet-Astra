const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ui/theme.js'), 'utf8');

function element(attributes = {}) {
  const attrs = { ...attributes };
  return {
    writes: [],
    style: { colorScheme: '' },
    computedScheme: 'normal',
    classList: { contains: name => (attrs.class || '').split(/\s+/).includes(name) },
    getAttribute: name => attrs[name] ?? null,
    setAttribute(name, value) { attrs[name] = value; this.writes.push([name, value]); },
    removeAttribute(name) { delete attrs[name]; },
  };
}
function harness({ html = {}, body = {}, dark = false, legacy = false } = {}) {
  const root = element(html), bodyRoot = element(body), panel = element(), launcher = element();
  const handlers = new Map(), mediaHandlers = new Set();
  let observer;
  const media = { matches: dark };
  const add = (event, fn) => mediaHandlers.add(fn);
  const remove = (event, fn) => mediaHandlers.delete(fn);
  if (legacy) {
    media.addListener = fn => add('change', fn);
    media.removeListener = fn => remove('change', fn);
  } else {
    media.addEventListener = add;
    media.removeEventListener = remove;
  }
  const context = vm.createContext({
    document: { documentElement: root, body: bodyRoot },
    window: {
      matchMedia: () => media,
      getComputedStyle: node => ({ colorScheme: node.computedScheme }),
      addEventListener: (event, fn) => handlers.set(event, fn),
      removeEventListener: event => handlers.delete(event),
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.observed = []; observer = this; }
      observe(target, options) { this.observed.push({ target, options }); }
      disconnect() { this.observed = []; }
    },
  });
  vm.runInContext(source, context);
  const dispose = context.installThemeSync(panel, launcher);
  return { root, body: bodyRoot, panel, launcher, observer, dispose, handlers, mediaHandlers,
    update: () => observer.callback([]),
    emit: event => handlers.get(event)?.(),
    system(value) { media.matches = value; for (const fn of mediaHandlers) fn(); },
    theme: () => panel.getAttribute('data-ocleet-theme'),
  };
}

test('tracks LeetCode root class changes on both panel and launcher', () => {
  const h = harness({ html: { class: 'dark other' } });
  assert.equal(h.theme(), 'dark');
  h.root.setAttribute('class', 'light other'); h.update();
  assert.equal(h.theme(), 'light');
  assert.equal(h.launcher.getAttribute('data-ocleet-theme'), 'light');
  assert.equal(h.observer.observed.length, 2);
  for (const { options } of h.observer.observed) {
    assert.equal(options.subtree, undefined);
    assert.equal(options.attributeFilter.includes('data-ocleet-theme'), false);
  }
});

test('page data attributes override system preference and react to removal', () => {
  const h = harness({ body: { 'data-theme': 'light' }, dark: true });
  assert.equal(h.theme(), 'light');
  h.system(false); h.system(true);
  assert.equal(h.theme(), 'light');
  h.body.removeAttribute('data-theme'); h.update();
  assert.equal(h.theme(), 'dark');
  h.body.setAttribute('data-color-mode', 'light'); h.update();
  assert.equal(h.theme(), 'light');
  h.root.setAttribute('data-theme', 'dark'); h.update();
  assert.equal(h.theme(), 'dark');
});

test('system preference follows changes when no explicit theme is present', () => {
  const h = harness({ html: { 'data-theme': 'system' } });
  assert.equal(h.theme(), 'light');
  h.system(true);
  assert.equal(h.theme(), 'dark');
  h.system(false);
  assert.equal(h.theme(), 'light');
});

test('single color-scheme is respected while multi-value schemes use system', () => {
  const h = harness({ dark: true });
  h.root.computedScheme = 'light'; h.update();
  assert.equal(h.theme(), 'light');
  h.root.computedScheme = 'light dark'; h.update();
  assert.equal(h.theme(), 'dark');
  h.body.style.colorScheme = 'light'; h.update();
  assert.equal(h.theme(), 'light');
  h.body.setAttribute('class', 'dark'); h.update();
  assert.equal(h.theme(), 'dark');
});

test('duplicate notifications do not rewrite theme attributes', () => {
  const h = harness();
  h.update(); h.update(); h.system(false);
  assert.equal(h.panel.writes.length, 1);
  assert.equal(h.launcher.writes.length, 1);
  h.system(true); h.update();
  assert.equal(h.panel.writes.length, 2);
});

test('page lifecycle pauses observers and resumes with latest theme', () => {
  const h = harness();
  h.emit('pagehide');
  assert.equal(h.mediaHandlers.size, 0);
  assert.equal(h.observer.observed.length, 0);
  h.system(true); h.update();
  assert.equal(h.theme(), 'light');
  h.emit('pageshow');
  assert.equal(h.theme(), 'dark');
  assert.equal(h.mediaHandlers.size, 1);
  assert.equal(h.observer.observed.length, 2);
  h.emit('pageshow');
  assert.equal(h.observer.observed.length, 2);
  h.dispose();
  assert.equal(h.handlers.size, 0);
  assert.equal(h.mediaHandlers.size, 0);
  assert.equal(h.observer.observed.length, 0);
});

test('legacy media query listeners follow the same lifecycle', () => {
  const h = harness({ legacy: true });
  h.system(true);
  assert.equal(h.theme(), 'dark');
  h.dispose();
  assert.equal(h.mediaHandlers.size, 0);
});
