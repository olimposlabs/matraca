import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
export class LocalStorage {
  constructor(readonly root: string) {}
  path(key: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(key)) throw new Error('Chave de objeto inválida');
    return join(this.root, key);
  }
  async put(key: string, source: Readable, options?: { bytes: number; signal: AbortSignal }) {
    const destination = this.path(key);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = options ? this.uploadTemporary(key) : `${destination}.${randomUUID()}.tmp`;
    try {
      const sink = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      if (options) {
        let remaining = options.bytes;
        const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          remaining -= chunk.byteLength;
          if (remaining < 0) return callback(Object.assign(new Error('O arquivo excede o limite de bytes.'), { statusCode: 413 }));
          callback(null, chunk);
        } });
        await pipeline(source, limit, sink, { signal: options.signal });
        options.signal.throwIfAborted();
      } else await pipeline(source, sink);
      await rename(temporary, destination);
    }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return this.info(key);
  }
  info(key: string) { return stat(this.path(key)); }
  read(key: string, range?: { start: number; end?: number }) { return createReadStream(this.path(key), range); }
  remove(key: string) { return unlink(this.path(key)); }
  private uploadTemporary(key: string) { return `${this.path(key)}.uploading`; }
  removeUploadTemporary(key: string) { return this.removeIfPresent(this.uploadTemporary(key)); }
  removeUploadObject(key: string) { return this.removeIfPresent(this.path(key)); }
  private async removeIfPresent(path: string) {
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
