import * as monaco from 'monaco-editor/editor/editor.api.js';
import {
  typescriptDefaults,
  getTypeScriptWorker,
  ScriptTarget,
  ModuleKind,
  ModuleResolutionKind,
} from 'monaco-editor/languages/features/typescript/register.js';
import type ts from 'typescript';
import { libs, paths } from 'virtual:playground-types';
import { SessionHistory } from './history';

/** Ask TypeScript about a hidden document importing the latest session bindings
 * plus the editable snippet. Positions are translated back to the visible model.
 */
export function intellisense(model: monaco.editor.ITextModel) {
  typescriptDefaults.setCompilerOptions({
    target: ScriptTarget.ESNext,
    lib: ['esnext', 'webworker'],
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    strict: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    baseUrl: 'file:///',
    paths,
  });
  typescriptDefaults.setExtraLibs(
    libs.map((lib) => ({ filePath: lib.path, content: lib.content })),
  );
  typescriptDefaults.setModeConfiguration({
    completionItems: false,
    hovers: false,
    signatureHelp: false,
    diagnostics: false,
  });
  const history = new SessionHistory();
  const snapshots: monaco.IDisposable[] = [];
  const combined = monaco.editor.createModel(
    '',
    'typescript',
    monaco.Uri.parse('file:///session.ts'),
  );
  let prefix = '';
  let revision = 0;
  let timer: ReturnType<typeof setTimeout>;
  const update = () => {
    prefix = history.prefix(model.getValue());
    combined.setValue(prefix + model.getValue());
    revision++;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void diagnostics();
    }, 250);
  };
  const service = async () => (await getTypeScriptWorker())(combined.uri);
  const position = (point: monaco.Position) => prefix.length + model.getOffsetAt(point);
  const parts = (items?: readonly ts.SymbolDisplayPart[]) =>
    items?.map((item) => item.text).join('') ?? '';
  const range = (start: number, length: number) => {
    const from = model.getPositionAt(Math.max(0, start - prefix.length));
    const to = model.getPositionAt(Math.max(0, start + length - prefix.length));
    return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
  };
  type Completion = monaco.languages.CompletionItem & { sessionPosition: number; revision: number };
  const completion = monaco.languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ['.', '"', "'", '/'],
    async provideCompletionItems(target, point, _context, token) {
      if (target !== model) return;
      const version = revision;
      const worker = await service();
      const result = (await worker.getCompletionsAtPosition(
        combined.uri.toString(),
        position(point),
      )) as ts.CompletionInfo | undefined;
      if (token.isCancellationRequested || version !== revision) return;
      const word = model.getWordUntilPosition(point);
      const kinds: Record<string, monaco.languages.CompletionItemKind> = {
        method: monaco.languages.CompletionItemKind.Method,
        function: monaco.languages.CompletionItemKind.Function,
        property: monaco.languages.CompletionItemKind.Property,
        class: monaco.languages.CompletionItemKind.Class,
        interface: monaco.languages.CompletionItemKind.Interface,
        keyword: monaco.languages.CompletionItemKind.Keyword,
        module: monaco.languages.CompletionItemKind.Module,
      };
      return {
        suggestions:
          result?.entries.map((entry) => ({
            label: entry.name,
            insertText: entry.insertText ?? entry.name,
            kind: kinds[entry.kind] ?? monaco.languages.CompletionItemKind.Variable,
            sortText: entry.sortText,
            sessionPosition: position(point),
            revision: version,
            range: new monaco.Range(
              point.lineNumber,
              word.startColumn,
              point.lineNumber,
              word.endColumn,
            ),
          })) ?? [],
      };
    },
    async resolveCompletionItem(item, token) {
      const entry = item as Completion;
      if (entry.revision !== revision) return item;
      const worker = await service();
      const label = typeof item.label === 'string' ? item.label : item.label.label;
      const details = (await worker.getCompletionEntryDetails(
        combined.uri.toString(),
        entry.sessionPosition,
        label,
      )) as ts.CompletionEntryDetails | undefined;
      if (!details || token.isCancellationRequested || entry.revision !== revision) return item;
      return {
        ...item,
        detail: parts(details.displayParts),
        documentation: { value: parts(details.documentation) },
      };
    },
  });
  const hover = monaco.languages.registerHoverProvider('typescript', {
    async provideHover(target, point, token) {
      if (target !== model) return;
      const version = revision;
      const worker = await service();
      const result = (await worker.getQuickInfoAtPosition(
        combined.uri.toString(),
        position(point),
      )) as ts.QuickInfo | undefined;
      if (!result || token.isCancellationRequested || version !== revision) return;
      return {
        range: range(result.textSpan.start, result.textSpan.length),
        contents: [
          { value: `\`\`\`typescript\n${parts(result.displayParts)}\n\`\`\`` },
          { value: parts(result.documentation) },
        ],
      };
    },
  });
  const signature = monaco.languages.registerSignatureHelpProvider('typescript', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(target, point, token) {
      if (target !== model) return;
      const version = revision;
      const worker = await service();
      const result = (await worker.getSignatureHelpItems(
        combined.uri.toString(),
        position(point),
        {},
      )) as ts.SignatureHelpItems | undefined;
      if (!result || token.isCancellationRequested || version !== revision) return;
      return {
        value: {
          activeSignature: result.selectedItemIndex,
          activeParameter: result.argumentIndex,
          signatures: result.items.map((item) => ({
            label:
              parts(item.prefixDisplayParts) +
              item.parameters
                .map((parameter) => parts(parameter.displayParts))
                .join(parts(item.separatorDisplayParts)) +
              parts(item.suffixDisplayParts),
            documentation: { value: parts(item.documentation) },
            parameters: item.parameters.map((parameter) => ({
              label: parts(parameter.displayParts),
              documentation: { value: parts(parameter.documentation) },
            })),
          })),
        },
        dispose() {},
      };
    },
  });
  const message = (value: string | { messageText: string; next?: readonly unknown[] }): string =>
    typeof value === 'string'
      ? value
      : value.messageText +
        (value.next?.map((item) => `\n${message(item as typeof value)}`).join('') ?? '');
  async function diagnostics() {
    const version = revision;
    try {
      const worker = await service();
      const results = await Promise.all([
        worker.getSyntacticDiagnostics(combined.uri.toString()),
        worker.getSemanticDiagnostics(combined.uri.toString()),
      ]);
      if (version !== revision || model.isDisposed()) return;
      monaco.editor.setModelMarkers(
        model,
        'session',
        results
          .flat()
          .filter((d) => {
            if (d.start === undefined || d.start < prefix.length) return false;
            // Imported classes/enums/namespaces carry both value and type
            // identity. Their session value is mutable, unlike an ES import.
            return !(
              d.code === 2632 &&
              history.permitsImportedAssignment(
                combined.getValue().slice(d.start, d.start + (d.length ?? 0)),
                model.getValue(),
              )
            );
          })
          .map((d) => {
            const span = range(d.start!, d.length ?? 1);
            return {
              ...span,
              startLineNumber: span.startLineNumber,
              startColumn: span.startColumn,
              endLineNumber: span.endLineNumber,
              endColumn: span.endColumn,
              severity:
                d.category === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
              message: message(d.messageText),
              code: String(d.code),
            };
          }),
      );
    } catch (error) {
      console.error('TypeScript language service:', error);
    }
  }
  const change = model.onDidChangeContent(update);
  update();
  return {
    append(source: string) {
      const snapshot = history.append(source);
      snapshots.push(typescriptDefaults.addExtraLib(snapshot.content, snapshot.path));
      update();
    },
    reset() {
      history.reset();
      snapshots.splice(0).forEach((snapshot) => snapshot.dispose());
      update();
    },
    dispose() {
      snapshots.splice(0).forEach((snapshot) => snapshot.dispose());
      clearTimeout(timer);
      change.dispose();
      completion.dispose();
      hover.dispose();
      signature.dispose();
      combined.dispose();
    },
  };
}
