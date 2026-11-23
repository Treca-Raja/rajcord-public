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

it.skipIf(process.platform !== 'win32').each([
  ['14.44.35112', 'Microsoft.VC143.CRT'],
  ['14.52.37025', 'Microsoft.VC145.CRT'],
])('locates the complete x64 runtime in Visual Studio layout %s', (version, folder) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'rajcord-vc-runtime-'));
  const selector = fileURLToPath(
    new URL('../apps/desktop/native/obs/vc-runtime.ps1', import.meta.url),
  );
  const names = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
  try {
    const crt = path.join(fixture, 'VC', 'Redist', 'MSVC', version, 'x64', folder);
    mkdirSync(crt, { recursive: true });
    const files = names.map((name) => path.join(crt, name));
    for (const file of files) writeFileSync(file, '');
    const args = ['-NoProfile', '-File', selector, '-VisualStudioPath', fixture];
    const resolved = execFileSync('pwsh', args, { encoding: 'utf8' }).trim().split(/\r?\n/);
    expect(resolved.map((file) => path.normalize(file))).toEqual(files);
    rmSync(files[0]!);
    expect(() => execFileSync('pwsh', args, { stdio: 'pipe' })).toThrow(
      'Install the complete Visual Studio x64 v14 redistributable files.',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
