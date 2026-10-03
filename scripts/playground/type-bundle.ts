import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';

/** Build a virtual TypeScript filesystem directly from workspace source and its
 * reachable dependency declarations. Nothing depends on core's generated dist.
 */
export function typeBundle(root: string) {
  const core = path.join(root, 'packages/core');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    skipLibCheck: true,
    types: [],
    baseUrl: core,
    paths: { '@core/*': ['./*'] },
  };
  const chaiTypes = ts.resolveModuleName(
    'chai',
    path.join(root, 'scripts/playground/worker.ts'),
    options,
    ts.sys,
  ).resolvedModule!;
  const program = ts.createProgram(
    [
      ...['index.ts', 'adapter.ts', 'plugin.ts'].map((file) => path.join(core, file)),
      chaiTypes.resolvedFileName,
    ],
    options,
  );
  const virtualPath = (filename: string) => {
    if (filename.startsWith(`${core}/`))
      return `node_modules/@cashu/coco-core/${path.relative(core, filename)}`;
    const marker = filename.lastIndexOf('/node_modules/');
    return marker >= 0
      ? `node_modules/${filename.slice(marker + 14)}`
      : `workspace/${path.relative(root, filename)}`;
  };
  const libs: { path: string; content: string }[] = [];
  const paths: Record<string, string[]> = {
    '@cashu/coco-core': ['node_modules/@cashu/coco-core/index.ts'],
    '@cashu/coco-core/adapter': ['node_modules/@cashu/coco-core/adapter.ts'],
    '@cashu/coco-core/plugin': ['node_modules/@cashu/coco-core/plugin.ts'],
    '@core/*': ['node_modules/@cashu/coco-core/*'],
    chai: [virtualPath(chaiTypes.resolvedFileName)],
  };
  const dependencies = new Set<string>();
  for (const source of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(source)) continue;
    dependencies.add(source.fileName);
    libs.push({ path: `file:///${virtualPath(source.fileName)}`, content: source.text });
    const visit = (node: ts.Node) => {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        if (!name.startsWith('.') && !name.startsWith('@core/')) {
          const resolved = ts.resolveModuleName(
            name,
            source.fileName,
            options,
            ts.sys,
          ).resolvedModule;
          if (resolved) paths[name] = [virtualPath(resolved.resolvedFileName)];
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(path.join(core, 'index.ts'))!;
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(entry)!);
  const values = exports
    .filter((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return target.flags & ts.SymbolFlags.Value;
    })
    .map((symbol) => symbol.name);
  const eventSymbol = exports.find((symbol) => symbol.name === 'CoreEvents')!;
  const events = checker
    .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(checker.getAliasedSymbol(eventSymbol)))
    .map((symbol) => symbol.name);
  const globals = `declare const coco: import('@cashu/coco-core').Manager;
    declare const core: typeof import('@cashu/coco-core');
    ${values.map((name) => `declare const ${name}: typeof import('@cashu/coco-core').${name};`).join('\n')}
    type Amount = import('@cashu/coco-core').Amount;
    declare const assert: typeof import('chai').assert;`;
  libs.push({ path: 'file:///playground-globals.d.ts', content: globals });
  return {
    libs,
    paths,
    events,
    dependencies: [...dependencies].filter((file) => fs.existsSync(file)),
  };
}
