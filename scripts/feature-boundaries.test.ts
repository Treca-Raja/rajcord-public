import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';
import {
  featureImportViolation,
  featureBoundaryPlugin,
  apiSourceRoot,
  webSourceRoot,
} from './feature-boundaries.mjs';

const file = (name: string) => path.join(webSourceRoot, name);

it.each([
  ['features/chat/Messages.tsx', './message-reading'],
  ['features/chat/Messages.tsx', '../account'],
  ['features/voice/VoicePanel.tsx', '../screen-sharing/index.ts'],
  ['features/new-feature/View.tsx', '../voice'],
  ['features/chat/Messages.tsx', '../../shared/call'],
  ['app/App.tsx', '../features/chat'],
  ['app/App.tsx', '../features/account/styles.css'],
  ['app/CallProvider.tsx', '../features/voice/composition'],
  ['main.tsx', './features/screen-sharing/composition'],
])('allows public or owned dependencies: %s -> %s', (from, to) => {
  expect(featureImportViolation(file(from), to)).toBeNull();
});

it.each([
  ['features/chat/Messages.tsx', '../voice/voice-controller'],
  ['features/chat/Messages.tsx', '../voice/../voice/voice-controller.ts'],
  ['features/chat/Messages.tsx', '/src/features/voice/voice-controller'],
  ['features/chat/Messages.tsx', '../voice/voice-controller?raw'],
  ['features/voice/VoicePanel.tsx', '../../app/CallProvider'],
  ['features/voice/VoicePanel.tsx', '../../Auth'],
  ['shared/call.tsx', '../app/CallProvider'],
  ['shared/call.tsx', '../main.tsx'],
  ['features/new-feature/View.tsx', '../chat/ChatComposer'],
  ['app/App.tsx', '../features/chat/Messages'],
  ['features/chat/Messages.tsx', '../../../../api/src/auth/service'],
  ['features/chat/Messages.tsx', '@/features/voice/voice-controller'],
  ['features/chat/Messages.tsx', '../voice/composition'],
  ['features/screen-sharing/ScreenPanel.tsx', '../voice/composition'],
])('rejects private dependencies and composition back-edges: %s -> %s', (from, to) => {
  expect(featureImportViolation(file(from), to)).toBeTruthy();
});

it('keeps shared code independent of feature runtime while permitting explicit type contracts', () => {
  expect(
    featureImportViolation(file('features/new-feature/View.tsx'), '../voice/contracts', true),
  ).toBeNull();
  expect(
    featureImportViolation(file('features/new-feature/View.tsx'), '../voice/contracts'),
  ).toBeTruthy();
  expect(
    featureImportViolation(file('shared/call.tsx'), '../features/voice/contracts', true),
  ).toBeNull();
  expect(
    featureImportViolation(file('shared/call.tsx'), '../features/voice/contracts'),
  ).toBeTruthy();
  expect(featureImportViolation(file('shared/call.tsx'), '../features/voice', true)).toBeTruthy();
});

const config = [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { features: featureBoundaryPlugin },
    rules: { 'features/imports': 'error' as const },
  },
];
const linter = new Linter({ cwd: path.resolve(webSourceRoot, '../../..') });
const lint = (source: string, filename = file('features/chat/View.tsx')) =>
  linter.verify(source, config, { filename, allowInlineConfig: false });

it.each([
  "import { VoiceController } from '../voice/voice-controller'",
  "export { VoiceController } from '../voice/voice-controller'",
  "export * from '../voice/voice-controller'",
  "const load = () => import('../voice/voice-controller')",
  "type Controller = import('../voice/voice-controller').VoiceController",
  "const controller = require('../voice/voice-controller')",
  'const load = (name: string) => import(name)',
  'const load = (name: string) => require(name)',
])('enforces the boundary in ESLint for %s', (source) => {
  expect(lint(source).map((message) => message.ruleId)).toContain('features/imports');
});

it('rejects computed API module paths that cannot be checked against feature boundaries', () => {
  expect(
    lint(
      'const load = (name: string) => require(name)',
      path.join(apiSourceRoot, 'chat/service.ts'),
    ),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'features/imports' })]));
});

it('allows co-located regression fixtures to exercise implementation details', () => {
  expect(
    lint(
      "import { VoiceController } from '../voice/voice-controller'",
      file('features/chat/view.test.ts'),
    ),
  ).toEqual([]);
});

it('checks all current product modules and requires a public entrypoint for each feature', () => {
  function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory() ? files(name) : /\.tsx?$/.test(entry.name) ? [name] : [];
    });
  }
  const violations = files(webSourceRoot).flatMap((filename) =>
    lint(readFileSync(filename, 'utf8'), filename).map((message) => ({
      file: path.relative(webSourceRoot, filename),
      line: message.line,
      message: message.message,
    })),
  );
  expect(violations).toEqual([]);
  for (const feature of readdirSync(path.join(webSourceRoot, 'features')))
    expect(readFileSync(file(`features/${feature}/index.ts`), 'utf8').trim()).not.toBe('');
});
