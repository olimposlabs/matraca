import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
export class LocalStorage {
  constructor(readonly root: string) {}
  path(key: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(key)) throw new Error('Chave de objeto inválida');
    return join(this.root, key);
  }
  async put(key: string, source: Readable) {
    const destination = this.path(key);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await pipeline(source, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })); await rename(temporary, destination); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return this.info(key);
  }
  info(key: string) { return stat(this.path(key)); }
  read(key: string, range?: { start: number; end?: number }) { return createReadStream(this.path(key), range); }
  remove(key: string) { return unlink(this.path(key)); }
}
