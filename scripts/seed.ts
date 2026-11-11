import { createHash } from 'node:crypto';
import { createDatabase } from '../server/db.js';
import { configuration } from '../server/config.js';

export function seedId(value: string): string {
  const hex = createHash('sha256').update(`matraca-demo:${value}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
const organizations = [
  { slug: 'matraca', name: 'Matraca', kind: 'matraca', hosts: ['matraca.localhost','localhost','127.0.0.1'] },
  { slug: 'parceiro', name: 'Horizonte Oratória', kind: 'partner', hosts: ['parceiro.matraca.localhost','parceiro.localhost'] },
  { slug: 'backoffice', name: 'Matraca · Backoffice', kind: 'backoffice', hosts: ['backoffice.matraca.localhost','backoffice.localhost'] },
];
const students = ['Ana Silva','Bruno Lima','Carla Souza','Diego Alves','Elisa Rocha','Fabio Costa'];
const db = createDatabase(configuration().databaseUrl);
try {
  await db.transaction(async client => {
    await client.query("INSERT INTO app_metadata (key,value) VALUES ('demo', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ name: 'Matraca', mode: 'local', createdBy: 'seed' })]);
    const identityReady = (await client.query("SELECT to_regclass('orgs') IS NOT NULL AS ready")).rows[0].ready;
    if (!identityReady) return;
    for (const org of organizations) {
      const candidateId = seedId(org.slug);
      await client.query("INSERT INTO orgs (id,slug,name,kind,status,settings,branding) VALUES ($1,$2,$3,$4,'active',$5,$6) ON CONFLICT (slug) DO NOTHING", [candidateId,org.slug,org.name,org.kind,{ coursesEnabled:true, strictJourney:false },{ primary:'#c95032',background:'#faf8f2',creditSingular:'crédito',creditPlural:'créditos' }]);
      const orgId = (await client.query('SELECT id FROM orgs WHERE slug=$1',[org.slug])).rows[0].id;
      for (const hostname of org.hosts) await client.query('INSERT INTO domains (hostname,org_id) VALUES ($1,$2) ON CONFLICT (hostname) DO NOTHING',[hostname,orgId]);
      const people = org.kind==='backoffice' ? [{name:'Operador Matraca',email:'operador@matraca.test',roles:['operator']}] : [
        ...students.map((name,index)=>({name,email:index===0?'ana@exemplo.test':`aluno${index+1}@${org.slug}.test`,roles:['student']})),
        ...(org.kind==='partner' ? [
          {name:'Admin Horizonte',email:'admin@parceiro.test',roles:['org_admin']},
          {name:'Gestão Centro',email:'escola@parceiro.test',roles:['school']},
          ...[1,2,3].map(n=>({name:`Professor Horizonte ${n}`,email:`professor${n}@parceiro.test`,roles:['teacher']})),
        ]:[]),
      ];
      for (const person of people) await client.query("INSERT INTO users (id,org_id,email,name,roles,status,profile) VALUES ($1,$2,$3,$4,$5,'active',$6) ON CONFLICT (org_id,email) DO NOTHING",[seedId(`${org.slug}:${person.email}`),orgId,person.email,person.name,person.roles,{}]);
    }
  });
  process.stdout.write('Seed local conferido, sem sobrescrever dados existentes.\n');
} finally { await db.close(); }
