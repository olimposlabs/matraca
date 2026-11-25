import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

export const clientAddressHeader = 'x-matraca-dev-address';
export const clientProofHeader = 'x-matraca-dev-proof';
export const normalizeAddress = (address: string) => address.startsWith('::ffff:') ? address.slice(7) : address;

export function signDevAddress(secret: string, address: string, host: string) {
  return createHmac('sha256', secret).update(`${address}\n${host}`).digest('hex');
}

export function loginRateOrigin(request: FastifyRequest) {
  const socket = normalizeAddress(request.ip);
  const secret = process.env.MATRACA_DEV_PROXY_SECRET;
  const address = request.headers[clientAddressHeader], proof = request.headers[clientProofHeader];
  if (!secret || (socket !== '127.0.0.1' && socket !== '::1') || typeof address !== 'string'
    || !isIP(address) || typeof proof !== 'string' || !/^[a-f0-9]{64}$/u.test(proof)) return socket;
  const expected = signDevAddress(secret, address, request.headers.host ?? '');
  return timingSafeEqual(Buffer.from(proof), Buffer.from(expected)) ? normalizeAddress(address) : socket;
}
