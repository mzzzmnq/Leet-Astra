const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../openleet.user.js'), 'utf8');
function setup(saved) {
  const writes = [], requests = [];
  const context = vm.createContext({
    store: { get: () => saved, set: (key,value) => writes.push(JSON.parse(JSON.stringify(value))) },
    GM_xmlhttpRequest: request => { requests.push(request); request.onload({status:200,responseText:'data: {"choices":[{"delta":{"content":"ok","reasoning":"think"}}]}\n\ndata: [DONE]\n\n'}); },
  });
  vm.runInContext(source.slice(source.indexOf('  const DEFAULTS ='), source.indexOf('  /* ----------------------------------------------------------------- skills */')), context);
  vm.runInContext(source.slice(source.indexOf('  function errorText('), source.indexOf('  /* ------------------------------------------------------------------- style */')), context);
  return { context, writes, requests, state: () => JSON.parse(vm.runInContext('JSON.stringify(cfg)', context)) };
}
test('retired OpenCode keys never migrate into a free provider', () => {
  const h=setup({baseUrl:'https://opencode.ai/zen/go/v1', model:'paid-model', apiKey:'old-secret', keys:{opencode:'old-secret',zhipu:'keep-zhipu'},mode:'knowledge',leetnoteToken:'keep-note'});
  const c=h.state();
  assert.equal(c.model,'glm-4.7-flash');
  assert.equal(c.keys.zhipu,'keep-zhipu');
  assert.equal(c.keys.openrouter,'');
  assert.equal(c.apiKey,'');
  assert.equal(c.keys.opencode,undefined);
  assert.equal(c.mode,'knowledge');
  assert.equal(c.leetnoteToken,'keep-note');
  assert.ok(!JSON.stringify(h.writes).includes('old-secret'));
});
test('legacy recognized keys survive and unsupported models become free models', () => {
  const h=setup({baseUrl:'https://open.bigmodel.cn/api/paas/v4/',apiKey:'legacy-zhipu',model:'glm-4.7'});
  assert.equal(h.state().keys.zhipu,'legacy-zhipu');
  assert.equal(h.state().model,'glm-4.7-flash');
});
test('OpenRouter keeps its own key and uses explicit free ID without subscription headers', async () => {
  const h=setup({baseUrl:'https://openrouter.ai/api/v1',keys:{zhipu:'z-secret',openrouter:'r-secret'},model:'cohere/north-mini-code:free'});
  const tokens=[], reasoning=[];
  await h.context.directChat({model:h.state().model,messages:[],provider:{max_price:{prompt:1,completion:2,request:3}}},x=>tokens.push(x),x=>reasoning.push(x));
  assert.equal(h.requests[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(h.requests[0].headers.authorization,'Bearer r-secret');
  assert.equal(h.requests[0].headers['x-opencode-session'],undefined);
  assert.equal(JSON.parse(h.requests[0].data).model,'cohere/north-mini-code:free');
  assert.deepEqual(JSON.parse(h.requests[0].data).provider, {max_price:{prompt:0,completion:0,request:0}});
  assert.deepEqual(tokens,['ok']);
  assert.deepEqual(reasoning,['think']);
  await h.context.checkKey();
  assert.equal(h.requests.length,1);
});
test('unknown endpoint credentials are cleared before choosing a supported endpoint', () => {
  const h=setup({baseUrl:'https://example.org/api',apiKey:'unrelated-secret'});
  assert.equal(h.state().keys.zhipu,'');
  assert.equal(h.state().apiKey,'');
  assert.equal(h.state().baseUrl,'https://open.bigmodel.cn/api/paas/v4');
});

for (const model of ['minimax/minimax-m3.1-flash:free', 'minimax/minimax-m3.1-flash']) {
  test('retired MiniMax selection migrates to a free model: ' + model, () => {
    const h=setup({baseUrl:'https://openrouter.ai/api/v1',model,keys:{openrouter:'keep-key'},mode:'knowledge',leetnoteToken:'keep-note'});
    assert.equal(h.state().model,'nvidia/nemotron-3-ultra-550b-a55b:free');
    assert.equal(h.state().keys.openrouter,'keep-key');
    assert.equal(h.state().mode,'knowledge');
    assert.equal(h.state().leetnoteToken,'keep-note');
    assert.equal(h.writes.at(-1).model,h.state().model);
    assert.equal(h.requests.length,0);
  });
  test('retired or paid MiniMax cannot be requested: ' + model, async () => {
    const h=setup({baseUrl:'https://openrouter.ai/api/v1',keys:{openrouter:'test-key'}});
    await assert.rejects(h.context.directChat({model,messages:[]},()=>{},()=>{}), /免费列表/);
    assert.equal(h.requests.length,0);
  });
}

test('Zhipu requests retain their supported payload without OpenRouter routing fields', async () => {
  const h=setup({keys:{zhipu:'test-key'}});
  await h.context.directChat({model:h.state().model,messages:[]},()=>{},()=>{});
  assert.equal(JSON.parse(h.requests[0].data).provider,undefined);
  assert.equal(JSON.parse(h.requests[0].data).model,'glm-4.7-flash');
});

test('OpenRouter payment errors advise switching free models and retain the service error', () => {
  const h=setup({baseUrl:'https://openrouter.ai/api/v1'});
  const message=h.context.errorText(402, JSON.stringify({error:{message:'Insufficient credits'}}));
  assert.match(message,/切换其他免费模型/);
  assert.match(message,/Insufficient credits/);
  assert.match(h.context.errorText(429,'Rate limit exceeded'),/HTTP 429.*Rate limit exceeded/);
});
