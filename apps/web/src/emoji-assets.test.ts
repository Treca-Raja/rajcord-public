import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { emojiCatalog } from '@tricord/shared/emoji-catalog';
import { emojiAssetPath } from './emoji-assets';

it('provides local SVG artwork for every picker entry, including flags and joined tone sequences', () => {
  const require = createRequire(import.meta.url);
  const base = join(dirname(require.resolve('twemoji-art/package.json')), 'dist/svg');
  const extra = fileURLToPath(new URL('./assets/emoji-extra/', import.meta.url));
  const missing = emojiCatalog.filter((entry) => {
    const name = basename(emojiAssetPath(entry.emoji));
    return !existsSync(join(base, name)) && !existsSync(join(extra, name));
  });
  expect(missing.map((entry) => entry.name)).toEqual([]);
  expect(emojiAssetPath('👩🏽‍💻')).toBe('/emoji/17-b6b55fef/1f469-1f3fd-200d-1f4bb.svg');
  expect(emojiAssetPath('🇭🇷')).toBe('/emoji/17-b6b55fef/1f1ed-1f1f7.svg');
});
