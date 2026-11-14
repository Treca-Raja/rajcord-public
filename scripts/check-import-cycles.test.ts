import { expect, it } from 'vitest';
import { buildWebGraph, findCycles, runtimeSpecifiers } from './check-import-cycles.mjs';

it('detects direct, indirect and self cycles through public entrypoints', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
    ['self', ['self']],
  ]);
  expect(findCycles(graph)).toEqual([
    ['a', 'b', 'c', 'a'],
    ['self', 'self'],
  ]);
});
it('permits shared dependencies without mistaking a diamond for a cycle', () => {
  expect(
    findCycles(
      new Map([
        ['a', ['b', 'c']],
        ['b', ['d']],
        ['c', ['d']],
        ['d', []],
      ]),
    ),
  ).toEqual([]);
});
it('includes runtime imports, reexports and dynamic imports while excluding types', () => {
  expect(
    runtimeSpecifiers(`
    import type { A } from './types';
    import { type B } from './more-types';
    export type { C } from './contracts';
    export { type D } from './other-contracts';
    import './styles.css';
    import { run, type Input } from './runtime';
    export * from './public';
    const load = () => import('./lazy');
    const other = require('./legacy');
  `),
  ).toEqual(['./styles.css', './runtime', './public', './lazy', './legacy']);
});
it('keeps the actual web runtime graph acyclic', () => {
  expect(findCycles(buildWebGraph())).toEqual([]);
});
