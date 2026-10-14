import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {provisionTarget} from '../src/services/provision-target.js';

test('Operator provisioning admits the established direct Portal identity only',()=>{
 const host='ep-dark-boat-b91lg22g.c-7.eu-central-1.aws.neon.tech';
 const raw=`postgresql://operator:synthetic-only@${host}/neondb?sslmode=require&channel_binding=require`;
 assert.equal(provisionTarget(raw,host,'neondb').hostname,host);
 for(const candidate of [raw.replace(host,'ai.example.com'),raw.replace(host,host.replace('.c-7','-pooler.c-7')),raw.replace('sslmode=require','sslmode=disable'),raw+'&sslmode=disable']) {
  assert.throws(()=>provisionTarget(candidate,new URL(candidate).hostname,'neondb'),/reviewed Portal target/);
 }
});

test('Operator target mismatch and malformed URLs fail without disclosing input',()=>{
 const marker='synthetic-private-marker';
 const raw=`postgresql://operator:${marker}@localhost/onesa_portal_test`;
 assert.equal(provisionTarget(raw,'localhost','onesa_portal_test').pathname,'/onesa_portal_test');
 for(const [value,host,name] of [[raw,'localhost','other'],[raw,'wrong.example.com','onesa_portal_test'],['postgresql://user:'+marker+'@localhost/%ZZ','localhost','onesa_portal_test']]) {
  assert.throws(()=>provisionTarget(value,host,name),error=>error instanceof Error&&!error.message.includes(marker));
 }
});
