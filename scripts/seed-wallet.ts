import type {PoolClient} from 'pg';
import {grantInitialCreditInTransaction} from '../server/wallet.js';
export async function seedWallet(client:PoolClient,id:(key:string)=>string){
 if(!(await client.query("SELECT to_regclass('wallets') IS NOT NULL AS ready")).rows[0].ready)return;
 const people=await client.query<{id:string;org_id:string;slug:string;email:string}>("SELECT u.id,u.org_id,o.slug,u.email FROM users u JOIN orgs o ON o.id=u.org_id WHERE o.slug IN ('matraca','parceiro') AND 'student'=ANY(u.roles) AND u.status='active'");
 for(const person of people.rows.filter(person=>person.org_id===id(person.slug)&&person.id===id(`${person.slug}:${person.email}`)))await grantInitialCreditInTransaction(client,{orgId:person.org_id,userId:person.id});
 const orgs=await client.query<{id:string;slug:string}>("SELECT id,slug FROM orgs WHERE slug IN ('matraca','parceiro')");
 for(const org of orgs.rows.filter(org=>org.id===id(org.slug)))for(const pack of [{name:'Prática extra',amount:5},{name:'Apresentação completa',amount:20},{name:'Plano de prática',amount:50}])await client.query('INSERT INTO credit_grant_packages(id,org_id,name,amount,description) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[id(`grant-package:${org.slug}:${pack.amount}`),org.id,pack.name,pack.amount,'Modelo administrativo para concessão; não representa uma compra.']);
}
