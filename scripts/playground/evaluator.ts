import { compile, type Declaration } from './compile';

type Cell = { kind: Declaration['kind']; initialized: boolean; value: unknown };
export class Evaluator {
  private readonly cells = new Map<string, Cell>();
  constructor(
    private readonly globals: Record<string, unknown>,
    private readonly importModule: (name: string) => Promise<unknown>,
  ) {}
  private createScope(globals: Record<string, unknown>): object {
    return new Proxy(Object.create(null), {
      has: (_, name) =>
        typeof name === 'string' && (this.cells.has(name) || Object.hasOwn(globals, name)),
      get: (_, name) => {
        if (name === Symbol.unscopables) return undefined;
        const cell = this.cells.get(String(name));
        if (!cell) return globals[String(name)];
        if (!cell.initialized)
          throw new ReferenceError(`Cannot access '${String(name)}' before initialization`);
        return cell.value;
      },
      set: (_, name, value) => {
        const cell = this.cells.get(String(name));
        if (!cell) throw new TypeError(`Cannot assign to playground global '${String(name)}'.`);
        if (!cell.initialized)
          throw new ReferenceError(`Cannot access '${String(name)}' before initialization`);
        if (cell.kind === 'const') throw new TypeError('Assignment to constant variable.');
        cell.value = value;
        return true;
      },
    });
  }
  async execute(
    source: string,
    prepared: () => void = () => {},
    executionGlobals: Record<string, unknown> = {},
  ): Promise<unknown> {
    const { code, declarations, internal, imports } = compile(source);
    // Parse the executable body before adding any bindings, including syntax checks
    // that TypeScript's transpile-only API does not perform.
    const execute = new Function(
      '__cocoPlaygroundScope',
      internal,
      `with (__cocoPlaygroundScope) { return (async function() { "use strict";\n${code}\n}).call(undefined); }`,
    );
    const pending = new Map<string, Cell>();
    for (const { name, kind } of declarations) {
      const duplicate = pending.get(name);
      if (duplicate && (duplicate.kind !== 'var' || kind !== 'var'))
        throw new SyntaxError(`Identifier '${name}' has already been declared in this snippet.`);
      if (duplicate) continue;
      const previous = this.cells.get(name);
      // Lexical declarations create a fresh binding on rerun. Reuse only var
      // cells, where an uninitialized redeclaration must retain the old value.
      pending.set(
        name,
        kind === 'var' && previous?.kind === 'var'
          ? previous
          : { kind, initialized: kind === 'var', value: undefined },
      );
    }
    const modules: unknown[] = [];
    const loaded = new Map<string, unknown>();
    for (const { specifier, names } of imports) {
      if (!loaded.has(specifier)) loaded.set(specifier, await this.importModule(specifier));
      const module = loaded.get(specifier);
      for (const name of names) {
        if (module == null || !Object.hasOwn(module, name))
          throw new SyntaxError(
            `Module '${specifier}' does not provide an export named '${name}'.`,
          );
      }
      modules.push(module);
    }
    for (const [name, cell] of pending) this.cells.set(name, cell);
    prepared();
    const initialize = (name: string, value: unknown) => {
      const cell = this.cells.get(name)!;
      if (cell.initialized && cell.kind === 'const')
        throw new TypeError('Assignment to constant variable.');
      cell.initialized = true;
      cell.value = value;
      return value;
    };
    // Each closure retains its run's console while cells stay shared across runs.
    return execute(this.createScope({ ...this.globals, ...executionGlobals }), {
      importModule: this.importModule,
      modules,
      initialize,
      binding: (name: string) => ({
        set value(value: unknown) {
          initialize(name, value);
        },
      }),
    });
  }
}
