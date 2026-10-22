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
  await h.context.directChat({model:h.state().model,messages:[]},x=>tokens.push(x),x=>reasoning.push(x));
  assert.equal(h.requests[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(h.requests[0].headers.authorization,'Bearer r-secret');
  assert.equal(h.requests[0].headers['x-opencode-session'],undefined);
  assert.equal(JSON.parse(h.requests[0].data).model,'cohere/north-mini-code:free');
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
