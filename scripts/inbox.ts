import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { mailboxRoot } from '../server/auth.js';
import { configuration } from '../server/config.js';

const args = process.argv.slice(2);
const filters: { email?: string; host?: string } = {};
let help = false;
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === '--help' || option === '-h') { help = true; break; }
  const value = args[++index];
  if ((option !== '--email' && option !== '--host') || !value || value.startsWith('--')) {
    process.stderr.write('Use: npx tsx scripts/inbox.ts [--email pessoa@exemplo.test] [--host matraca.localhost]\n');
    process.exitCode = 1;
    help = true;
    break;
  }
  if (option === '--email') filters.email = value.trim().toLowerCase();
  else filters.host = value.toLowerCase();
}

if (help) {
  if (!process.exitCode) process.stdout.write('Use: npx tsx scripts/inbox.ts [--email pessoa@exemplo.test] [--host matraca.localhost]\n');
} else {
  const root = mailboxRoot(configuration().storageRoot);
  const mailSchema = z.object({
    id: z.uuid(), orgId: z.uuid(), hostname: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    to: z.email(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), link: z.url(),
  });
  const messages: z.infer<typeof mailSchema>[] = [];
  const organizations = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const organization of organizations) {
    if (!organization.isDirectory() || !z.uuid().safeParse(organization.name).success) continue;
    const directory = join(root, organization.name);
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const location = join(directory, file.name);
      if ((await stat(location)).size > 16 * 1024) continue;
      let data: unknown;
      try { data = JSON.parse(await readFile(location, 'utf8')); } catch { continue; }
      const parsed = mailSchema.safeParse(data);
      if (!parsed.success || parsed.data.orgId !== organization.name) continue;
      const mail = parsed.data;
      if (filters.email && mail.to.toLowerCase() !== filters.email) continue;
      if (filters.host && mail.hostname !== filters.host) continue;
      const link = new URL(mail.link);
      if (link.protocol !== 'http:' || link.hostname !== mail.hostname || link.pathname !== '/api/auth/consume') continue;
      messages.push(mail);
    }
  }
  messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  process.stdout.write('Caixa local de demonstração. Não comprova controle de um endereço de e-mail.\n');
  if (messages.length === 0) process.stdout.write('Nenhuma mensagem encontrada para este filtro.\n');
  for (const mail of messages.slice(-20)) {
    const expired = Date.parse(mail.expiresAt) <= Date.now() ? ' [expirado]' : '';
    process.stdout.write(`\n${mail.createdAt} | ${mail.hostname} | ${mail.to}${expired}\n${mail.link}\n`);
  }
  if (messages.length) process.stdout.write('\nExibidas até 20 mensagens recentes. Links já utilizados não podem ser reutilizados.\n');
}
