import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emojiAssetPrefix } from './src/emoji-assets';
const require = createRequire(import.meta.url);
const fontLicenses = [
  'Inter — @fontsource-variable/inter',
  readFileSync(require.resolve('@fontsource-variable/inter/LICENSE'), 'utf8'),
  'Twemoji graphics — Twitter, Inc. and contributors — CC BY 4.0',
  'https://github.com/jdecked/twemoji — Unicode 17 supplement pinned to b6b55fef1e8636b540a6d016a4729ca8cdf2e60b',
  readFileSync(
    fileURLToPath(new URL('./src/assets/twemoji-graphics-license.txt', import.meta.url)),
    'utf8',
  ),
].join('\n\n');
const fontLicensePlugin: Plugin = {
  name: 'font-license-notices',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/font-licenses.txt') {
        next();
        return;
      }
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : fontLicenses);
    });
  },
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'font-licenses.txt', source: fontLicenses });
  },
};
const emojiFiles = new Map<string, string>();
for (const directory of [
  join(dirname(require.resolve('twemoji-art/package.json')), 'dist/svg'),
  fileURLToPath(new URL('./src/assets/emoji-extra/', import.meta.url)),
]) {
  for (const name of readdirSync(directory))
    if (/^[a-f0-9-]+\.svg$/.test(name)) emojiFiles.set(name, join(directory, name));
}
const emojiArtworkPlugin: Plugin = {
  name: 'self-hosted-emoji-artwork',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split('?')[0] ?? '';
      if (!path.startsWith(emojiAssetPrefix)) {
        next();
        return;
      }
      const file = emojiFiles.get(path.slice(emojiAssetPrefix.length));
      if (!file) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'image/svg+xml');
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.end(request.method === 'HEAD' ? undefined : readFileSync(file));
    });
  },
  generateBundle() {
    for (const [name, path] of emojiFiles)
      this.emitFile({
        type: 'asset',
        fileName: emojiAssetPrefix.slice(1) + name,
        source: readFileSync(path),
      });
  },
};
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    fontLicensePlugin,
    emojiArtworkPlugin,
    {
      name: 'development-csp',
      transformIndexHtml(html) {
        return command === 'serve'
          ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          : html;
      },
    },
  ],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/media': { target: 'http://127.0.0.1:3001', ws: true },
      '/api': 'http://127.0.0.1:3001',
      '/health': 'http://127.0.0.1:3001',
      '/socket.io': { target: 'http://127.0.0.1:3001', ws: true },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
}));
