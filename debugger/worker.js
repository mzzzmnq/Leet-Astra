// Runs in a new Worker for each case. No model credentials or page data are passed.
function pythonDebugWorker() {
  let engine;
  self.onmessage = async ({ data }) => {
    try {
      if (data.type === 'load') {
        importScripts('https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js');
        engine = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/' });
        engine.runPython(data.engine);
        self.postMessage({ type: 'ready' });
      } else if (data.type === 'run' && engine) {
        engine.globals.set('_oc_code', data.code);
        engine.globals.set('_oc_case', data.input);
        engine.globals.set('_oc_entry', data.entry);
        engine.globals.set('_oc_expected', data.expected || '');
        const result = engine.runPython('import json\njson.dumps(trace_code(_oc_code, _oc_case, _oc_entry, _oc_expected), ensure_ascii=False)');
        self.postMessage({ type: 'result', result: JSON.parse(result) });
      }
    } catch (error) {
      self.postMessage({ type: 'error', error: String(error.message || error) });
    }
  };
}

function createPythonDebugRun(payload, onStatus) {
  let worker, timer, blobUrl, settled = false, rejectRun;
  const cleanup = () => {
    clearTimeout(timer);
    worker?.terminate();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  };
  const promise = new Promise((resolve, reject) => {
    rejectRun = reject;
    const fail = message => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error(message));
    };
    try {
      blobUrl = URL.createObjectURL(new Blob(['(' + pythonDebugWorker.toString() + ')();'], { type: 'text/javascript' }));
      worker = new Worker(blobUrl);
      worker.onerror = event => { event.preventDefault(); fail('Python 执行线程加载失败。请检查浏览器是否允许 Worker，以及是否能访问 cdn.jsdelivr.net。'); };
      timer = setTimeout(() => fail('Python 环境加载超过 90 秒，请检查网络后重试。'), 90000);
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.type === 'ready') {
          clearTimeout(timer);
          onStatus('正在执行当前用例并记录变量…');
          timer = setTimeout(() => fail('代码执行超过 8 秒，已终止执行线程。请检查死循环或缩小用例。'), 8000);
          worker.postMessage({ type: 'run', ...payload });
        } else if (data.type === 'result') {
          settled = true; cleanup(); resolve(data.result);
        } else if (data.type === 'error') fail(data.error);
      };
      onStatus('首次运行需下载 Python 环境（约十余 MB），正在加载…');
      worker.postMessage({ type: 'load', engine: PYTHON_TRACE_SOURCE });
    } catch (error) { fail('无法创建 Python 执行线程：' + error.message); }
  });
  return { promise, cancel() {
    if (settled) return;
    settled = true; cleanup(); rejectRun(new Error('已停止调试。'));
  } };
}
