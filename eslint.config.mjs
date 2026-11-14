import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import { featureBoundaryPlugin } from './scripts/feature-boundaries.mjs';
export default tseslint.config(
  {
    ignores: [
      'experiments/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/artifacts/**',
      '**/.local/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { features: featureBoundaryPlugin },
    rules: { 'features/imports': 'error' },
  },
  {
    files: ['apps/api/src/**/*.{ts,tsx}'],
    plugins: { features: featureBoundaryPlugin },
    rules: { 'features/imports': 'error' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.*', '**/*.integration.*', '**/*-fixture*'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['apps/api/src/**/*.{ts,tsx}', 'apps/desktop/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.*', '**/*.integration.*', '**/*-fixture*', '**/*-smoke*', '**/*-harness*'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
