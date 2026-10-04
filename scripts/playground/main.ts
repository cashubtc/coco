import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import { intellisense } from './intellisense';
import { PlaygroundRuntime } from './runtime';
import { examples } from './examples';
import type { Output } from './protocol';
import './style.css';

globalThis.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === 'typescript' || label === 'javascript' ? new TypeScriptWorker() : new EditorWorker(),
};
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const runButton = element<HTMLButtonElement>('run');
const resetButton = element<HTMLButtonElement>('reset');
const select = element<HTMLSelectElement>('examples');
const outputPane = element<HTMLDivElement>('output');
const empty = outputPane.firstElementChild!.cloneNode(true);
monaco.editor.defineTheme('coco', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7F9585' },
    { token: 'keyword', foreground: 'BEADDE' },
    { token: 'string', foreground: 'BBDAA6' },
    { token: 'number', foreground: 'E0C191' },
    { token: 'type.identifier', foreground: '9FC8D9' },
  ],
  colors: {
    'editor.background': '#151c17',
    'editor.foreground': '#d3e0d7',
    'editorLineNumber.foreground': '#526557',
    'editorLineNumber.activeForeground': '#a0b9a7',
    'editor.lineHighlightBackground': '#1c271f',
    'editor.selectionBackground': '#365441',
    'editorCursor.foreground': '#bce8c8',
    'editorWidget.background': '#202c24',
    'editorWidget.border': '#405448',
    focusBorder: '#89b699',
  },
});
const model = monaco.editor.createModel(
  examples.balances!.source,
  'typescript',
  monaco.Uri.parse('file:///snippet.ts'),
);
const editor = monaco.editor.create(element('editor'), {
  model,
  theme: 'coco',
  automaticLayout: true,
  fontSize: 13,
  lineHeight: 23,
  fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 20 },
  renderLineHighlight: 'line',
  wordWrap: 'on',
  tabSize: 2,
  folding: true,
  suggest: { showWords: false },
  ariaLabel: 'TypeScript snippet editor',
});
const types = intellisense(model);
editor.onDidChangeCursorPosition(({ position }) => {
  element('cursor').textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
});
for (const [key, example] of Object.entries(examples)) select.add(new Option(example.label, key));
select.onchange = () => {
  if (examples[select.value]) {
    editor.setValue(examples[select.value]!.source);
    editor.focus();
  }
  select.value = '';
};
let tab: 'console' | 'events' = 'console';
let runNumber = 0;
let session = 1;
let epoch = 0;
let ready = false;
const entries: { output: Output; run: number | 'background'; session: number; time: string }[] = [];
function render() {
  const visible = entries.filter(
    (entry) => (entry.output.level === 'event') === (tab === 'events'),
  );
  outputPane.replaceChildren();
  if (!visible.length) {
    if (tab === 'console') outputPane.append(empty.cloneNode(true));
    else {
      const message = document.createElement('p');
      message.className = 'empty';
      message.textContent = 'Core events appear here as you use the public API.';
      outputPane.append(message);
    }
  }
  for (const entry of visible) {
    const row = document.createElement('article');
    row.className = 'entry';
    row.dataset.level = entry.output.level;
    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    const label = document.createElement('span');
    label.textContent = entry.output.level;
    const context = document.createElement('span');
    context.textContent = `S${entry.session} · ${entry.run === 'background' ? 'Background' : `Run ${entry.run}`}`;
    const time = document.createElement('time');
    time.textContent = entry.time;
    meta.append(label, context, time);
    const value = document.createElement('pre');
    value.textContent = entry.output.text;
    row.append(meta, value);
    outputPane.append(row);
  }
  element('console-count').textContent = String(
    entries.filter((entry) => entry.output.level !== 'event').length,
  );
  element('events-count').textContent = String(
    entries.filter((entry) => entry.output.level === 'event').length,
  );
  outputPane.scrollTop = outputPane.scrollHeight;
}
let renderPending = false;
function add(output: Output, run: number | 'background' = runNumber) {
  entries.push({
    output,
    run,
    session,
    time: new Date().toLocaleTimeString([], { hour12: false }),
  });
  // Bound retained output across all runs and background activity.
  while (
    entries.length > 500 ||
    entries.reduce((total, entry) => total + entry.output.text.length, 0) > 500000
  )
    entries.shift();
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      render();
    });
  }
}
function status(text: string) {
  element('status').textContent = `Session ${session} · ${text}`;
}
const runtime = new PlaygroundRuntime(
  (output, id) => add(output, id ?? 'background'),
  () => {
    ready = false;
    runButton.disabled = true;
    status('Reset needed');
  },
);
async function initialize(reset: boolean) {
  const current = ++epoch;
  ready = false;
  runButton.disabled = true;
  resetButton.disabled = true;
  status(reset ? 'Resetting…' : 'Starting…');
  if (reset) {
    session++;
    runNumber = 0;
    types.reset();
  }
  try {
    await (reset ? runtime.reset() : runtime.start());
    if (current !== epoch) return;
    ready = true;
    status('Ready');
    runButton.disabled = false;
    if (reset)
      add({
        level: 'info',
        text: 'Fresh session. Variables, timers, module state and wallet data cleared.',
      });
  } catch (error) {
    if (current === epoch) {
      status('Reset needed');
      add({ level: 'error', text: String(error) });
    }
  } finally {
    if (current === epoch) resetButton.disabled = false;
  }
}
async function run() {
  const source = editor.getValue().trim();
  if (!source || !ready || runButton.disabled) return;
  if (source === '.reset' || source === ':reset') return initialize(true);
  if (source === '.clear') {
    entries.length = 0;
    render();
    return;
  }
  if (source === '.help' || source === '.examples') {
    add({
      level: 'info',
      text:
        'Run: Ctrl / ⌘ Enter. Reset: Shift Ctrl / ⌘ Enter.\nGlobals: coco, core, public core exports, assert, console.\nImports: @cashu/coco-core, /adapter, /plugin (workspace source).\nCommands: .reset, .clear, .help, .examples, .example <name>.\nExamples: ' +
        Object.keys(examples).join(', '),
    });
    return;
  }
  if (source.startsWith('.example ')) {
    const example = examples[source.slice(9).trim()];
    if (example) editor.setValue(example.source);
    else add({ level: 'error', text: 'Unknown example. Use the example menu.' });
    return;
  }
  const current = epoch;
  runNumber++;
  runButton.disabled = true;
  status('Running…');
  try {
    if (await runtime.execute(source)) types.append(source);
  } catch (error) {
    if (current === epoch) add({ level: 'error', text: String(error) });
  } finally {
    if (current === epoch) {
      runButton.disabled = !ready;
      status(ready ? 'Ready' : 'Reset needed');
    }
  }
}
runButton.onclick = () => {
  void run();
};
resetButton.onclick = () => {
  void initialize(true);
};
element('clear').onclick = () => {
  entries.length = 0;
  render();
};
for (const type of ['console', 'events'] as const)
  element(`${type}-tab`).onclick = () => {
    tab = type;
    for (const name of ['console', 'events'])
      element(`${name}-tab`).setAttribute('aria-selected', String(name === tab));
    outputPane.setAttribute('aria-label', `${type === 'console' ? 'Console' : 'Events'} output`);
    render();
  };
editor.addAction({
  id: 'playground.run',
  label: 'Run snippet',
  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
  run: () => run(),
});
editor.addAction({
  id: 'playground.reset',
  label: 'Reset session',
  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
  run: () => {
    if (!resetButton.disabled) return initialize(true);
  },
});
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !editor.hasTextFocus()) {
    event.preventDefault();
    if (event.shiftKey) {
      if (!resetButton.disabled) void initialize(true);
    } else void run();
  }
});
window.addEventListener('pagehide', () => {
  runtime.dispose();
  types.dispose();
  editor.dispose();
  model.dispose();
});
window.addEventListener('pageshow', (event) => {
  // Back/forward cache restores the page after pagehide disposed its session.
  if (event.persisted) window.location.reload();
});
// Browser tests inspect Monaco and set buffers without relying on pixel coordinates.
if (import.meta.env.MODE === 'test')
  Object.assign(window, { __playground: { editor, monaco, runtime } });
void initialize(false);
