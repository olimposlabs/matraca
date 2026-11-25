import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function sandboxPaths(name: string) {
  const storage = resolve('.data', 'sandboxes-v2', name);
  const workspaceId = createHash('sha256').update(storage).digest('hex').slice(0, 12);
  return {
    storage,
    schema: `matraca_sandbox_${name}_${workspaceId}`,
    domainSuffix: `${name.replaceAll('_', '-')}-${workspaceId}.matraca.localhost`,
  };
}
