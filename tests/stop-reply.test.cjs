const test = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./conversation-harness.cjs');
test('stop retains partial content, aborts once, persists and permits another request', async () => {
 const h=setup(); const first=h.send('first'); h.requests[0].onDelta('partial');
 h.context.stopReply(); h.context.stopReply(); await first;
 assert.equal(h.requests[0].aborted,true);
 assert.equal(h.state().busy,false);
 assert.equal(h.context.stopReplyBtn.hidden,true);
 assert.equal(h.state().history[1].status,'interrupted');
 h.requests[0].onDelta('late'); assert.equal(h.state().history[1].content,'partial');
 const restored=setup(h.saved); assert.equal(restored.state().history[1].content,'partial');
 const second=h.send('second'); h.requests[1].onDelta('answer'); h.requests[1].resolve(); await second;
 assert.equal(h.state().history[3].content,'answer');
});
test('stop before first token, route change, clear and pagehide all abort active transport', async () => {
 for(const action of [h=>h.context.stopReply(),h=>h.navigate('other'),h=>h.context.clearConversation(),h=>h.close()]) {
  const h=setup(); const pending=h.send('question'); action(h); await pending;
  assert.equal(h.requests[0].aborted,true); assert.equal(h.state().busy,false);
 }
});
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('network cancellation calls GM abort and suppresses late stream/onload callbacks', async () => {
 const source=fs.readFileSync(path.join(__dirname,'../openleet.user.js'),'utf8');
 let callbacks,abortCount=0; const deltas=[];
 const context=vm.createContext({cfg:{keys:{zhipu:'test'}},currentProvider:()=> 'zhipu',chatUrl:()=> 'https://example.org',
 GM_xmlhttpRequest:opts=>{callbacks=opts;return {abort(){abortCount++;opts.onerror();}};}});
 vm.runInContext(source.slice(source.indexOf('  function errorText('),source.indexOf('  // Presence only;')),context);
 const control={}; const pending=context.directChat({},x=>deltas.push(x),()=>{},control);
 const rejected=assert.rejects(pending,{name:'AbortError'});
 control.cancel();control.cancel();
 callbacks.onprogress({responseText:'data: {"choices":[{"delta":{"content":"late"}}]}\n\n'});
 callbacks.onload({status:200,responseText:'{"choices":[{"message":{"content":"late"}}]}'});
 await rejected; assert.equal(abortCount,1); assert.deepEqual(deltas,[]);
});
