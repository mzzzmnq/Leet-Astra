const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=(f,a,o={})=>spawn(f,a,{...o,windowsHide:true});
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage({viewport:{width:1280,height:960},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.resolve('demo.html')).href+'?ocleet=1');
 const panel=page.locator('.ocleet-panel'), input=page.locator('[data-ocleet="input"]'),status=page.locator('[data-ocleet="chat-status"]');
 await page.locator('#demo-code').focus();const original=await page.locator('#demo-code').inputValue();
 await page.keyboard.press('Alt+Shift+A');assert.equal(await panel.isVisible(),true);assert.equal(await input.evaluate(e=>e===document.activeElement),true);
 assert.equal(await status.isVisible(),false);
 await page.keyboard.press('Alt+Shift+A');assert.equal(await panel.isVisible(),false);assert.equal(await page.locator('#demo-code').evaluate(e=>e===document.activeElement),true);assert.equal(await page.locator('#demo-code').inputValue(),original);
 await page.keyboard.press('a');assert.equal(await panel.isVisible(),false);
 await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyA',altKey:true,shiftKey:true,isComposing:true,bubbles:true})));assert.equal(await panel.isVisible(),false);
 await page.keyboard.press('Alt+Shift+A');
 await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyA',altKey:true,shiftKey:true,repeat:true,bubbles:true})));assert.equal(await panel.isVisible(),true);
 await page.locator('[data-ocleet="settings"]').click();assert.equal(await page.locator('[data-ocleet="font-increase"]').isVisible(),true);await page.locator('[data-ocleet="font-increase"]').click();await page.locator('[data-ocleet="settings-done"]').click();
 await page.locator('[data-ocleet="note-tools"] summary').click();assert.equal(await page.locator('[data-ocleet="clear"]').isVisible(),true);await page.locator('[data-ocleet="note-tools"] summary').click();
 await page.evaluate(()=>{window.savedSetValue=window.GM_setValue;window.GM_setValue=()=>{throw Error('Storage failure');};});await input.fill('草稿');await page.waitForFunction(()=>document.querySelector('[data-ocleet="chat-status"]').textContent.includes('失败'));assert.equal(await status.isVisible(),true);
 await page.evaluate(()=>{window.GM_setValue=window.savedSetValue;window.GM_xmlhttpRequest=opts=>{setTimeout(()=>opts.onload({status:200,responseText:JSON.stringify({choices:[{message:{content:'用哈希表记录已遍历的数，每次查找目标差值只需平均 O(1)。\n\n```python\nseen = {}\nfor i, x in enumerate(nums):\n    if target - x in seen:\n        return [seen[target - x], i]\n    seen[x] = i\n```\n\n时间 O(n)，空间 O(n)。'}}]})}),20);return {abort(){}};};});await input.fill('解释一下哈希表为什么能把这题降到 O(n)？');
 await page.locator('[data-ocleet="send"]').click();await page.waitForFunction(()=>!document.querySelector('[data-ocleet="send"]').disabled);assert.equal(await status.isVisible(),false);assert.equal(await page.locator('[data-ocleet="execution-preview"]').isVisible(),false);
 const out=process.env.UI_SCREENSHOTS_DIR;
 for(const theme of ['light','dark']){await page.locator('#demo-theme').selectOption(theme);await page.waitForFunction(t=>document.querySelector('.ocleet-panel').dataset.ocleetTheme===t,theme);if(out){fs.mkdirSync(out,{recursive:true});await panel.screenshot({path:path.join(out,'compact-'+theme+'.png')});}}
 await page.setViewportSize({width:360,height:740});await page.locator('#demo-theme').selectOption('light');const box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=361);assert.ok(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth));
 if(out) await panel.screenshot({path:path.join(out,'compact-mobile.png')});assert.deepEqual(errors,[]);
 console.log('Shortcut focus/typing/IME/repeat, hidden autosave, visible save errors, font/menu access, themes and narrow layout: passed');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
