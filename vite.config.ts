import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, strictPort: true,
    allowedHosts: ['.localhost', 'localhost', '127.0.0.1'],
    fs: {
      strict: true,
      allow: ['client', 'node_modules', 'public', 'index.html'].map(path => resolve(path)),
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**', '**/mailbox/**'],
    },
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  build: { outDir: 'dist/client' },
});
