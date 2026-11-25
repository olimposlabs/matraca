import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { clientAddressHeader, clientProofHeader, signDevAddress } from './server/request-origin.js';
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
    proxy: { '/api': {
      target: 'http://127.0.0.1:3001', changeOrigin: false,
      configure(proxy) {
        proxy.on('proxyReq', (outgoing, request) => {
          outgoing.removeHeader(clientAddressHeader);
          outgoing.removeHeader(clientProofHeader);
          const address = request.socket.remoteAddress, secret = process.env.MATRACA_DEV_PROXY_SECRET;
          if (!address || !secret) return;
          outgoing.setHeader(clientAddressHeader, address);
          outgoing.setHeader(clientProofHeader, signDevAddress(secret, address, request.headers.host ?? ''));
        });
      },
    } },
  },
  build: { outDir: 'dist/client' },
});
