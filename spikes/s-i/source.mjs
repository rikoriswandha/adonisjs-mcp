import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const root = process.argv[2]
const ts = createRequire(join(root, 'package.json'))('typescript')
function literal(node) { return ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : null }
function keys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return { keys: [], completeness: 'unknown' }
  return { keys: node.properties.filter((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))).map((p) => p.name.text),
    completeness: node.properties.some((p) => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) ? 'partial' : 'static' }
}
const mappings = []
const routes = []
for (const path of ['start/routes.ts', 'app/controllers/s_i_pages_controller.ts']) {
  const text = await readFile(join(root, path), 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'router' && ['get', 'post'].includes(node.expression.name.text)) {
      const target = node.arguments[1]
      if (target && ts.isArrayLiteralExpression(target)) {
        let controller = null
        function imports(child) {
          if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) controller = literal(child.arguments[0])
          ts.forEachChild(child, imports)
        }
        imports(target.elements[0])
        routes.push({ path: literal(node.arguments[0]), method: node.expression.name.text.toUpperCase(), controller, action: literal(target.elements[1]) })
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'render' && node.expression.expression.getText(source) === 'inertia') {
      let parent = node.parent
      let route = null
      while (parent && !ts.isMethodDeclaration(parent)) {
        if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.expression.getText(source) === 'router') route = literal(parent.arguments[0])
        parent = parent.parent
      }
      mappings.push({ file: path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, route,
        method: parent?.name.getText(source) ?? null, component: literal(node.arguments[0]),
        componentEvidence: literal(node.arguments[0]) === null ? 'unknown-dynamic' : 'source-literal', props: keys(node.arguments[1]) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
const text = await readFile(join(root, 'app/middleware/inertia_middleware.ts'), 'utf8')
const source = ts.createSourceFile('inertia_middleware.ts', text, ts.ScriptTarget.Latest, true)
const shared = []
function visitShare(node) {
  if (ts.isMethodDeclaration(node) && ['share', 'flash'].includes(node.name.getText(source))) {
    function returns(child) {
      if (ts.isReturnStatement(child)) shared.push({ method: node.name.getText(source), ...keys(child.expression) })
      ts.forEachChild(child, returns)
    }
    returns(node)
  } else ts.forEachChild(node, visitShare)
}
visitShare(source)
const routeMappings = mappings.map((mapping) => ({ ...mapping, route: mapping.route ?? routes.find((route) =>
  route.controller?.replace('#controllers/', 'app/controllers/') + '.ts' === mapping.file && route.action === mapping.method)?.path ?? null }))
const output = JSON.stringify({ evidence: 'source', controllersExecuted: false, mappings, routeMappings, shared, typescript: ts.version })
if (process.argv[3]) await writeFile(process.argv[3], output + '\n')
else console.log(output)
