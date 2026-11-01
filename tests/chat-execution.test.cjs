const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
test('execution reader captures visible result text and excludes hidden panels and assistant',()=>{
 const node=(text,hidden=false,label='测试结果')=>({isConnected:true,innerText:text,closest:()=>hidden?{}:null,getClientRects:()=>[{}],getAttribute:k=>k==='role'?'tabpanel':k==='aria-label'?label:'',contains:()=>false});
 const panels=[node('Runtime Error\n输入 [1,2]\nIndexError'),node('stale',true),node('unrelated',false,'题目')];
 const context=vm.createContext({document:{querySelectorAll:s=>s==='span, button, div'?[]:panels,getElementById:()=>null}});
 vm.runInContext(fs.readFileSync('debugger/testcase-reader.js','utf8'),context);
 context.readDebugTestCases=()=>[{input:'[1,2]',source:'visible-testcase'}];
 const result=context.readChatExecution();assert.match(result.runResult,/IndexError/);assert.doesNotMatch(result.runResult,/stale|unrelated/);assert.equal(result.testCases[0].input,'[1,2]');
 panels[0].innerText='Wrong Answer';assert.equal(context.readChatExecution().runResult,'Wrong Answer');
});
