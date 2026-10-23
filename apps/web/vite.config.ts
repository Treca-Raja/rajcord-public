import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
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
      '/api': 'http://127.0.0.1:3001',
      '/health': 'http://127.0.0.1:3001',
      '/socket.io': { target: 'http://127.0.0.1:3001', ws: true },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
}));
