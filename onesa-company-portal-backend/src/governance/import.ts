import {readFile} from 'node:fs/promises';
import {db,transaction} from '../services/db.js';
import {governanceTarget} from './target.js';
import {databaseReady} from '../services/database-readiness.js';
import {normalizeSeed} from './seed.js';
import {insertVersion,recordEvent} from './store.js';

/** Transactional insert-only import. Every existing record/revision is preserved. */
export async function importGovernance(raw:unknown,context?:unknown){
 const bundle=normalizeSeed(raw,context);
 return transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(757843)');
  const inserted:string[]=[],preserved:string[]=[],skipped:string[]=[];
  for(const item of bundle.records){
   const exists=await c.query('SELECT stable_id FROM governance_records WHERE stable_id=$1 FOR UPDATE',[item.id]);
   if(exists.rowCount){preserved.push(item.id);continue;}
   if(item.documentId&&!inserted.includes(item.documentId)){
    // Do not append old package children to a pre-existing reviewed/amended document.
    skipped.push(item.id);continue;
   }
   await c.query('INSERT INTO governance_records(stable_id,kind,document_id,current_revision,seed_fingerprint) VALUES($1,$2,$3,1,$4)',[item.id,item.kind,item.documentId,bundle.seedFingerprint]);
   await insertVersion(c,item.id,1,item.snapshot,null,item.sourceFile);
   await recordEvent(c,item.id,1,'draft.imported',null,'Owner-supplied draft package; no policy, DPA or processing approval inferred.','INTERNAL draft import');
   inserted.push(item.id);
  }
  const counts=(await c.query("SELECT kind,count(*)::int AS count FROM governance_records GROUP BY kind ORDER BY kind")).rows;
  return {inserted,preserved,skipped,counts,seedFingerprint:bundle.seedFingerprint,automaticDeletionEnabled:false,publicationEnabled:false};
 });
}
async function main(){
 const args=process.argv.slice(2),file=args[0],contextIndex=args.indexOf('--context');
 if(!file||args.some((arg,index)=>index>0&&arg!=='--context'&&index!==contextIndex+1))throw new Error('Usage: privacy:import <private-seed.json> [--context <private-context.json>]');
 const expectedHost=process.env.PORTAL_EXPECTED_DB_HOST,expectedDatabase=process.env.PORTAL_EXPECTED_DB_NAME;
 if(!expectedHost||!expectedDatabase||!process.env.DATABASE_URL)throw new Error('Existing PORTAL_EXPECTED_DB_HOST, PORTAL_EXPECTED_DB_NAME and private DATABASE_URL are required');
 governanceTarget(process.env.DATABASE_URL,expectedHost,expectedDatabase);
 await databaseReady(db,process.env.NODE_ENV==='production');
 const source=await readFile(file,'utf8');if(Buffer.byteLength(source)>1024*1024)throw new Error('Seed package exceeds import limit');
 const context=contextIndex<0?undefined:JSON.parse(await readFile(args[contextIndex+1],'utf8'));
 console.log(JSON.stringify(await importGovernance(JSON.parse(source),context)));
}
if(process.argv[1]?.endsWith('/governance/import.ts')||process.argv[1]?.endsWith('/governance/import.js')){
 main().catch(()=>{console.error('Privacy draft import failed; inspect privately. No source content or credentials emitted.');process.exitCode=1;}).finally(()=>db.end());
}
