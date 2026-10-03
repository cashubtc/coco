import { expect, test } from 'bun:test';
import ts from 'typescript';
import { SessionHistory } from '../history';

function check(
  history: SessionHistory,
  snapshots: { path: string; content: string }[],
  source: string,
) {
  const files = new Map(
    snapshots.map((snapshot) => [snapshot.path.replace('file://', ''), snapshot.content]),
  );
  files.set('/session.ts', history.prefix(source) + source);
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host),
    originalExists = host.fileExists.bind(host);
  host.readFile = (path) => files.get(path) ?? originalRead(path);
  host.fileExists = (path) => files.has(path) || originalExists(path);
  host.getSourceFile = (path, languageVersion) => {
    const source = host.readFile(path);
    return source === undefined
      ? undefined
      : ts.createSourceFile(path, source, languageVersion, true);
  };
  const program = ts.createProgram(['/session.ts'], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === '/session.ts');
}

test('rerun and changed declarations use the latest types without duplicate diagnostics', () => {
  const history = new SessionHistory();
  const first = history.append('const balance = { total: 0 };');
  expect(check(history, [first], 'const balance = { total: 0 }; balance.total;')).toEqual([]);
  const second = history.append('const balance = { updated: "new" };');
  expect(check(history, [first, second], 'balance.updated.toUpperCase();')).toEqual([]);
  expect(check(history, [first, second], 'balance.total;').some((d) => d.code === 2339)).toBe(true);
});

test('history preserves mutable bindings, imports, generic types and unrelated declarations', () => {
  const history = new SessionHistory();
  const first = history.append(
    'let count = 1; const kept = { ok: true }; interface Shape<T> { value: T } class Box<T> { constructor(public value: T) {} }',
  );
  const second = history.append(
    'import { Box as ImportedBox } from "./session-run-0"; const box: Shape<number> = new ImportedBox(2);',
  );
  expect(
    check(
      history,
      [first, second],
      'count++; const next: Shape<string> = new Box("three"); [kept.ok, box.value, next.value];',
    ),
  ).toEqual([]);
  expect(
    check(history, [first, second], 'kept = { ok: false };').some((d) => d.code === 2588),
  ).toBe(true);
  history.reset();
  expect(check(history, [], 'count;').some((d) => d.code === 2304)).toBe(true);
});
