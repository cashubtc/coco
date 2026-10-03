import ts from 'typescript';
import { validateSnippet } from './validate';

export type Declaration = { name: string; kind: 'let' | 'const' | 'var' };
type StaticImport = { specifier: string; names: string[] };
const reserved = '__cocoPlayground';

/** Erase types, route imports, then move session declarations into persistent cells.
 * Closures resolve the cells through the surrounding scope rather than copied locals.
 */
export function compile(source: string): {
  code: string;
  declarations: Declaration[];
  internal: string;
  imports: StaticImport[];
} {
  const parsed = ts.createSourceFile('snippet.ts', source, ts.ScriptTarget.Latest, true);
  const imports: StaticImport[] = [];
  const identifiers = new Set<string>();
  const collectIdentifiers = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Using)
      throw new SyntaxError('Resource declarations (using and await using) are not supported.');
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, collectIdentifiers);
  };
  collectIdentifiers(parsed);
  let internal = reserved;
  while (identifiers.has(internal)) internal += '_';
  for (const statement of parsed.statements) {
    if (
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    ) {
      throw new SyntaxError('Use snippets without export declarations.');
    }
    if (ts.isImportEqualsDeclaration(statement)) throw new SyntaxError('Use ES module imports.');
  }
  const result = ts.transpileModule(source, {
    fileName: 'snippet.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    transformers: {
      before: [
        (context) => {
          const f = context.factory;
          const declaration = (name: ts.BindingName, value: ts.Expression) =>
            f.createVariableStatement(
              undefined,
              f.createVariableDeclarationList(
                [f.createVariableDeclaration(name, undefined, undefined, value)],
                ts.NodeFlags.Const,
              ),
            );
          const visit: ts.Visitor = (node) => {
            if (ts.isImportDeclaration(node)) {
              const clause = node.importClause;
              if (clause?.isTypeOnly) return undefined;
              if (!ts.isStringLiteral(node.moduleSpecifier))
                throw new SyntaxError('Static imports require a string module specifier.');
              const names = clause?.name ? ['default'] : [];
              if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
                for (const item of clause.namedBindings.elements)
                  if (!item.isTypeOnly) names.push((item.propertyName ?? item.name).text);
              const index = imports.push({ specifier: node.moduleSpecifier.text, names }) - 1;
              // Modules are loaded and exports validated before session bindings change.
              const loaded = f.createElementAccessExpression(
                f.createPropertyAccessExpression(f.createIdentifier(internal), 'modules'),
                index,
              );
              if (!clause) return f.createExpressionStatement(f.createVoidExpression(loaded));
              const bindings: ts.BindingElement[] = [];
              if (clause.name)
                bindings.push(f.createBindingElement(undefined, 'default', clause.name));
              const named = clause.namedBindings;
              if (named && ts.isNamespaceImport(named)) {
                return [
                  declaration(named.name, loaded),
                  ...(clause.name
                    ? [
                        declaration(
                          clause.name,
                          f.createPropertyAccessExpression(named.name, 'default'),
                        ),
                      ]
                    : []),
                ];
              }
              if (named && ts.isNamedImports(named))
                for (const item of named.elements) {
                  if (!item.isTypeOnly)
                    bindings.push(f.createBindingElement(undefined, item.propertyName, item.name));
                }
              return bindings.length
                ? declaration(f.createObjectBindingPattern(bindings), loaded)
                : undefined;
            }
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
              return f.updateCallExpression(
                node,
                f.createPropertyAccessExpression(f.createIdentifier(internal), 'importModule'),
                undefined,
                node.arguments.map((arg) => ts.visitNode(arg, visit) as ts.Expression),
              );
            }
            return ts.visitEachChild(node, visit, context);
          };
          // ES imports are available throughout the module, even above their declaration.
          return (file) =>
            ts.visitEachChild(
              f.updateSourceFile(file, [
                ...file.statements.filter(ts.isImportDeclaration),
                ...file.statements.filter((statement) => !ts.isImportDeclaration(statement)),
              ]),
              visit,
              context,
            );
        },
      ],
    },
  });
  const errors =
    result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length)
    throw new SyntaxError(
      errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
    );
  const file = ts.createSourceFile(
    'snippet.js',
    result.outputText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declarations: Declaration[] = [];
  validateSnippet(file);
  // Validate before rewriting declarations: rewriting can otherwise hide missing
  // const initializers, invalid strict-mode names, and block/var collisions.
  const body = ts.createPrinter().printFile(
    ts.factory.updateSourceFile(
      file,
      file.statements.filter((statement) => !ts.isExportDeclaration(statement)),
    ),
  );
  new Function(`return async function() { "use strict";\n${body}\n};`);
  const collect = (name: ts.BindingName, kind: Declaration['kind']) => {
    if (ts.isIdentifier(name)) {
      if (name.text.startsWith(reserved))
        throw new SyntaxError(`Names beginning with ${reserved} are reserved.`);
      declarations.push({ name: name.text, kind });
    } else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) collect(element.name, kind);
  };
  const scan = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      if (node.parent === file && ts.isFunctionDeclaration(node) && node.name)
        collect(node.name, 'var');
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (node.parent === file && ts.isClassDeclaration(node) && node.name)
        collect(node.name, 'let');
      return;
    }
    if (ts.isVariableDeclarationList(node)) {
      const kind =
        node.flags & ts.NodeFlags.Const ? 'const' : node.flags & ts.NodeFlags.Let ? 'let' : 'var';
      if (kind === 'var' || (ts.isVariableStatement(node.parent) && node.parent.parent === file))
        for (const declaration of node.declarations) collect(declaration.name, kind);
    }
    ts.forEachChild(node, scan);
  };
  scan(file);
  const hoisted: ts.Statement[] = [];
  const transformed = ts.transform(file, [
    (context) => {
      const f = context.factory;
      const catchBindings = new Set<string>();
      const helper = (method: string, args: ts.Expression[]) =>
        f.createCallExpression(
          f.createPropertyAccessExpression(f.createIdentifier(internal), method),
          undefined,
          args,
        );
      const namedValue = (name: ts.BindingName, value: ts.Expression): ts.Expression => {
        let expression = value;
        while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
        if (
          !ts.isIdentifier(name) ||
          !(
            ts.isArrowFunction(expression) ||
            ((ts.isFunctionExpression(expression) || ts.isClassExpression(expression)) &&
              !expression.name)
          )
        )
          return value;
        // Let JavaScript infer the name without adding a private function-name
        // binding: recursive references must still see later session replacements.
        // A computed key also handles a binding literally named __proto__.
        return f.createElementAccessExpression(
          f.createParenthesizedExpression(
            f.createObjectLiteralExpression([
              f.createPropertyAssignment(
                f.createComputedPropertyName(f.createStringLiteral(name.text)),
                value,
              ),
            ]),
          ),
          f.createStringLiteral(name.text),
        );
      };
      const target = (name: ts.BindingName): ts.Expression => {
        // A var declaration in a catch body is hoisted, but its initializer
        // assigns the catch parameter when the names coincide.
        if (ts.isIdentifier(name) && catchBindings.has(name.text)) return name;
        if (ts.isIdentifier(name))
          return f.createPropertyAccessExpression(
            helper('binding', [f.createStringLiteral(name.text)]),
            'value',
          );
        const elementTarget = (element: ts.BindingElement) => {
          const value = target(element.name);
          return element.initializer
            ? f.createBinaryExpression(
                value,
                ts.SyntaxKind.EqualsToken,
                namedValue(element.name, element.initializer),
              )
            : value;
        };
        if (ts.isArrayBindingPattern(name))
          return f.createArrayLiteralExpression(
            name.elements.map((element) =>
              ts.isOmittedExpression(element)
                ? element
                : element.dotDotDotToken
                  ? f.createSpreadElement(elementTarget(element))
                  : elementTarget(element),
            ),
          );
        return f.createObjectLiteralExpression(
          name.elements.map((element) =>
            element.dotDotDotToken
              ? f.createSpreadAssignment(elementTarget(element))
              : f.createPropertyAssignment(
                  element.propertyName ?? (element.name as ts.Identifier),
                  elementTarget(element),
                ),
          ),
        );
      };
      const initializers = (list: ts.VariableDeclarationList) =>
        list.declarations.flatMap((declaration) => {
          const isVar = !(list.flags & ts.NodeFlags.BlockScoped);
          if (isVar && !declaration.initializer) return [];
          return [
            f.createParenthesizedExpression(
              f.createBinaryExpression(
                target(declaration.name),
                ts.SyntaxKind.EqualsToken,
                declaration.initializer
                  ? namedValue(declaration.name, declaration.initializer)
                  : f.createVoidZero(),
              ),
            ),
          ];
        });
      const visit: ts.Visitor = (node) => {
        if (
          ts.isCatchClause(node) &&
          node.variableDeclaration &&
          ts.isIdentifier(node.variableDeclaration.name)
        ) {
          const name = node.variableDeclaration.name.text;
          const alreadyBound = catchBindings.has(name);
          catchBindings.add(name);
          const visited = ts.visitEachChild(node, visit, context);
          if (!alreadyBound) catchBindings.delete(name);
          return visited;
        }
        if (ts.isFunctionLike(node)) {
          if (node.parent === file && ts.isFunctionDeclaration(node) && node.name) {
            hoisted.push(
              f.createExpressionStatement(
                helper('initialize', [
                  f.createStringLiteral(node.name.text),
                  namedValue(
                    node.name,
                    f.createFunctionExpression(
                      node.modifiers?.filter(ts.isModifier),
                      node.asteriskToken,
                      undefined,
                      undefined,
                      node.parameters,
                      undefined,
                      node.body!,
                    ),
                  ),
                ]),
              ),
            );
            return undefined;
          }
          return node;
        }
        if (node.parent === file && ts.isClassDeclaration(node) && node.name) {
          return f.createExpressionStatement(
            helper('initialize', [
              f.createStringLiteral(node.name.text),
              f.createClassExpression(
                undefined,
                node.name,
                undefined,
                node.heritageClauses,
                node.members,
              ),
            ]),
          );
        }
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node;
        if (
          ts.isVariableStatement(node) &&
          (!(node.declarationList.flags & ts.NodeFlags.BlockScoped) || node.parent === file)
        ) {
          const expressions = initializers(node.declarationList);
          const statements = expressions.map((expression) =>
            f.createExpressionStatement(expression),
          );
          return node.parent === file ? statements : f.createBlock(statements);
        }
        if (
          ts.isForStatement(node) &&
          node.initializer &&
          ts.isVariableDeclarationList(node.initializer) &&
          !(node.initializer.flags & ts.NodeFlags.BlockScoped)
        ) {
          const expressions = initializers(node.initializer);
          return f.updateForStatement(
            node,
            expressions.length ? f.createCommaListExpression(expressions) : undefined,
            node.condition,
            node.incrementor,
            ts.visitNode(node.statement, visit) as ts.Statement,
          );
        }
        if (
          (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
          ts.isVariableDeclarationList(node.initializer) &&
          !(node.initializer.flags & ts.NodeFlags.BlockScoped)
        ) {
          const assignment = target(node.initializer.declarations[0]!.name);
          const body = ts.visitNode(node.statement, visit) as ts.Statement;
          return ts.isForOfStatement(node)
            ? f.updateForOfStatement(node, node.awaitModifier, assignment, node.expression, body)
            : f.updateForInStatement(node, assignment, node.expression, body);
        }
        if (ts.isExportDeclaration(node)) return undefined; // TypeScript's empty module marker.
        return ts.visitEachChild(node, visit, context);
      };
      return (source) => {
        const visited = ts.visitEachChild(source, visit, context);
        const statements = [...visited.statements];
        const last = statements.at(-1);
        const originalLast = file.statements
          .filter((statement) => !ts.isExportDeclaration(statement))
          .at(-1);
        if (
          last &&
          ts.isExpressionStatement(last) &&
          originalLast &&
          ts.isExpressionStatement(originalLast)
        )
          statements[statements.length - 1] = f.createReturnStatement(last.expression);
        return f.updateSourceFile(visited, [...hoisted, ...statements]);
      };
    },
  ]);
  const code = ts.createPrinter().printFile(transformed.transformed[0]!);
  transformed.dispose();
  return { code, declarations, internal, imports };
}
