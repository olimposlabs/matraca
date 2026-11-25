import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { LocalStorage } from '../server/storage.js';
import { UploadCapacity } from '../server/upload-capacity.js';

describe('capacidade de upload persistida', () => {
  const schema = `upload_test_${randomUUID().replaceAll('-', '')}`;
  const base = new URL(process.env.DATABASE_URL ?? localDatabaseUrl);
  const control = createDatabase(base.href);
  base.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(base.href);
  let storage: LocalStorage;
  let migratedKey: string;
  async function actor() {
    const orgId = randomUUID(), actorId = randomUUID();
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'Organização de teste','partner')", [orgId, `upload-${orgId}`]);
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,'tester@example.test','Pessoa de teste',ARRAY['student'],'active')",
      [actorId, orgId]);
    return { orgId, actorId };
  }
  beforeAll(async () => {
    await control.query(`CREATE SCHEMA ${schema}`);
    const directory = new URL('../server/migrations/', import.meta.url);
    for (const entry of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      if (entry.startsWith('017_')) {
        const target = await actor();
        migratedKey = `branding/${target.orgId}/${randomUUID()}`;
        await db.query("INSERT INTO logo_assets(org_id,key,content_type,width,height,bytes,created_by) VALUES($1,$2,'image/webp',1,1,13,$3)",
          [target.orgId, migratedKey, target.actorId]);
      }
      await db.query(await readFile(new URL(entry, directory), 'utf8'));
    }
    storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'matraca-upload-capacity-')));
  });
  afterAll(async () => {
    await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
    if (storage) await rm(storage.root, { recursive: true, force: true });
  });

  it('inclui arquivos preexistentes nas cotas sem alterar metadados', async () => {
    const migrated = (await db.query('SELECT org_id,actor_id,bytes FROM stored_uploads WHERE object_key=$1', [migratedKey])).rows[0];
    expect(Number(migrated.bytes)).toBe(13);
    expect((await db.query('SELECT quantity FROM upload_admissions WHERE org_id=$1 AND actor_id=$2',
      [migrated.org_id, migrated.actor_id])).rows).toEqual([{ quantity: 1 }]);
    expect((await db.query('SELECT key FROM logo_assets WHERE key=$1', [migratedKey])).rows).toEqual([{ key: migratedKey }]);
  });

  it('serializa capacidade concorrente em organizações diferentes e conserva o uso de tentativas', async () => {
    const [first, second] = await Promise.all([actor(), actor()]);
    const capacity = new UploadCapacity(db, storage, { instanceBytes: 200, actorCount: 1 });
    const objects = [first, second].map(target => ({ key: `recordings/${target.orgId}/${randomUUID()}`, bytes: 150 }));
    const results = await Promise.allSettled([first, second].map((target, index) => capacity.reserve(target, [objects[index]])));
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ statusCode: 429 });
    const index = results.findIndex(result => result.status === 'fulfilled');
    await capacity.reconcile([objects[index].key]);
    expect((await db.query('SELECT object_key FROM upload_reservations')).rowCount).toBe(0);
    await expect(capacity.reserve([first, second][index], [objects[index]])).rejects.toMatchObject({ statusCode: 429 });
  });

  it('remove restos de falha após expirar e preserva um objeto referenciado', async () => {
    const target = await actor();
    const capacity = new UploadCapacity(db, storage);
    const orphan = `branding/${target.orgId}/${randomUUID()}`;
    const kept = `branding/${target.orgId}/${randomUUID()}`;
    await capacity.reserve(target, [{ key: orphan, bytes: 20 }, { key: kept, bytes: 20 }]);
    for (const key of [orphan, kept]) await storage.put(key, Readable.from(Buffer.from('imagem sintética')), { bytes: 20, signal: AbortSignal.timeout(5000) });
    await writeFile(`${storage.path(orphan)}.uploading`, 'recebimento parcial');
    await db.query("INSERT INTO logo_assets(org_id,key,content_type,width,height,bytes,created_by) VALUES($1,$2,'image/webp',1,1,17,$3)",
      [target.orgId, kept, target.actorId]);
    await db.query("UPDATE upload_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE org_id=$1", [target.orgId]);
    await expect(db.transaction(client => capacity.lock(client, [orphan]))).rejects.toMatchObject({ statusCode: 409 });
    expect(await new UploadCapacity(db, storage).reconcile()).toBe(2);
    await expect(storage.info(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${storage.path(orphan)}.uploading`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(storage.path(kept), 'utf8')).toBe('imagem sintética');
  });

  it('solta todas as reservas de uma cópia cancelada em lote', async () => {
    const target = await actor();
    const capacity = new UploadCapacity(db, storage);
    const staged = Array.from({ length: 105 }, () => ({ key: `course-assets/${target.orgId}/${randomUUID()}`, bytes: 10 }));
    await capacity.reserve(target, staged);
    expect(await capacity.reconcile(staged.map(item => item.key))).toBe(105);
    expect((await db.query('SELECT object_key FROM upload_reservations WHERE org_id=$1', [target.orgId])).rowCount).toBe(0);
  });

  it('remove um arquivo parcial quando o sinal de recepção é interrompido', async () => {
    const target = await actor();
    const capacity = new UploadCapacity(db, storage);
    const key = `recordings/${target.orgId}/${randomUUID()}`;
    await capacity.reserve(target, [{ key, bytes: 100 }]);
    await mkdir(dirname(storage.path(key)), { recursive: true });
    const sender = new Readable({ read() {} });
    const controller = new AbortController();
    const upload = storage.put(key, sender, { bytes: 100, signal: controller.signal });
    sender.push(Buffer.from('parte recebida'));
    await expect.poll(async () => (await readFile(`${storage.path(key)}.uploading`).catch(() => Buffer.alloc(0))).length).toBe(14);
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    await capacity.reconcile([key]);
    await expect(storage.info(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${storage.path(key)}.uploading`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
