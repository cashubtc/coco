import { describe, expect, test } from 'bun:test';
import { Evaluator } from '../evaluator';
import { format } from '../format';
const evaluator = () =>
  new Evaluator({ answer: 42 }, async (name) => ({ default: name, answer: 42 }));
describe('persistent browser evaluator', () => {
  test('invalid declarations fail before any session mutation', async () => {
    for (const source of [
      'const missing;',
      'let value = 1; { let inner = 2; var inner = 3; }',
      'let eval = 1;',
      'let arguments = 1;',
    ]) {
      const session = evaluator();
      await session.execute('let untouched = 0;');
      let prepared = false;
      await expect(
        session.execute(`untouched++; ${source}`, () => {
          prepared = true;
        }),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(prepared).toBe(false);
      expect(await session.execute('untouched')).toBe(0);
    }
  });
  test('nested class static blocks keep their var declarations local', async () => {
    const session = evaluator();
    expect(
      await session.execute(`
      let result;
      { class Box { static { var privateValue = 7; this.value = privateValue; } }
        result = Box.value; }
      [result, typeof privateValue];
    `),
    ).toEqual([7, 'undefined']);
    expect(
      await session.execute(`
      (class { static { var privateValue = 8; this.value = privateValue; } }).value;
    `),
    ).toBe(8);
  });
  test('catch parameters receive var initializers without changing the outer binding', async () => {
    const session = evaluator();
    expect(
      await session.execute(`
      var caught = 1; let inside;
      try { throw 2; } catch (caught) { var caught = 3; inside = caught; }
      [caught, inside];
    `),
    ).toEqual([1, 3]);
  });
  test('static imports are initialized before the snippet body', async () => {
    const session = evaluator();
    expect(
      await session.execute(`
      const first = imported;
      import { answer as imported } from 'example';
      first;
    `),
    ).toBe(42);
  });
  test('nested bindings cannot shadow the compiler helper', async () => {
    const session = evaluator();
    expect(
      await session.execute(`
      async function load(__cocoPlayground) { return (await import('example')).answer; }
      await load(null);
    `),
    ).toBe(42);
  });
  test('rerunning a buffer replaces its declarations without clearing other session state', async () => {
    const session = evaluator();
    await session.execute('let runs = 0; const unrelated = { kept: true };');
    const source = 'const balance = ++runs; balance;';
    expect(await session.execute(source)).toBe(1);
    expect(await session.execute(source)).toBe(2);
    expect(await session.execute('[balance, unrelated.kept]')).toEqual([2, true]);
  });
  test('closures observe later assignments and top-level await', async () => {
    const session = evaluator();
    expect(
      await session.execute(
        'let count: number = 1; const next = () => ++count; await Promise.resolve(); next();',
      ),
    ).toBe(2);
    expect(await session.execute('count = 10; next();')).toBe(11);
    expect(await session.execute('count')).toBe(11);
  });
  test('hoisted functions, var inside control flow, classes and loop bindings', async () => {
    const session = evaluator();
    expect(
      await session.execute(
        'var value = sum(2); function sum(n) { return n + 3; } if (true) { var nested = 8; } class Box { get() { return value; } }',
      ),
    ).toBeUndefined();
    expect(await session.execute('value = 12; new Box().get() + nested')).toBe(20);
    expect(
      await session.execute(
        'for (var i = 0; i < 3; i++) { var item = i; } for (var key of [4, 5]) {} [i, item, key]',
      ),
    ).toEqual([3, 2, 5]);
    expect(await session.execute('if (true) var single = 3; else var single = 4; single')).toBe(3);
    await session.execute('for (let local = 0; local < 2; local++) {}');
    expect(await session.execute('typeof local')).toBe('undefined');
  });
  test('destructuring defaults retain persistent references, including rest and computed keys', async () => {
    const session = evaluator();
    await session.execute(
      'let [n, callback = () => n, ...rest] = [1, undefined, 3, 4]; const { ["x"]: { y = 6 }, ...others } = { x: {}, z: 7 };',
    );
    expect(await session.execute('n = 9; [callback(), rest, y, others]')).toEqual([
      9,
      [3, 4],
      6,
      { z: 7 },
    ]);
  });
  test('const protection, replacements, same-snippet duplicates, TDZ and var redeclarations', async () => {
    const session = evaluator();
    await session.execute('const fixed = 3; var repeat = 1;');
    await expect(session.execute('fixed = 4')).rejects.toThrow('constant');
    expect(await session.execute('let fixed = 5; fixed++; fixed')).toBe(6);
    await expect(session.execute('let duplicate = 1; const duplicate = 2;')).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(await session.execute('const duplicate = 3; duplicate')).toBe(3);
    await expect(session.execute('let later = later')).rejects.toThrow('before initialization');
    await expect(session.execute('later')).rejects.toThrow('before initialization');
    expect(await session.execute('var repeat; repeat')).toBe(1);
    expect(await session.execute('var repeat = 4; repeat')).toBe(4);
  });
  test('replaced bindings remain visible to earlier closures and failed declarations can be retried', async () => {
    const session = evaluator();
    await session.execute('let value = 1; const read = () => value;');
    expect(await session.execute('const value = 9; read();')).toBe(9);
    await expect(session.execute('value = 10;')).rejects.toThrow('constant');
    await expect(
      session.execute('const failed = (() => { throw new Error("retry"); })();'),
    ).rejects.toThrow('retry');
    expect(await session.execute('const failed = 10; failed;')).toBe(10);
    const imported = 'import { answer as result } from "example"; result;';
    expect(await session.execute(imported)).toBe(42);
    expect(await session.execute(imported)).toBe(42);
  });
  test('imports, erased types, global shadowing and module identity', async () => {
    const session = evaluator();
    expect(
      await session.execute(
        'import { answer as imported } from "example"; interface Shape { x: number }; const shape: Shape = { x: imported }; shape.x;',
      ),
    ).toBe(42);
    expect(
      await session.execute('import thing from "other"; (await import("other")).default === thing'),
    ).toBe(true);
    expect(await session.execute('const answer = 7; answer')).toBe(7);
    expect(await session.execute('import * as namespace from "space"; namespace.answer')).toBe(42);
  });
  test('syntax failures do not reserve bindings; runtime failures retain prior mutations', async () => {
    const session = evaluator();
    let prepared = false;
    await expect(
      session.execute('const broken = ;', () => {
        prepared = true;
      }),
    ).rejects.toThrow();
    expect(prepared).toBe(false);
    expect(await session.execute('const broken = 4; broken')).toBe(4);
    await expect(
      session.execute('let retained = 1; retained++; throw new Error("boom");', () => {
        prepared = true;
      }),
    ).rejects.toThrow('boom');
    expect(prepared).toBe(true);
    expect(await session.execute('retained')).toBe(2);
    await expect(session.execute('export const x = 1')).rejects.toThrow('without export');
  });
  test('function-local bindings stay local and async callbacks share the session scope', async () => {
    const session = evaluator();
    await session.execute(
      'let changed = 0; function local() { var privateValue = 2; return privateValue; } const deferred = async () => { await Promise.resolve(); changed++; };',
    );
    expect(
      await session.execute('await deferred(); [changed, local(), typeof privateValue]'),
    ).toEqual([1, 2, 'undefined']);
  });
});
test('formatting handles circular values, bigint, errors and getters without invoking them', () => {
  const value: Record<string, unknown> = { amount: 42n };
  value.self = value;
  Object.defineProperty(value, 'danger', {
    enumerable: true,
    get() {
      throw new Error('do not invoke');
    },
  });
  expect(format(value)).toContain('[Circular]');
  expect(format(value)).toContain('[Getter]');
  expect(format(value)).toContain('42n');
  expect(format(new Error('failed'))).toContain('failed');
  expect(format('a'.repeat(100000)).length).toBeLessThanOrEqual(12000);
});
