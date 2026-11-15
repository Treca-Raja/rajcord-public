import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { apiSourceRoot, isFixture, webSourceRoot } from './feature-boundaries.mjs';

export function runtimeSpecifiers(source, filename = 'module.ts') {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) imports.push(node.text);
  };
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      const onlyTypes =
        clause?.isTypeOnly ||
        (!clause?.name &&
          names &&
          ts.isNamedImports(names) &&
          names.elements.length > 0 &&
          names.elements.every((entry) => entry.isTypeOnly));
      if (!onlyTypes) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const names = node.exportClause;
      const onlyTypes =
        node.isTypeOnly ||
        (names &&
          ts.isNamedExports(names) &&
          names.elements.length > 0 &&
          names.elements.every((entry) => entry.isTypeOnly));
      if (!onlyTypes) add(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}

export function findCycles(graph) {
  const visited = new Set(),
    active = new Map(),
    stack = [],
    cycles = [];
  function visit(node) {
    if (active.has(node)) {
      cycles.push([...stack.slice(active.get(node)), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.set(node, stack.length);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    stack.pop();
    active.delete(node);
  }
  for (const node of graph.keys()) visit(node);
  return cycles;
}

export function buildRuntimeGraph(root) {
  function files(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory()
        ? files(name)
        : /\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !isFixture(name)
          ? [name]
          : [];
    });
  }
  const names = files(root),
    included = new Set(names);
  return new Map(
    names.map((filename) => [
      filename,
      runtimeSpecifiers(readFileSync(filename, 'utf8'), filename).flatMap((specifier) => {
        if (!specifier.startsWith('.') && !specifier.startsWith('/src/')) return [];
        const target = specifier.startsWith('/src/')
          ? path.join(root, specifier.slice(5))
          : path.resolve(path.dirname(filename), specifier.split(/[?#]/)[0]);
        const stem = target.replace(/\.[cm]?[jt]sx?$/, '');
        const resolved = [
          target,
          stem + '.ts',
          stem + '.tsx',
          path.join(target, 'index.ts'),
          path.join(target, 'index.tsx'),
        ].find((candidate) => included.has(candidate));
        return resolved ? [resolved] : [];
      }),
    ]),
  );
}

export const buildWebGraph = (root = webSourceRoot) => buildRuntimeGraph(root);
export const buildApiGraph = (root = apiSourceRoot) => buildRuntimeGraph(root);

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let failed = false;
  for (const [name, root, graph] of [
    ['web', webSourceRoot, buildWebGraph()],
    ['API', apiSourceRoot, buildApiGraph()],
  ]) {
    const cycles = findCycles(graph);
    for (const cycle of cycles) {
      console.error(cycle.map((filename) => path.relative(root, filename)).join(' -> '));
      failed = true;
    }
    if (!cycles.length) console.log(`No runtime import cycles in ${graph.size} ${name} modules.`);
  }
  if (failed) process.exitCode = 1;
}
