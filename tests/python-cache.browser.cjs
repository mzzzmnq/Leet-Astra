const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=(f,a,o={})=>spawn(f,a,{...o,windowsHide:true});
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'leet-python-test-'));
 const server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><title>Cache test</title>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let context;
 try {
  for(const offline of [false,true]){
   context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true});
   const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
   if(offline) await context.setOffline(true);
   await page.addScriptTag({content:'const PYTHON_TRACE_SOURCE='+JSON.stringify(fs.readFileSync('debugger/python-tracer.py','utf8'))+';\n'+fs.readFileSync('debugger/worker.js','utf8')});
   const result=await page.evaluate(async()=>{const statuses=[];const run=createPythonDebugRun({code:'def solve(x):\n return x+1',input:'4',entry:'solve'},s=>statuses.push(s));return {result:await run.promise,statuses};});
   assert.equal(result.result.result,'5');
   if(offline) assert.ok(result.statuses.every(s=>!s.includes('正在下载')));
   console.log(JSON.stringify({offline,...result}));await context.close();context=null;
  }
 }finally{await context?.close();await new Promise(r=>server.close(r));fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
