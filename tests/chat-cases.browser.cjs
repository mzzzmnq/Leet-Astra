const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=(f,a,o={})=>spawn(f,a,{...o,windowsHide:true});
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path=require('node:path'),{pathToFileURL}=require('node:url'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();await page.goto(pathToFileURL(path.resolve('demo.html')).href+'?ocleet=1');
 await page.evaluate(()=>{const section=document.createElement('section');section.id='result-fixture';section.innerHTML='<div><div><span>测试结果</span></div><div>解答错误</div></div><div>Case 1 Case 2 Case 3 Case 4</div><div id="case-input">输入 nums = [1,-6] target = -5</div><div>输出 [-1,-1] 预期 [0,1]</div>';document.body.prepend(section);window.GM_xmlhttpRequest=o=>{window.sent=JSON.parse(o.data);o.onload({status:200,responseText:JSON.stringify({choices:[{message:{content:'ok'}}]})});return {abort(){}};};});
 const click=s=>page.locator(s).evaluate(e=>e.click());
 await click('.ocleet-launcher');assert.equal(await page.locator('[data-ocleet="read"]').innerText(),'读取测试用例');
 await page.locator('[data-ocleet="tabs"]').selectOption('debug');await click('[data-ocleet="read"]');
 assert.match(await page.locator('[data-ocleet="execution-text"]').innerText(),/target = -5/);
 await page.evaluate(()=>document.querySelector('#case-input').textContent='输入 nums = [1,-8] target = -7');
 await page.locator('[data-ocleet="input"]').fill('分析 Case 4');await click('[data-ocleet="send"]');
 await page.waitForFunction(()=>window.sent);assert.match(await page.evaluate(()=>window.sent.messages.at(-1).content),/target = -5/);
 await click('[data-ocleet="read"]');await page.locator('[data-ocleet="input"]').fill('重新分析');await click('[data-ocleet="send"]');
 assert.match(await page.evaluate(()=>window.sent.messages.at(-1).content),/target = -7/);
 console.log('Explicit case read, full result body, snapshot and reread in latest request: passed');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
