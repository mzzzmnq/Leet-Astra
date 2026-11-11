const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../openleet.user.js'),'utf8');
test('action buttons send immediately and preserve Python draft; knowledge only focuses input',()=>{
 let click,sends=0,focus=0;
 const context={tabsEl:{addEventListener:(_,fn)=>click=fn},busy:false,cfg:{},saveCfg(){},renderTabs(){},inputEl:{value:'Python draft',focus(){focus++}},SKILLS:{hint:{quick:'提示'}},conversation:{},saveConversation(){},onSend(){sends++;assert.equal(context.inputEl.value,'提示');return Promise.resolve()}};
 vm.runInNewContext(source.slice(source.indexOf('  tabsEl.addEventListener("click"'),source.indexOf('  panel.addEventListener("keydown"')),context);
 click({target:{closest:()=>({dataset:{mode:'hint'}})}});
 assert.equal(sends,1);assert.equal(context.inputEl.value,'Python draft');assert.equal(context.conversation.draft,'Python draft');
 click({target:{closest:()=>({dataset:{mode:'knowledge'}})}});assert.equal(sends,1);assert.equal(focus,1);
 context.busy=true;click({target:{closest:()=>({dataset:{mode:'hint'}})}});assert.equal(sends,1);
});
