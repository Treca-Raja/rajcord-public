import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(require.resolve('electron-builder'));
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { listPackage, extractFile } = libRequire('@electron/asar');
const { load } = require('js-yaml');
const { trustedUpdateConfig } = require('./dist/update-policy.js');
const dir = path.resolve('artifacts/desktop');
const archive = path.join(dir, 'win-unpacked/resources/app.asar');
const files = listPackage(archive).map((file) => file.replaceAll('\\', '/'));
assert.ok(files.includes('/dist/main.js'));
const unexpectedFiles = files.filter((file) =>
  /(?:\.env|\.local|\.test\.js|smoke\.js|\.pem|\.pfx|\.key|\/apps\/api\/)/i.test(file),
);
assert.equal(
  unexpectedFiles.length,
  0,
  `Unexpected private/test/server material in package: ${unexpectedFiles.join(', ')}`,
);
const pkg = JSON.parse(extractFile(archive, 'package.json').toString());
assert.equal(pkg.name, 'rajcord');
assert.equal(pkg.productName, 'Rajcord');
assert.equal(pkg.version, JSON.parse(fs.readFileSync('apps/desktop/package.json', 'utf8')).version);
assert.ok(fs.existsSync(path.join(dir, `Rajcord-Setup-${pkg.version}-x64.exe`)));
assert.ok(fs.existsSync(path.join(dir, 'win-unpacked/Rajcord.exe')));
const configFile = path.join(dir, 'win-unpacked/resources/app-update.yml');
if (process.env.RAJCORD_SIGNED_RELEASE === '1') {
  assert.ok(
    trustedUpdateConfig(load(fs.readFileSync(configFile, 'utf8'))),
    'Missing update trust configuration.',
  );
  const manifest = load(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  for (const file of manifest.files) {
    const { createHash } = await import('node:crypto');
    assert.equal(
      file.sha512,
      createHash('sha512')
        .update(fs.readFileSync(path.join(dir, file.url)))
        .digest('base64'),
    );
  }
} else {
  assert.ok(!fs.existsSync(configFile), 'Unsigned builds must not enable updates.');
  assert.ok(
    !fs.existsSync(path.join(dir, 'latest.yml')),
    'Unsigned builds must not emit update metadata.',
  );
}
console.log(
  `Rajcord ${pkg.version}: package identity, contents and update policy passed (${files.length} archive entries).`,
);
