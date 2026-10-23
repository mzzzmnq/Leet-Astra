const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ui/motion.js'), 'utf8');

function harness({ hidden = true, reduced = false, animate = true, ...options } = {}) {
  const events = [], animations = [], attributes = {};
  const style = { opacity: '1' };
  const element = {
    hidden, inert: false,
    setAttribute(name, value) { attributes[name] = value; },
  };
  if (animate) element.animate = (frames, settings) => {
    events.push('animate');
    const animation = {
      frames, settings, cancelled: false, onfinish: null,
      cancel() { this.cancelled = true; events.push('cancel'); },
      complete() { this.onfinish?.(); },
    };
    animations.push(animation);
    return animation;
  };
  const context = vm.createContext({
    window: { getComputedStyle: () => style, matchMedia: () => ({ matches: reduced }) },
  });
  vm.runInContext(source, context);
  const motion = context.createViewMotion(element, {
    beforeShow() {
      assert.equal(element.hidden, false);
      assert.equal(element.inert, false);
      assert.equal(attributes['aria-hidden'], 'false');
      events.push('beforeShow');
    },
    afterHide() {
      assert.equal(element.hidden, true);
      assert.equal(element.inert, true);
      assert.equal(attributes['aria-hidden'], 'true');
      events.push('afterHide');
    },
    ...options,
  });
  return { element, motion, events, animations, attributes, style };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('initial hidden state disables interaction without starting an animation', () => {
  const h = harness();
  assert.equal(h.motion.isVisible(), false);
  assert.equal(h.element.inert, true);
  assert.equal(h.attributes['aria-hidden'], 'true');
  h.motion.setVisible(false);
  h.motion.finish();
  assert.deepEqual(h.events, []);
});

test('opening restores layout before animating and removes its fill on completion', () => {
  const h = harness({ duration: 500 });
  assert.equal(h.motion.toggle(), true);
  assert.equal(h.motion.isVisible(), true);
  assert.deepEqual(h.events, ['beforeShow', 'animate']);
  const animation = h.animations[0];
  assert.deepEqual(plain(animation.frames), [
    { opacity: '0' },
    { opacity: '1' },
  ]);
  assert.equal(animation.settings.duration, 500);
  animation.complete();
  assert.equal(animation.cancelled, true);
  assert.equal(h.element.hidden, false);
  assert.equal(h.element.inert, false);
  assert.equal(h.attributes['aria-hidden'], 'false');
});

test('closing blocks interaction immediately and hides only after the exit completes', () => {
  const h = harness({ hidden: false });
  assert.equal(h.motion.toggle(), false);
  assert.equal(h.motion.isVisible(), false);
  assert.equal(h.element.hidden, false);
  assert.equal(h.element.inert, true);
  assert.equal(h.attributes['aria-hidden'], 'true');
  assert.deepEqual(h.events, ['animate']);
  assert.equal(h.animations[0].settings.duration, 320);
  h.animations[0].complete();
  assert.equal(h.element.hidden, true);
  assert.deepEqual(h.events, ['animate', 'cancel', 'afterHide']);
});

test('reopening during exit continues from the current frame and ignores stale completion', () => {
  const h = harness({ hidden: false });
  h.motion.setVisible(false);
  const exit = h.animations[0], staleCompletion = exit.onfinish;
  h.style.opacity = '0.44';
  h.motion.toggle();
  assert.equal(exit.cancelled, true);
  assert.equal(h.element.inert, false);
  assert.deepEqual(plain(h.animations[1].frames[0]), h.style);
  staleCompletion();
  assert.equal(h.element.hidden, false);
  assert.equal(h.motion.isVisible(), true);
  assert.equal(h.events.includes('afterHide'), false);
  h.animations[1].complete();
  assert.equal(h.element.hidden, false);
});

test('closing during entrance preserves its current frame and the final intended state', () => {
  const h = harness();
  h.motion.setVisible(true);
  const entrance = h.animations[0], staleCompletion = entrance.onfinish;
  h.style.opacity = '0.3';
  h.motion.toggle();
  assert.deepEqual(plain(h.animations[1].frames[0]), h.style);
  staleCompletion();
  assert.equal(h.element.hidden, false);
  assert.equal(h.motion.isVisible(), false);
  h.animations[1].complete();
  assert.equal(h.element.hidden, true);
  assert.equal(h.events.filter(event => event === 'afterHide').length, 1);
});

test('finish settles entrance before dragging and clears the active opacity effect', () => {
  const h = harness();
  h.motion.setVisible(true);
  const animation = h.animations[0], staleCompletion = animation.onfinish;
  h.motion.finish();
  assert.equal(animation.cancelled, true);
  assert.equal(h.element.hidden, false);
  assert.equal(h.element.inert, false);
  staleCompletion();
  h.motion.finish();
  assert.equal(h.events.filter(event => event === 'cancel').length, 1);
});

test('finish settles exit once and a later toggle can open again', () => {
  const h = harness({ hidden: false });
  h.motion.setVisible(false);
  const staleCompletion = h.animations[0].onfinish;
  h.motion.finish();
  h.motion.finish();
  assert.equal(h.element.hidden, true);
  assert.equal(h.events.filter(event => event === 'afterHide').length, 1);
  h.motion.toggle();
  staleCompletion();
  assert.equal(h.element.hidden, false);
  assert.equal(h.motion.isVisible(), true);
});

test('reduced motion completes visibility immediately with the same callback order', () => {
  const h = harness({ reduced: true });
  h.motion.setVisible(true);
  assert.equal(h.element.hidden, false);
  h.motion.setVisible(false);
  assert.equal(h.element.hidden, true);
  assert.equal(h.animations.length, 0);
  assert.deepEqual(h.events, ['beforeShow', 'afterHide']);
});

test('missing Web Animations or zero duration falls back to immediate visibility', () => {
  for (const options of [{ animate: false }, { duration: 0 }]) {
    const h = harness(options);
    h.motion.toggle();
    assert.equal(h.element.hidden, false);
    h.motion.toggle();
    assert.equal(h.element.hidden, true);
    assert.equal(h.animations.length, 0);
    assert.deepEqual(h.events, ['beforeShow', 'afterHide']);
  }
});

test('repeating a target does not restart animations or repeat lifecycle callbacks', () => {
  const h = harness();
  h.motion.setVisible(true);
  h.motion.setVisible(true);
  h.animations[0].complete();
  h.motion.setVisible(true);
  h.motion.setVisible(false);
  h.motion.setVisible(false);
  h.animations[1].complete();
  h.motion.setVisible(false);
  assert.equal(h.animations.length, 2);
  assert.equal(h.events.filter(event => event === 'beforeShow').length, 1);
  assert.equal(h.events.filter(event => event === 'afterHide').length, 1);
});
