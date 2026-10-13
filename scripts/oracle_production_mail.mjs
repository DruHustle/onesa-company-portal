// One harmless owner-inbox notification through the real executor and existing provider.
import {randomUUID} from 'node:crypto';
const id=randomUUID(),recipient='info@onesa.eu';
let providerId,providerHttp,requests=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async function(input,options){
 const response=await originalFetch(input,options);
 if(String(input)==='https://api.resend.com/emails'&&options?.method==='POST'){
  requests++;providerHttp=response.status;
  if(response.ok){const result=await response.clone().json();if(typeof result.id==='string')providerId=result.id;}
 }return response;
};
const {env,emailConfig}=await import('./dist/src/config/env.js');
const {db}=await import('./dist/src/services/db.js');
const {databaseReady}=await import('./dist/src/services/database-readiness.js');
const {encrypt}=await import('./dist/src/auth/crypto.js');
const {tick}=await import('./dist/src/jobs/worker.js');
let created=false;
const report={scope:'one synthetic production mail notification',recipient,
 real_candidate_data_used:false,delivery_verified:false,unrestricted_worker_enabled:false};
try{
 if(new URL(env.DATABASE_URL).hostname!=='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech'||emailConfig.MAIL_PROVIDER!=='resend')throw Error('Target');
 await databaseReady(db,true);
 const counts=(await db.query("SELECT (SELECT count(*)::int FROM users)+(SELECT count(*)::int FROM files)+(SELECT count(*)::int FROM jobs)+(SELECT count(*)::int FROM applications)+(SELECT count(*)::int FROM enquiries)+(SELECT count(*)::int FROM storage_deletions) AS records")).rows[0];
 if(counts.records!==0)throw Error('Existing business data must remain untouched');
 await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'email',$2,$3)",[id,'oracle-production-mail-qualification:'+id,JSON.stringify({to:recipient,subject:'ONESA Oracle worker qualification — synthetic test',encryptedText:encrypt('This is one harmless synthetic production worker qualification notification. No applicant or customer data is included. Qualification reference: '+id)})]);created=true;
 await tick();
 const row=(await db.query('SELECT status,attempts FROM jobs WHERE id=$1',[id])).rows[0];
 report.job_accepted=row.status==='accepted'&&row.attempts===1;
 report.oracle_provider_acceptance_observed=providerHttp===200&&typeof providerId==='string';
 report.provider_http=providerHttp;report.provider_receipt_id=providerId;
 if(!report.job_accepted||!report.oracle_provider_acceptance_observed)throw Error('Provider acceptance not observed');
 await tick();report.accepted_mail_not_repeated=requests===1;
 const receipt=await originalFetch('https://api.resend.com/emails/'+providerId,{headers:{Authorization:'Bearer '+emailConfig.RESEND_API_KEY},redirect:'error'});
 report.delivery_status_inspection_http=receipt.status;
 if(receipt.ok){const data=await receipt.json();report.delivery_event=data.last_event;report.delivery_verified=data.last_event==='delivered';}
 report.passed=report.accepted_mail_not_repeated;
}catch{report.passed=false;report.reason='production_mail_acceptance_not_verified';process.exitCode=1;}
finally{
 if(created)await db.query('DELETE FROM jobs WHERE id=$1 AND dedupe_key=$2',[id,'oracle-production-mail-qualification:'+id]);
 report.run_owned_job_removed=created;
 await db.end();globalThis.fetch=originalFetch;console.log(JSON.stringify(report));
}
