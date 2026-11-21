import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {db,transaction} from '../services/db.js';
import {governanceTarget} from './target.js';
import {databaseReady} from '../services/database-readiness.js';
import {normalizeSeed,seedSchema} from './seed.js';
import {insertVersion,recordEvent} from './store.js';

/** Transactional insert-only import. Every existing record/revision is preserved. */
export async function importGovernance(raw:unknown,context?:unknown,options:{dryRun?:boolean}={}){
 const bundle=normalizeSeed(raw,context);
 return transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(757843)');
  const inserted:string[]=[],plannedInserts:string[]=[],preserved:string[]=[],skipped:string[]=[];
  for(const item of bundle.records){
   const exists=await c.query('SELECT stable_id FROM governance_records WHERE stable_id=$1 FOR UPDATE',[item.id]);
   if(exists.rowCount){preserved.push(item.id);continue;}
   if(item.documentId&&!plannedInserts.includes(item.documentId)){
    // Do not append old package children to a pre-existing reviewed/amended document.
    skipped.push(item.id);continue;
   }
   plannedInserts.push(item.id);
   if(options.dryRun)continue;
   await c.query('INSERT INTO governance_records(stable_id,kind,document_id,current_revision,seed_fingerprint) VALUES($1,$2,$3,1,$4)',[item.id,item.kind,item.documentId,bundle.seedFingerprint]);
   await insertVersion(c,item.id,1,item.snapshot,null,item.sourceFile);
   await recordEvent(c,item.id,1,'draft.imported',null,'Owner-supplied draft package; no policy, DPA or processing approval inferred.','INTERNAL draft import');
   inserted.push(item.id);
  }
  const counts=(await c.query("SELECT kind,count(*)::int AS count FROM governance_records GROUP BY kind ORDER BY kind")).rows;
  return {dryRun:options.dryRun??false,inserted,plannedInserts,preserved,skipped,counts,sourceCounts:bundle.sourceCounts,seedVersion:bundle.seedVersion,seedFingerprint:bundle.seedFingerprint,automaticDeletionEnabled:false,publicationEnabled:false};
 });
}
async function main(){
 const args=process.argv.slice(2),file=args[0];let contextFile:string|undefined,dryRun=false;
 if(!file)throw new Error('Usage: privacy:import <private-seed.json> [--context <private-context.json>] [--dry-run]');
 for(let index=1;index<args.length;index++){
  if(args[index]==='--dry-run'&&!dryRun)dryRun=true;
  else if(args[index]==='--context'&&!contextFile&&args[index+1]&&!args[index+1].startsWith('--'))contextFile=args[++index];
  else throw new Error('Invalid privacy import arguments');
 }
 const expectedHost=process.env.PORTAL_EXPECTED_DB_HOST,expectedDatabase=process.env.PORTAL_EXPECTED_DB_NAME;
 if(!expectedHost||!expectedDatabase||!process.env.DATABASE_URL)throw new Error('Existing PORTAL_EXPECTED_DB_HOST, PORTAL_EXPECTED_DB_NAME and private DATABASE_URL are required');
 governanceTarget(process.env.DATABASE_URL,expectedHost,expectedDatabase);
 await databaseReady(db,process.env.NODE_ENV==='production');
 const source=await readFile(file,'utf8');if(Buffer.byteLength(source)>1024*1024)throw new Error('Seed package exceeds import limit');
 const parsed=seedSchema.parse(JSON.parse(source));
 for(const document of parsed.documents){
  const markdown=await readFile(resolve(dirname(file),document.source_file),'utf8');
  if(markdown!==document.markdown)throw new Error('Policy source Markdown and structured seed do not match');
 }
 const context=contextFile?JSON.parse(await readFile(contextFile,'utf8')):undefined;
 console.log(JSON.stringify({...await importGovernance(parsed,context,{dryRun}),sourceFileSha256:createHash('sha256').update(source).digest('hex')}));
}
if(process.argv[1]?.endsWith('/governance/import.ts')||process.argv[1]?.endsWith('/governance/import.js')){
 main().catch(()=>{console.error('Privacy draft import failed; inspect privately. No source content or credentials emitted.');process.exitCode=1;}).finally(()=>db.end());
}
