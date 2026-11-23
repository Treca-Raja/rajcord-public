import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { auditObsBundle } from './desktop-obs-audit.mjs';

it('requires a private OBS runtime and excludes the retired desktop sender and plugins', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rajcord-obs-package-'));
  try {
    const bundle = path.join(root, 'obs-screen');
    const staged = path.join(root, 'staged');
    mkdirSync(staged);
    const files = [
      'bin/obs.dll',
      'bin/libobs-d3d11.dll',
      'bin/libobs-winrt.dll',
      'bin/rajcord-obs.exe',
      'bin/msvcp140.dll',
      'bin/vcruntime140.dll',
      'bin/vcruntime140_1.dll',
      'bin/datachannel.dll',
      'bin/nice-10.dll',
      'bin/opus.dll',
      'bin/libssl-3-x64.dll',
      'bin/libcrypto-3-x64.dll',
      'obs/core/obs-nvenc/obs-nvenc.dll',
      'obs/core/obs-ffmpeg/obs-ffmpeg.dll',
      'obs/core/obs-x264/obs-x264.dll',
      'obs/OBS-COPYING.txt',
      'runtime-notices.md',
      'corresponding-source.md',
      'obs/ffmpeg-licenses/COPYING.GPLv3',
      'obs/ffmpeg-licenses/LICENSE.md',
      'licenses/libdatachannel.txt',
      'versions.txt',
    ];
    const upstreamCommit = '0c790bd0151fb9f574867e025ecf57e6eedc58e2';
    const source = {
      transport: 'libdatachannel',
      obsCommit: upstreamCommit,
      obsBuildVersion: '33.0.1-g0c790bd',
      sourceSha256: 'a'.repeat(64),
      x64DependenciesSha256: 'b'.repeat(64),
      x86DependenciesSha256: 'c'.repeat(64),
    };
    let provenance = JSON.stringify(source);
    function stage() {
      const manifest = files.map((relative) => {
        const file = path.join(bundle, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        const data = relative === 'obs/source-build.json' ? provenance : relative;
        writeFileSync(file, data);
        return { path: relative, sha256: createHash('sha256').update(data).digest('hex') };
      });
      for (const dir of [bundle, staged])
        writeFileSync(path.join(dir, 'inventory.json'), JSON.stringify(manifest));
    }
    expect(() => auditObsBundle(root, staged)).toThrow();
    stage();
    expect(() => auditObsBundle(root, staged)).toThrow(/source-build\.json/);
    files.push('obs/source-build.json', 'obs/core/win-capture/win-capture.dll');
    stage();
    expect(() => auditObsBundle(root, staged)).toThrow(/Missing OBS runtime file: obs\/nv-codec/);
    files.push('obs/nv-codec-headers-license.txt');
    stage();
    expect(() => auditObsBundle(root, staged)).toThrow(/graphics-hook32/);
    for (const bits of [32, 64])
      for (const file of [
        `graphics-hook${bits}.dll`,
        `inject-helper${bits}.exe`,
        `get-graphics-offsets${bits}.exe`,
      ])
        files.push('obs/core/win-capture/data/' + file);
    stage();
    expect(auditObsBundle(root, staged)).toBe(files.length);
    writeFileSync(path.join(bundle, 'bin/obs.dll'), 'modified');
    expect(() => auditObsBundle(root, staged)).toThrow(/hash differs/);
    provenance = JSON.stringify({ ...source, transport: 'unknown' });
    stage();
    expect(() => auditObsBundle(root, staged)).toThrow(/Unknown OBS transport/);
    provenance = JSON.stringify(source);
    files.push('lib/gstreamer-1.0/gstnvcodec.dll');
    stage();
    expect(() => auditObsBundle(root, staged)).toThrow(/GStreamer files/);
    mkdirSync(path.join(root, 'gstreamer'));
    expect(() => auditObsBundle(root, staged)).toThrow(/Standalone GStreamer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
