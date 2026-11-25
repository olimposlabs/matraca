import { mkdir, statfs } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from './db.js';
import type { LocalStorage } from './storage.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
export const uploadTimeoutMs = 120_000;
const reservationSeconds = 300;

interface UploadLimits {
  actorBytes: number; orgBytes: number; instanceBytes: number;
  actorCount: number; orgCount: number; instanceCount: number; minimumFreeBytes: number;
}
type Target = { orgId: string; actorId: string };
type ObjectBudget = { key: string; bytes: number };
const positiveLimit = (value: number) => Number.isSafeInteger(value) && value > 0;
const envLimit = (key: string, defaultValue: number) => Number(process.env[key] ?? defaultValue);
function defaultLimits(): UploadLimits {
  return {
    actorBytes: envLimit('UPLOAD_ACTOR_BYTES', 2 * GiB),
    orgBytes: envLimit('UPLOAD_ORG_BYTES', 8 * GiB),
    instanceBytes: envLimit('UPLOAD_INSTANCE_BYTES', 24 * GiB),
    actorCount: envLimit('UPLOAD_ACTOR_COUNT_24H', 120),
    orgCount: envLimit('UPLOAD_ORG_COUNT_24H', 600),
    instanceCount: envLimit('UPLOAD_INSTANCE_COUNT_24H', 2000),
    minimumFreeBytes: envLimit('UPLOAD_FREE_BYTES_FLOOR', 256 * MiB),
  };
}

class UploadCapacityError extends Error {
  constructor(public readonly statusCode: 409 | 429, message: string) { super(message); }
}

type Totals = {
  user_bytes: string; org_bytes: string; all_bytes: string; held_bytes: string;
  user_count: string; org_count: string; all_count: string;
};

export class UploadCapacity {
  private readonly limits: UploadLimits;
  constructor(private readonly db: Database, private readonly storage: LocalStorage, limits?: Partial<UploadLimits>) {
    this.limits = { ...defaultLimits(), ...limits };
    if (!Object.values(this.limits).every(positiveLimit)) throw new Error('Limites de upload inválidos.');
  }

  async reserve(target: Target, objects: ObjectBudget[]) {
    if (!objects.length) return;
    const bytes = objects.reduce((total, item) => total + item.bytes, 0);
    const keys = objects.map(item => item.key);
    if (!positiveLimit(bytes) || new Set(keys).size !== keys.length || objects.some(item => !positiveLimit(item.bytes) || item.bytes > 200 * MiB)) {
      throw new Error('Reserva de armazenamento inválida.');
    }
    await mkdir(this.storage.root, { recursive: true, mode: 0o700 });
    await this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('matraca-upload-capacity',17))");
      const totals = (await client.query<Totals>(`
        WITH files AS (
          SELECT org_id,actor_id,bytes,false AS pending FROM stored_uploads
          UNION ALL SELECT org_id,actor_id,bytes,true FROM upload_reservations
        ), recent AS (
          SELECT coalesce(sum(quantity) FILTER(WHERE org_id=$1 AND actor_id=$2),0) AS user_count,
            coalesce(sum(quantity) FILTER(WHERE org_id=$1),0) AS org_count,coalesce(sum(quantity),0) AS all_count
          FROM upload_admissions WHERE admitted_at>clock_timestamp()-interval '24 hours'
        ), capacity AS (
        SELECT coalesce(sum(bytes) FILTER(WHERE org_id=$1 AND actor_id=$2),0) AS user_bytes,
          coalesce(sum(bytes) FILTER(WHERE org_id=$1),0) AS org_bytes,
          coalesce(sum(bytes),0) AS all_bytes,coalesce(sum(bytes) FILTER(WHERE pending),0) AS held_bytes
          FROM files
        )
        SELECT * FROM capacity CROSS JOIN recent`, [target.orgId, target.actorId])).rows[0];
      const capacity = this.limits;
      if (Number(totals.user_count) + objects.length > capacity.actorCount
        || Number(totals.org_count) + objects.length > capacity.orgCount
        || Number(totals.all_count) + objects.length > capacity.instanceCount
        || Number(totals.user_bytes) + bytes > capacity.actorBytes
        || Number(totals.org_bytes) + bytes > capacity.orgBytes
        || Number(totals.all_bytes) + bytes > capacity.instanceBytes) {
        throw new UploadCapacityError(429, 'O limite de armazenamento ou envios foi atingido.');
      }
      const disk = await statfs(this.storage.root, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(capacity.minimumFreeBytes) + BigInt(totals.held_bytes) + BigInt(bytes)) {
        throw new UploadCapacityError(429, 'O armazenamento local está sem espaço disponível.');
      }
      await client.query(`INSERT INTO upload_reservations(object_key,org_id,actor_id,bytes,expires_at)
        SELECT item.key,$1,$2,item.bytes,clock_timestamp()+make_interval(secs=>$5)
        FROM unnest($3::text[],$4::bigint[]) AS item(key,bytes)`,
      [target.orgId, target.actorId, keys, objects.map(item => item.bytes), reservationSeconds]);
      await client.query('INSERT INTO upload_admissions(org_id,actor_id,quantity) VALUES($1,$2,$3)',
        [target.orgId, target.actorId, objects.length]);
    });
  }

  async lock(client: PoolClient, keys: string[]) {
    if (!keys.length) return;
    const result = await client.query(`SELECT object_key FROM upload_reservations
      WHERE object_key=ANY($1::text[]) AND expires_at>clock_timestamp()
      ORDER BY object_key FOR UPDATE`, [keys]);
    if (result.rowCount !== keys.length) throw new UploadCapacityError(409, 'A reserva de armazenamento expirou.');
  }

  async commit(client: PoolClient, keys: string[]) {
    if (!keys.length) return;
    const result = await client.query(
      'DELETE FROM upload_reservations WHERE object_key=ANY($1::text[]) AND expires_at>clock_timestamp()', [keys],
    );
    if (result.rowCount !== keys.length) throw new UploadCapacityError(409, 'A reserva de armazenamento expirou.');
  }

  async reconcile(keys?: string[]) {
    if (keys && !keys.length) return;
    return this.db.transaction(async client => {
      const items = await client.query<{ object_key: string }>(`SELECT object_key FROM upload_reservations
        WHERE ${keys ? 'object_key=ANY($1::text[])' : 'expires_at<=clock_timestamp()'}
        ORDER BY expires_at,object_key LIMIT 100 FOR UPDATE SKIP LOCKED`, keys ? [keys] : []);
      for (const { object_key: key } of items.rows) {
        await this.storage.removeUploadTemporary(key);
        const reference = await client.query('SELECT 1 FROM stored_uploads WHERE object_key=$1 LIMIT 1', [key]);
        if (!reference.rowCount) await this.storage.removeUploadObject(key);
        await client.query('DELETE FROM upload_reservations WHERE object_key=$1', [key]);
      }
      if (!keys) await client.query("DELETE FROM upload_admissions WHERE admitted_at<=clock_timestamp()-interval '24 hours'");
      return items.rowCount ?? 0;
    });
  }
}

/** Starts before consuming multipart and protects the final write if the caller disconnects. */
export function uploadDeadline(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => { if (!reply.raw.writableEnded) abort(); };
  const timer = setTimeout(() => {
    abort();
    if (!request.raw.complete) request.raw.destroy();
  }, uploadTimeoutMs);
  timer.unref();
  if (request.raw.aborted || reply.raw.destroyed) abort();
  request.raw.once('aborted', abort);
  reply.raw.once('close', closed);
  return {
    signal: controller.signal,
    received: () => clearTimeout(timer),
    close: () => {
      clearTimeout(timer);
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', closed);
    },
  };
}
