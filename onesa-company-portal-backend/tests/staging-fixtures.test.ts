import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {createFixtureAccounts,revokeFixtureAccounts,stagingDatabaseURL} from '../src/auth/staging-fixtures.js';

test('Temporary fixture database binding rejects production, owner roles and non-TLS targets',()=>{
 const value='postgresql://onesa_portal_app:synthetic-password@ep-autumn-glade-b9760olg-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=require';
 assert.equal(stagingDatabaseURL(value).searchParams.get('sslmode'),'verify-full');
 for(const changed of [value.replace('autumn-glade-b9760olg','dark-boat-b91lg22g'),value.replace('onesa_portal_app:','neondb_owner:'),value.replace('/neondb','/customer'),value.replace('sslmode=require','sslmode=disable'),value+'&sslmode=disable',value+'#private'])assert.throws(()=>stagingDatabaseURL(changed));
});

test('Temporary fixtures create distinct synthetic identities and revoke only exact owned IDs/emails',async()=>{
 const statements:{sql:string;args:unknown[]}[]=[];
 const client={query:async(sql:string,args:unknown[]=[])=>{statements.push({sql,args});return {rows:[],rowCount:1};}} as unknown as Pick<pg.PoolClient,'query'>;
 const accounts=await createFixtureAccounts(client,'12345',{password:value=>'hashed:'+value,secret:value=>'encrypted:'+value});
 assert.equal(accounts.length,2);assert.equal(new Set(accounts.map(account=>account.email)).size,2);
 assert.ok(accounts.every(account=>/^release-audit-12345-[a-f0-9]{24}@example\.com$/.test(account.email)&&account.password.length>=32&&/^[A-Z2-7]{32}$/.test(account.totp_secret)));
 assert.ok(statements.every(item=>item.sql.startsWith('INSERT INTO users(')&&!item.sql.includes('ON CONFLICT')));
 assert.deepEqual(statements.map(item=>item.args[3]),['administrator','viewer']);
 statements.length=0;
 await assert.rejects(revokeFixtureAccounts(client,'99999',accounts),/OWNERSHIP/);
 await assert.rejects(revokeFixtureAccounts(client,'12345',[{...accounts[0],email:'existing-customer@example.com'},accounts[1]]),/OWNERSHIP/);
 assert.equal(statements.length,0);
 await revokeFixtureAccounts(client,'12345',accounts);
 assert.deepEqual(statements.map(item=>item.sql),[
  'UPDATE users SET disabled=true WHERE id=$1 AND email=$2 RETURNING id','DELETE FROM sessions WHERE user_id=$1',
  'UPDATE users SET disabled=true WHERE id=$1 AND email=$2 RETURNING id','DELETE FROM sessions WHERE user_id=$1',
 ]);
 assert.deepEqual(statements[0].args,[accounts[0].id,accounts[0].email]);
});
