// Run explicitly with Playwright available; independent of the dependency-free unit suite.
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = (file, args, options = {}) => spawn(file, args, { ...options, windowsHide: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(__dirname, '../demo.html')).href + '?ocleet=1');
    const panel = page.locator('.ocleet-panel');
    const launcher = page.locator('.ocleet-launcher');
    const click = selector => page.locator(selector).evaluate(element => element.click());
    const settled = selector => page.waitForFunction(selector => !document.querySelector(selector).getAnimations().some(a => a.effect.getKeyframes().some(f => f.transform !== undefined)), selector);
    async function sampleMotion(selector) {
      const sample = await page.locator(selector).evaluate(element => {
        const animation = element.getAnimations().find(a => a.effect.getKeyframes().some(f => f.transform !== undefined));
        if (!animation) throw new Error('No active visibility animation: ' + element.className);
        const running = animation.playState;
        animation.pause();
        const read = () => ({ opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform });
        animation.currentTime = 0;
        const start = read();
        animation.currentTime = animation.effect.getTiming().duration * 0.35;
        const middle = read();
        animation.finish();
        return { running, start, middle };
      });
      assert.equal(sample.running, 'running');
      assert.ok(sample.middle.opacity > 0 && sample.middle.opacity < 1, JSON.stringify(sample));
      assert.notEqual(sample.middle.transform, 'none');
      await settled(selector);
      return sample;
    }
    async function theme(value, background, foreground) {
      await page.locator('#demo-theme').selectOption(value);
      await page.waitForFunction(background => getComputedStyle(document.querySelector('.ocleet-panel')).backgroundColor === background, background);
      await page.waitForFunction(foreground => ['.ocleet-panel', '.ocleet-brand', '.ocleet-msg.assistant'].every(selector => getComputedStyle(document.querySelector(selector)).color === foreground), foreground);
      const colors = await page.evaluate(() => ['.ocleet-panel', '.ocleet-brand', '.ocleet-msg.assistant'].map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return { color: style.color, background: style.backgroundColor };
      }));
      for (const color of colors) assert.equal(color.color, foreground);
      return colors;
    }
    async function screenshot(name) {
      if (!process.env.UI_SCREENSHOTS_DIR) return;
      await page.waitForFunction(() => document.querySelector('.ocleet-panel').getAnimations({ subtree: true }).every(a => a.effect.getTiming().iterations === Infinity || ['finished', 'idle'].includes(a.playState)));
      fs.mkdirSync(process.env.UI_SCREENSHOTS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.UI_SCREENSHOTS_DIR, name + '.png') });
    }

    // Reproduce the old fixed root palette being loaded after the current stylesheet.
    await page.addStyleTag({ content: '.ocleet-panel{background:#12141c;color:#e7e9f0;border:1px solid rgba(255,255,255,.1);box-shadow:0 22px 70px rgba(0,0,0,.55)}' });
    await click('.ocleet-launcher');
    const entrance = await sampleMotion('.ocleet-panel');
    assert.equal(entrance.start.opacity, 0);
    const light = await theme('light', 'rgb(255, 255, 255)', 'rgb(30, 41, 59)');
    await screenshot('leet-astra-fixed-light');
    const dark = await theme('dark', 'rgb(21, 25, 35)', 'rgb(232, 236, 245)');
    await screenshot('leet-astra-fixed-dark');
    await theme('light', 'rgb(255, 255, 255)', 'rgb(30, 41, 59)');

    await click('[data-ocleet="close"]');
    assert.equal(await panel.evaluate(el => el.hidden), false);
    assert.equal(await panel.evaluate(el => el.inert), true);
    const exit = await sampleMotion('.ocleet-panel');
    assert.equal(exit.start.opacity, 1);
    assert.equal(await panel.isVisible(), false);

    // Reverse a partially completed close; the old completion must not hide the reopened panel.
    await click('.ocleet-launcher');
    await settled('.ocleet-panel');
    const reversal = await page.evaluate(() => {
      const panel = document.querySelector('.ocleet-panel');
      document.querySelector('[data-ocleet="close"]').click();
      const exit = panel.getAnimations().find(a => a.effect.getKeyframes().some(f => f.transform !== undefined));
      exit.pause(); exit.currentTime = 80;
      const opacity = getComputedStyle(panel).opacity;
      document.querySelector('.ocleet-launcher').click();
      const entrance = panel.getAnimations().find(a => a.effect.getKeyframes().some(f => f.transform !== undefined));
      return { opacity, restartedAt: entrance.effect.getKeyframes()[0].opacity };
    });
    assert.ok(Math.abs(Number(reversal.opacity) - Number(reversal.restartedAt)) < 0.001);
    await settled('.ocleet-panel');
    assert.equal(await panel.isVisible(), true);

    // Drag while entrance is paused at an intermediate frame, then reopen at the saved position.
    await click('[data-ocleet="close"]'); await settled('.ocleet-panel');
    await click('.ocleet-launcher');
    await panel.evaluate(el => { const a = el.getAnimations().find(a => a.effect.getKeyframes().some(f => f.transform !== undefined)); a.pause(); a.currentTime = 60; });
    const header = await page.locator('.ocleet-head').boundingBox();
    await page.mouse.move(header.x + 90, header.y + 25); await page.mouse.down();
    assert.equal(await panel.evaluate(el => getComputedStyle(el).transform), 'none');
    const before = await panel.boundingBox();
    await page.mouse.move(header.x - 70, header.y - 15); await page.mouse.up();
    const dragged = await panel.boundingBox();
    assert.ok(Math.abs(dragged.x - before.x + 160) < 1);
    assert.ok(Math.abs(dragged.y - before.y + 40) < 1);
    await click('[data-ocleet="close"]'); await settled('.ocleet-panel');
    await click('.ocleet-launcher'); await settled('.ocleet-panel');
    assert.deepEqual(await panel.boundingBox(), dragged);

    await click('[data-ocleet="settings"]'); await sampleMotion('.ocleet-settings');
    assert.equal(await page.locator('[data-ocleet="apikey"]').evaluate(el => getComputedStyle(el).color), 'rgb(30, 41, 59)');
    await click('[data-ocleet="settings-done"]'); await sampleMotion('.ocleet-settings');
    await click('[data-ocleet="open-debugger"]'); await sampleMotion('.ocleet-debugger');
    assert.equal(await page.locator('.ocleet-debugger').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
    await click('[data-debug="back"]'); await sampleMotion('.ocleet-debugger');
    assert.equal(await panel.evaluate(el => el.classList.contains('ocleet-debug-open')), false);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await click('[data-ocleet="close"]'); assert.equal(await panel.isVisible(), false);
    await click('.ocleet-launcher'); assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.evaluate(el => el.getAnimations().length), 0);
    await page.setViewportSize({ width: 390, height: 740 });
    const box = await panel.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ light, dark, entrance, exit, checks: 'late legacy CSS, animation intermediate frames, rapid reversal, dragging during entrance, saved position, settings/debugger, reduced motion, narrow layout' }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
