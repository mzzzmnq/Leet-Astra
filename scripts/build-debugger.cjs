// Keep the installable userscript self-contained; source modules live in debugger/.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const block = [
  '  // BEGIN GENERATED DEBUGGER',
  '  const PYTHON_TRACE_SOURCE = ' + JSON.stringify(read('debugger/python-tracer.py')) + ';',
  read('debugger/testcase-reader.js'),
  read('debugger/worker.js'),
  read('debugger/ui.js'),
  read('ui/theme.js'),
  '  installThemeSync(panel, launcher);',
  '  const pythonDebugger = installPythonDebugger();',
  '  // END GENERATED DEBUGGER',
].join('\n');
const file = path.join(root, 'openleet.user.js');
const source = read('openleet.user.js');
const output = source.replace(/  \/\/ BEGIN GENERATED DEBUGGER[\s\S]*?  \/\/ END GENERATED DEBUGGER/, () => block);
if (process.argv.includes('--check')) {
  if (output !== source) { process.stderr.write('Debugger bundle is stale. Run node scripts/build-debugger.cjs\n'); process.exitCode = 1; }
} else fs.writeFileSync(file, output);
