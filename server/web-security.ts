export function webContentSecurity(dev?: { scriptHash: string; websocket: string }) {
  return [
    "default-src 'none'",
    `script-src 'self'${dev ? ` 'sha256-${dev.scriptHash}'` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self'${dev ? ` ${dev.websocket}` : ''}`,
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
