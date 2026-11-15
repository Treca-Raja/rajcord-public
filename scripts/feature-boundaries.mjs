import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const webSourceRoot = fileURLToPath(new URL('../apps/web/src/', import.meta.url));
export const apiSourceRoot = fileURLToPath(new URL('../apps/api/src/', import.meta.url));
const normalized = (value) => path.posix.normalize(value.replaceAll('\\', '/'));
export const isFixture = (filename) =>
  /(?:\.test\.|\.integration\.|-fixtures?(?:\.|-))/.test(filename);

const apiDependencies = {
  auth: new Set(['db']),
  chat: new Set(['auth']),
  db: new Set(),
  screen: new Set(['auth', 'voice']),
  voice: new Set(['auth', 'db']),
};

export function apiFeatureImportViolation(filename, specifier) {
  const root = normalized(apiSourceRoot).replace(/\/$/, '');
  const importer = normalized(filename);
  if (!importer.startsWith(root + '/') || isFixture(importer)) return null;
  if (/(?:^|\/)(?:[^/]*-smoke|verify-persistence)\.ts$/.test(importer)) return null;
  if (!specifier.startsWith('.')) return null;
  const target = normalized(
    path.posix.join(path.posix.dirname(importer), specifier.split(/[?#]/)[0]),
  );
  if (!target.startsWith(root + '/'))
    return 'API feature modules must not import files outside the API source tree.';
  const from = importer.slice(root.length + 1).split('/')[0];
  const to = target.slice(root.length + 1).split('/')[0];
  if (!apiDependencies[from]) return null;
  if (from === to) return null;
  if (to === 'app.ts' || to === 'index.ts' || !apiDependencies[to])
    return 'API feature modules must not import application composition or unrelated source files.';
  if (apiDependencies[from].has(to)) return null;
  return `API ${from} modules may depend only on their declared feature contracts; ${to} is outside that boundary.`;
}

export function featureImportViolation(filename, specifier, typeOnly = false) {
  const root = normalized(webSourceRoot).replace(/\/$/, '');
  const importer = normalized(filename);
  if (!importer.startsWith(root + '/') || isFixture(importer)) return null;
  if (/^(?:@\/|~\/|src\/)/.test(specifier))
    return 'Use relative feature entrypoints; source aliases must not bypass feature boundaries.';
  let target;
  if (specifier.startsWith('/src/')) target = root + specifier.slice(4);
  else if (specifier.startsWith('.'))
    target = path.posix.join(path.posix.dirname(importer), specifier);
  else return null;
  target = normalized(target.split(/[?#]/)[0]);
  if (!target.startsWith(root + '/'))
    return 'Web runtime modules must use service contracts instead of importing another app.';
  const from = importer.slice(root.length + 1).split('/');
  const to = target.slice(root.length + 1).split('/');
  if (['features', 'shared'].includes(from[0]) && (to[0] === 'app' || to.length === 1))
    return 'Features and shared helpers must not import app composition; pass dependencies through a public contract.';
  if (to[0] !== 'features') return null;
  const entry = to[2]?.replace(/\.tsx?$/, '');
  if (to.length === 3 && entry === 'contracts' && !typeOnly)
    return 'Import feature contracts as types; runtime dependencies belong in the public index.';
  if (from[0] === 'features' && from[1] === to[1]) return null;
  if (from[0] === 'shared' && !(to.length === 3 && entry === 'contracts' && typeOnly))
    return 'Shared modules may depend on feature contracts through type-only imports.';
  if (to.length === 3 && entry === 'composition')
    return from[0] === 'app' || from[0] === 'main.tsx'
      ? null
      : 'Only app composition may construct feature lifetimes through composition.ts.';
  if (to.length === 2 || (to.length === 3 && ['index', 'contracts', 'styles.css'].includes(entry)))
    return null;
  return `Import ${to[1]} through its public index, contracts, or stylesheet; its implementation is private.`;
}

export const featureBoundaryPlugin = {
  rules: {
    imports: {
      meta: { type: 'problem', schema: [], messages: { boundary: '{{reason}}' } },
      create(context) {
        const filename = context.filename;
        const reportDynamicSpecifier = (node) =>
          context.report({
            node,
            messageId: 'boundary',
            data: {
              reason: 'Use literal module specifiers so feature dependencies can be checked.',
            },
          });
        const check = (node, source, typeOnly = false) => {
          if (typeof source?.value !== 'string') return;
          const reason =
            featureImportViolation(filename, source.value, typeOnly) ??
            apiFeatureImportViolation(filename, source.value);
          if (reason) context.report({ node, messageId: 'boundary', data: { reason } });
        };
        const declaration = (node) =>
          check(
            node,
            node.source,
            node.importKind === 'type' ||
              node.exportKind === 'type' ||
              (node.specifiers?.length > 0 &&
                node.specifiers.every(
                  (item) => item.importKind === 'type' || item.exportKind === 'type',
                )),
          );
        return {
          ImportDeclaration: declaration,
          ExportNamedDeclaration: declaration,
          ExportAllDeclaration: declaration,
          TSImportType(node) {
            check(node, node.source, true);
          },
          ImportExpression(node) {
            if (node.source.type === 'Literal' && typeof node.source.value === 'string')
              check(node, node.source);
            else if (!isFixture(filename)) reportDynamicSpecifier(node);
          },
          CallExpression(node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
              const source = node.arguments[0];
              if (source?.type === 'Literal' && typeof source.value === 'string')
                check(node, source);
              else if (!isFixture(filename)) reportDynamicSpecifier(node);
            }
          },
        };
      },
    },
  },
};
