import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function auditObsBundle(resources, staged) {
  assert.ok(
    !fs.existsSync(path.join(resources, 'gstreamer')),
    'Standalone GStreamer bundle found.',
  );
  const obs = path.join(resources, 'obs-screen');
  const inventory = fs.readFileSync(path.join(obs, 'inventory.json'), 'utf8');
  assert.equal(inventory, fs.readFileSync(path.join(staged, 'inventory.json'), 'utf8'));
  const entries = JSON.parse(inventory);
  const metadata = JSON.parse(fs.readFileSync(path.join(obs, 'obs/source-build.json'), 'utf8'));
  const files = fs
    .readdirSync(obs, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile() && item.name !== 'inventory.json')
    .map((item) => path.relative(obs, path.join(item.parentPath, item.name)).replaceAll('\\', '/'));
  assert.deepEqual(files.sort(), entries.map((entry) => entry.path).sort());
  for (const { path: file, sha256 } of entries) {
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(obs, file)))
        .digest('hex'),
      sha256,
      'Packaged OBS hash differs for ' + file,
    );
  }
  for (const file of [
    'bin/obs.dll',
    'bin/libobs-d3d11.dll',
    'bin/libobs-winrt.dll',
    'bin/rajcord-obs.exe',
    'bin/datachannel.dll',
    'bin/libssl-3-x64.dll',
    'bin/libcrypto-3-x64.dll',
    'bin/msvcp140.dll',
    'bin/vcruntime140.dll',
    'bin/vcruntime140_1.dll',
    'obs/core/obs-nvenc/obs-nvenc.dll',
    'obs/core/obs-ffmpeg/obs-ffmpeg.dll',
    'obs/core/obs-x264/obs-x264.dll',
    'obs/OBS-COPYING.txt',
    'obs/nv-codec-headers-license.txt',
    'runtime-notices.md',
    'corresponding-source.md',
    'obs/ffmpeg-licenses/COPYING.GPLv3',
    'obs/ffmpeg-licenses/LICENSE.md',
    'licenses/libdatachannel.txt',
    'versions.txt',
  ])
    assert.ok(files.includes(file), 'Missing OBS runtime file: ' + file);
  assert.ok(
    files.some((file) => /^bin\/(?:lib)?opus(?:-0)?\.dll$/i.test(file)),
    'Missing Opus.',
  );
  assert.ok(
    files.some((file) => /^bin\/(?:lib)?nice(?:-10)?\.dll$/i.test(file)),
    'Missing libnice.',
  );
  assert.equal(metadata.transport, 'libdatachannel', 'Unknown OBS transport.');
  assert.match(metadata.obsCommit, /^[a-f0-9]{40}$/);
  assert.ok(metadata.obsBuildVersion.endsWith('-g' + metadata.obsCommit.slice(0, 7)));
  for (const field of ['sourceSha256', 'x64DependenciesSha256', 'x86DependenciesSha256'])
    assert.match(metadata[field], /^[a-f0-9]{64}$/i);
  const game = 'obs/core/win-capture';
  assert.ok(files.includes(game + '/win-capture.dll'), 'Missing OBS Game Capture plugin.');
  for (const bits of [32, 64]) {
    for (const file of [
      `graphics-hook${bits}.dll`,
      `inject-helper${bits}.exe`,
      `get-graphics-offsets${bits}.exe`,
    ])
      assert.ok(files.includes(game + '/data/' + file), 'Missing OBS Game Capture file: ' + file);
  }
  const gstreamer = files.filter((file) => /(?:^|\/)(?:gstreamer|libgst|gst)/i.test(file));
  assert.deepEqual(gstreamer, [], 'GStreamer files are present in the native WebRTC package.');
  const retired = files.filter((file) =>
    /(?:rajcord-gstreamer\.exe|rajcord-obs-playout\.exe|qsv|onevpl)/i.test(file),
  );
  assert.deepEqual(retired, [], 'Retired capture, encoding or Intel components found in OBS.');
  return entries.length;
}
