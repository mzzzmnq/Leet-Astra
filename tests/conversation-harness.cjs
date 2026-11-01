const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../openleet.user.js'), 'utf8');
function installConversation(context) {
  vm.runInContext(source.slice(source.indexOf('  /* ---------------------------------------------------- conversation state */'), source.indexOf('  /* ------------------------------------------------------ conversation UI */')), context);
}

function setup(saved = new Map(), options = {}) {
  const rendered = [], requests = [], timers = new Map(), windowEvents = {}, documentEvents = {}, inputEvents = {};
  let timerId = 0;
  const context = vm.createContext({
    IS_DEMO: false,
    location: { hostname: 'leetcode.com', pathname: '/problems/two-sum/', href: 'https://leetcode.com/problems/two-sum/' },
    GM_getValue: (key, fallback) => saved.has(key) ? structuredClone(saved.get(key)) : fallback,
    GM_setValue: (key, value) => {
      if (options.failWrites) throw Error('storage full');
      saved.set(key, structuredClone(value));
    },
    localStorage: { setItem() { throw Error('unexpected fallback'); } },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    window: { addEventListener: (name, fn) => { windowEvents[name] = fn; } },
    document: { hidden: false, addEventListener: (name, fn) => { documentEvents[name] = fn; } },
    inputEl: { value: '', addEventListener: (name, fn) => { inputEvents[name] = fn; } },
    sendBtn: {}, stopReplyBtn: {}, chatStatusEl: {}, problemEl: {}, codeStatusEl: {},
    cfg: { mode: 'hint', model: 'test', includeCode: true },
    readProblem: () => ({ title: 'Problem' }),
    readChatExecution: () => ({ testCases: [], runResult: '' }),
    readCode: () => ({ code: 'CURRENT_CODE', codeSource: 'model' }),
    resetMessages: () => { rendered.length = 0; },
    addMessage: (role, content) => { rendered.push({ role, content }); },
    renderProblemChip() {}, setStatus() {},
    addAssistant: () => {
      const bubble = { role: 'assistant', content: '' };
      rendered.push(bubble);
      return { onDelta: delta => { bubble.content += delta; }, onReasoning() {}, done() {}, fail: error => { bubble.error = error; } };
    },
    directChat: (payload, onDelta, onReasoning, control) => new Promise((resolve, reject) => {
      const request = { payload, onDelta, onReasoning, resolve, reject, aborted: false };
      control.cancel = () => { request.aborted = true; reject(new Error('cancelled')); };
      requests.push(request);
    }),
  });
  vm.runInContext(source.slice(source.indexOf('  const store ='), source.indexOf('  /* ----------------------------------------------------------------- config */')), context);
  vm.runInContext(source.slice(source.indexOf('  function currentSlug()'), source.indexOf('  function readProblem()')), context);
  vm.runInContext(source.slice(source.indexOf('  function readChatContext('), source.indexOf('  /* ------------------------------------------------------------- upstream API */')), context);
  vm.runInContext(source.slice(source.indexOf('  const BASE_SYSTEM ='), source.indexOf('  /* ---------------------------------------------------------------- markdown */')), context);
  installConversation(context);
  vm.runInContext(source.slice(source.indexOf('  function renderCodeChip('), source.indexOf('  const WELCOME =')), context);
  vm.runInContext(source.slice(source.indexOf('  function buildSystem('), source.indexOf('  /* ---------------------------------------------------------- LeetNote export */')), context);
  vm.runInContext(source.slice(source.indexOf('  inputEl.addEventListener("input"'), source.indexOf('  apiKeyInput.addEventListener')), context);
  context.syncConversation(true);
  return {
    context, rendered, requests, saved, timers,
    key: () => context.conversationKey(),
    state: () => JSON.parse(vm.runInContext('JSON.stringify({ history, busy, draft: conversation.draft })', context)),
    send: text => { context.inputEl.value = text; return context.onSend(); },
    type: text => { context.inputEl.value = text; inputEvents.input(); },
    navigate: (slug, sync = true) => {
      context.location.pathname = `/problems/${slug}/`;
      if (sync) context.syncConversation();
    },
    close: () => windowEvents.pagehide(),
    hide: () => { context.document.hidden = true; documentEvents.visibilitychange(); },
    flushTimers: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
  };
}
module.exports = { installConversation, setup };
