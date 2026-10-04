import ts from 'typescript';

type Binding = { path: string; kind: 'mutable' | 'constant' | 'symbol'; mutableSymbol?: boolean };

/** Each run is a separate TypeScript module. The editable snippet imports only
 * the latest version of each session binding, except names it declares itself.
 * Mutable value declarations use ambient locals so assignment stays legal.
 */
export class SessionHistory {
  private readonly bindings = new Map<string, Binding>();
  private nextId = 0;

  prefix(source: string): string {
    const locals = declaredNames(source);
    const declarations = ['export {};'];
    for (const [name, binding] of this.bindings) {
      if (locals.has(name)) continue;
      if (binding.kind === 'symbol')
        declarations.push(`import { ${name} } from '${binding.path}';`);
      else
        declarations.push(
          `declare ${binding.kind === 'mutable' ? 'let' : 'const'} ${name}: typeof import('${binding.path}').${name};`,
        );
    }
    return declarations.join('\n') + '\n';
  }

  append(source: string): { path: string; content: string } {
    const names = declaredNames(source);
    const prefix = this.prefix(source);
    // Snapshots sit alongside session.ts, so imports have the same base URL.
    const path = `./session-run-${this.nextId++}`;
    for (const [name, kind] of names) this.bindings.set(name, { ...kind, path });
    return {
      path: `file:///${path.slice(2)}.ts`,
      content: `${prefix}${source}\nexport { ${[...names.keys()].join(', ')} };\n`,
    };
  }

  permitsImportedAssignment(name: string, source: string): boolean {
    return this.bindings.get(name)?.mutableSymbol === true && !declaredNames(source).has(name);
  }

  reset(): void {
    this.bindings.clear();
    this.nextId = 0;
  }
}

function declaredNames(source: string): Map<string, Omit<Binding, 'path'>> {
  const file = ts.createSourceFile('snippet.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Map<string, Omit<Binding, 'path'>>();
  const add = (name: ts.BindingName, kind: Binding['kind']) => {
    if (ts.isIdentifier(name)) names.set(name.text, { kind });
    else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) add(element.name, kind);
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      if (node.parent === file && ts.isFunctionDeclaration(node) && node.name)
        add(node.name, 'mutable');
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (node.parent === file && ts.isClassDeclaration(node) && node.name)
        names.set(node.name.text, { kind: 'symbol', mutableSymbol: true });
      return;
    }
    if (node.parent === file) {
      if (
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)
      ) {
        names.set(node.name.text, {
          kind: 'symbol',
          mutableSymbol: ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node),
        });
        return;
      }
      if (ts.isImportDeclaration(node) && node.importClause) {
        const clause = node.importClause;
        if (clause.name) names.set(clause.name.text, { kind: 'symbol' });
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings))
            names.set(clause.namedBindings.name.text, { kind: 'symbol' });
          else
            for (const element of clause.namedBindings.elements)
              names.set(element.name.text, { kind: 'symbol' });
        }
        return;
      }
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (!(node.flags & ts.NodeFlags.BlockScoped) ||
        (ts.isVariableStatement(node.parent) && node.parent.parent === file))
    ) {
      for (const declaration of node.declarations)
        add(declaration.name, node.flags & ts.NodeFlags.Const ? 'constant' : 'mutable');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}
