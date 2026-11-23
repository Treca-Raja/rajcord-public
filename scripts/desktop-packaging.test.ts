import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(require.resolve('electron-builder'));
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
function packagingConfig(): { files: string[]; asarUnpack: string[] } {
  const staged = mkdtempSync(path.join(tmpdir(), 'rajcord-builder-test-'));
  const previous = process.env.RAJCORD_OBS_PACKAGE_BUNDLE;
  try {
    mkdirSync(path.join(staged, 'obs'));
    writeFileSync(path.join(staged, 'inventory.json'), '[]');
    writeFileSync(path.join(staged, 'obs/source-build.json'), '{"transport":"libdatachannel"}');
    process.env.RAJCORD_OBS_PACKAGE_BUNDLE = staged;
    return require('./electron-builder.cjs');
  } finally {
    if (previous === undefined) delete process.env.RAJCORD_OBS_PACKAGE_BUNDLE;
    else process.env.RAJCORD_OBS_PACKAGE_BUNDLE = previous;
    rmSync(staged, { recursive: true, force: true });
  }
}
const config = packagingConfig();
const { files } = config;
const { minimatch }: { minimatch: (file: string, pattern: string) => boolean } =
  libRequire('minimatch');

function excluded(file: string) {
  return files.some((pattern) => pattern.startsWith('!') && minimatch(file, pattern.slice(1)));
}

it('keeps minimatch versions affected by GHSA-g3hv-75wg-m249 out of the workspace lockfile', () => {
  const { load } = require('js-yaml') as { load: (contents: string) => unknown };
  const lockfile = load(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')) as {
    packages: Record<string, unknown>;
  };
  const affected = Object.keys(lockfile.packages).filter((name) =>
    /^minimatch@(?:(?:[7-9]|10)\.|11\.0\.0\b)/.test(name),
  );

  expect(affected).toEqual([]);
});

it.each([
  'dist/server-url.test.js',
  'dist/smoke.js',
  'dist/external-links-smoke.js',
  'dist/screen-picker-smoke.js',
  'dist/native-capture-smoke.js',
  'dist/capture-authority-smoke.js',
  'dist/nested/voice-smoke.js',
  'node_modules/@tricord/shared/dist/http-url.test.js',
  'node_modules/@tricord/shared/dist/nested/protocol.test.js',
])('excludes test and smoke code from the desktop package: %s', (file) => {
  expect(excluded(file)).toBe(true);
});

it.each([
  'dist/main.js',
  'dist/preload.js',
  'dist/picker-preload.js',
  'dist/window-audio-process.ps1',
  'dist/screen-picker.js',
  'dist/native-capture.js',
  'dist/screen-ipc.js',
  'dist/picker/picker.js',
  'dist/external-links.js',
  'dist/update-policy.js',
  'resources/icon.png',
  'node_modules/@tricord/shared/dist/index.js',
  'node_modules/@tricord/shared/dist/http-url.js',
  'node_modules/electron-updater/out/main.js',
])('preserves desktop runtime and production dependencies: %s', (file) => {
  expect(excluded(file)).toBe(false);
});

it('unpacks the Windows identity helper so PowerShell can read it', () => {
  expect(config.asarUnpack).toContain('dist/window-audio-process.ps1');
});

it.each([
  'dist/picker/picker.html',
  'dist/picker/picker.css',
  'dist/picker/picker.js',
  'dist/picker-preload.js',
])('includes required picker assets in the package: %s', (file) => {
  expect(files.some((pattern) => !pattern.startsWith('!') && minimatch(file, pattern))).toBe(true);
  expect(excluded(file)).toBe(false);
});

it('keeps the app, window, tray and browser icons in sync with the waveform', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./desktop-icons.mjs', import.meta.url)),
    '--check',
  ]);
});
