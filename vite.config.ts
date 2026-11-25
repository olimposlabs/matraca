import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { clientAddressHeader, clientProofHeader, signDevAddress } from './server/request-origin.js';
import { localHostname } from './server/config.js';
import { webContentSecurity } from './server/web-security.js';

export default defineConfig({
  plugins: [react(), {
    name: 'matraca:document-security',
    configureServer(server) {
      const fastRefreshHash = createHash('sha256').update(react.preambleCode.replace('__BASE__', server.config.base)).digest('base64');
      server.middlewares.use((request, response, next) => {
        const host = request.headers.host;
        if (host && localHostname(host)) {
          response.setHeader('Content-Security-Policy', webContentSecurity({ scriptHash: fastRefreshHash, websocket: `ws://${host}` }));
          response.setHeader('X-Frame-Options', 'DENY');
        }
        next();
      });
    },
  }],
  preview: { headers: { 'Content-Security-Policy': webContentSecurity(), 'X-Frame-Options': 'DENY' } },
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
