import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(require.resolve('electron-builder'));
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { files }: { files: string[] } = require('./electron-builder.cjs');
const { minimatch }: { minimatch: (file: string, pattern: string) => boolean } =
  libRequire('minimatch');

function excluded(file: string) {
  return files.some((pattern) => pattern.startsWith('!') && minimatch(file, pattern.slice(1)));
}

it.each([
  'dist/server-url.test.js',
  'dist/smoke.js',
  'dist/external-links-smoke.js',
  'dist/nested/voice-smoke.js',
  'node_modules/@tricord/shared/dist/http-url.test.js',
  'node_modules/@tricord/shared/dist/nested/protocol.test.js',
])('excludes test and smoke code from the desktop package: %s', (file) => {
  expect(excluded(file)).toBe(true);
});

it.each([
  'dist/main.js',
  'dist/preload.js',
  'dist/external-links.js',
  'dist/update-policy.js',
  'resources/icon.png',
  'node_modules/@tricord/shared/dist/index.js',
  'node_modules/@tricord/shared/dist/http-url.js',
  'node_modules/electron-updater/out/main.js',
])('preserves desktop runtime and production dependencies: %s', (file) => {
  expect(excluded(file)).toBe(false);
});
