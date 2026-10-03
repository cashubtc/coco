import ts from 'typescript';

/** Reject access to the function context introduced only by the REPL wrapper. */
export function validateSnippet(file: ts.SourceFile): void {
  const hasContext = (node: ts.Node, kind: 'arguments' | 'new.target' | 'return') => {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isFunctionLike(parent)) {
        // A computed method name executes in the surrounding scope, not the method.
        if (child === parent.name) continue;
        if (kind === 'return' || !ts.isArrowFunction(parent)) return true;
      }
      if (
        kind === 'new.target' &&
        (ts.isClassStaticBlockDeclaration(parent) ||
          (ts.isPropertyDeclaration(parent) && child === parent.initializer))
      )
        return true;
    }
    return false;
  };
  const isPropertyOrLabel = (node: ts.Identifier) => {
    const parent = node.parent;
    return (
      ((ts.isPropertyAccessExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isPropertyDeclaration(parent)) &&
        parent.name === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node) ||
      ((ts.isLabeledStatement(parent) ||
        ts.isBreakStatement(parent) ||
        ts.isContinueStatement(parent)) &&
        parent.label === node)
    );
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.NewKeyword &&
      !hasContext(node, 'new.target')
    )
      throw new SyntaxError(
        'new.target is only available inside functions and class initializers.',
      );
    if (
      ts.isIdentifier(node) &&
      node.text === 'arguments' &&
      !isPropertyOrLabel(node) &&
      !hasContext(node, 'arguments')
    )
      throw new SyntaxError('arguments is only available inside regular functions.');
    if (ts.isReturnStatement(node) && !hasContext(node, 'return'))
      throw new SyntaxError('return is only available inside functions.');
    ts.forEachChild(node, visit);
  };
  visit(file);
}
