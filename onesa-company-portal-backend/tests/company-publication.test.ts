import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {approvedLegalNotice,synchronizeApprovedCompany} from '../src/services/company-publication.js';

test('Approved bilingual notices identify the controller without fabricated tax IDs or officers',()=>{
 for(const locale of ['en','de'] as const){
  const body=approvedLegalNotice(locale);
  for(const value of ['Onesa UG (haftungsbeschränkt)','Steinhofweg 47, 69123 Heidelberg','Andrew Gotora','Amtsgericht Mannheim','HRB 757830','info@onesa.eu','+49 151 474 16152'])assert.ok(body.includes(value));
  assert.ok(!/VAT|USt|DE\d{9}|Data Protection Officer|Datenschutzbeauftragter|pending|unresolved/i.test(body));
 }
});

test('CMS synchronization preserves existing publication state and revisions without approving privacy settings',async()=>{
 const calls:{sql:string;params?:unknown[]}[]=[];
 const old={id:'5065c880-02bc-48cf-94e6-7c6cda7a7d0a',title:'Old notice',body:'Old text',summary:'Old summary',state:'published',revision:4};
 const client={query:async(sql:string,params?:unknown[])=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT * FROM content'))return {rows:[old]};
  if(sql.startsWith('INSERT INTO content'))return {rows:[{...old,title:params![2],body:params![4],revision:5}]};
  return {rows:[]};
 }} as unknown as Pick<pg.PoolClient,'query'>;
 await synchronizeApprovedCompany(client);
 assert.ok(calls.every(({sql})=>!sql.includes('settings')&&!sql.includes('users')&&!sql.includes('DELETE')&&!sql.includes('TRUNCATE')));
 const updates=calls.filter(({sql})=>sql.startsWith('INSERT INTO content'));
 assert.equal(updates.length,2);
 for(const {sql,params} of updates){
  assert.ok(!sql.split('DO UPDATE SET')[1].includes('state='));
  assert.equal(JSON.parse(String(params![5])).economicIdentifierAssignmentVerified,false);
 }
 const revisions=calls.filter(({sql})=>sql.startsWith('INSERT INTO revisions'));
 assert.equal(revisions.length,4);
 assert.deepEqual(JSON.parse(String(revisions[0].params![1])),old);
 assert.ok(calls.filter(({sql})=>sql.startsWith('INSERT INTO facts')).every(({params})=>String(params![2]).includes('Owner-approved')&&String(params![2]).includes('not an independent register extract')));
});
