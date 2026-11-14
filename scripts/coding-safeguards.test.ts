import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root });
const filePath = fileURLToPath(new URL('../apps/web/src/shared/background.ts', import.meta.url));
it.each([
  ['@typescript-eslint/no-floating-promises', 'void Promise.reject(new Error("fixture"));'],
  [
    '@typescript-eslint/no-misused-promises',
    'const handler: () => void = async () => {}; handler();',
  ],
  [
    'react-hooks/rules-of-hooks',
    'import { useState } from "react"; export function Example({ready}: {ready: boolean}) { if (ready) useState(0); return null; }',
  ],
  [
    'react-hooks/exhaustive-deps',
    'import { useEffect } from "react"; export function Example({value}: {value: string}) { useEffect(() => console.log(value), []); return null; }',
  ],
])(
  'enforces %s through the real repository config',
  async (rule, source) => {
    const [result] = await eslint.lintText(source!, { filePath });
    expect(result!.messages.map((message) => message.ruleId)).toContain(rule);
  },
  20_000,
);
it('accepts explicit rejection handling', async () => {
  const [result] = await eslint.lintText(
    'void Promise.resolve().catch((cause: unknown) => console.error(cause));',
    { filePath },
  );
  expect(result!.errorCount).toBe(0);
});

it.each([
  ['API', '../apps/api/src/app.ts'],
  ['Electron main', '../apps/desktop/src/main.ts'],
])('enforces typed promise handling in %s production code', async (_app, target) => {
  const targetPath = fileURLToPath(new URL(target!, import.meta.url));
  const [result] = await eslint.lintText('void Promise.reject(new Error("fixture"));', {
    filePath: targetPath,
  });
  expect(result!.messages.map((message) => message.ruleId)).toContain(
    '@typescript-eslint/no-floating-promises',
  );
});
