import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rootCertificates} from 'node:tls';
import {readFileSync} from 'node:fs';
import {databaseConnection} from '../src/services/database-tls.js';

const uri='postgresql://portal_app:synthetic@portal-db.example.test/portal_test?sslmode=verify-full';
const ca=Buffer.from(rootCertificates[0]).toString('base64');
test('private CA is scoped to a verified PostgreSQL connection',()=>{
 assert.deepEqual(databaseConnection(uri,undefined),{connectionString:uri});
 const config=databaseConnection(uri,ca);
 assert.equal(new URL(config.connectionString!).searchParams.has('sslmode'),false);
 assert.deepEqual(config.ssl,{ca:rootCertificates[0],rejectUnauthorized:true,servername:'portal-db.example.test'});
 assert.equal(config.enableChannelBinding,true);
});
test('private CA refuses unsafe connection options and malformed roots',()=>{
 for(const value of [uri.replace('verify-full','disable'),uri+'&sslmode=disable',uri+'&ssl=true',uri+'&sslrootcert=x',uri+'&channel_binding=require',uri.replace('postgresql:','https:')])assert.throws(()=>databaseConnection(value,ca),/CONFIGURATION_INVALID/);
 const blocked=readFileSync(new URL('../../scripts/fixtures/emsign-ecc-g3-public-cert.txt',import.meta.url),'utf8');
 for(const invalid of ['',ca+'a','x'.repeat(12001),Buffer.from(blocked).toString('base64'),Buffer.from(rootCertificates[0]+rootCertificates[0]).toString('base64')])assert.throws(()=>databaseConnection(uri,invalid),/CONFIGURATION_INVALID/);
});
