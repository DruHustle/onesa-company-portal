// Observations only. The pinned Python runner must verify its commissioned,
// atomically reserved scanner context before supplying this private input.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validate as fixturePlan,run as fixtureRun} from './oracle_portal_worker_fixture.mjs';
import {validate as workerPlan,runStaging} from './oracle_portal_worker_probe.mjs';

const need=(value)=>{if(!value)throw Error('SCANNER_WORKFLOW_SCOPE_OR_CHECK_FAILED');};
const keys=(value,expected)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...expected].sort().join(',');
const fields=['repository','component','candidate_commit','source_tree','source_sha256','build_sha256','artifact_digest','configuration_sha256','target_environment'];
export const requiredChecks=Object.freeze([
 'empty_owned_database_and_least_privilege','password_without_mfa_denied',
 'mfa_replay_denied_1','mfa_replay_denied_2','quarantine_download_denied',
 'anonymous_download_denied','restricted_role_download_denied','private_public_route_denied',
 'scanner_failure_retains_quarantine','real_worker_clean_and_infected_scan',
 'smtp_tls_acceptance_once','clean_download_integrity','infected_download_denied',
 'queued_private_object_actually_removed','deduplicated_work_not_repeated',
 'stale_lock_and_retry_exhaustion','staging_idle_backoff_observed',
 'sigterm_interrupts_idle_wait','real_login_sessions_survive_worker_restarts',
]);

export function validate(input,raw,actual,now=Date.now()){
 need(keys(input,['scanner_binding','fixture','worker_probe']));
 const binding=input.scanner_binding,probe=input.worker_probe;
 need(keys(binding,fields)&&binding.repository==='DruHustle/onesa-company-portal'&&binding.component==='scanner'&&binding.target_environment==='production');
 const checked=workerPlan(probe,raw,actual,now),fixture=fixturePlan(input.fixture,now);
 need(probe.environment==='staging'&&input.fixture.action==='provision');
 // The dependent worker image has its own real build/image identity. No scanner
 // approval is changed into a worker approval, and no dummy CI ID is generated.
 for(const field of ['repository','candidate_commit','source_tree','source_sha256','target_environment'])need(binding[field]===probe.binding[field]);
 need(/^[a-f0-9]{64}$/.test(binding.build_sha256)&&binding.build_sha256!==probe.binding.build_sha256);
 need(/^sha256:[a-f0-9]{64}$/.test(binding.artifact_digest)&&binding.artifact_digest!==probe.binding.artifact_digest);
 need(keys(binding.configuration_sha256,['staging','production'])&&Object.values(binding.configuration_sha256).every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)));
 need(input.fixture.source===binding.candidate_commit&&input.fixture.context_id===probe.operation_id&&input.fixture.fixture_id===probe.fixture_id&&input.fixture.expires_at===probe.expires_at);
 need(checked.database.username===fixture.runtime&&checked.database.pathname==='/'+fixture.database&&decodeURIComponent(checked.database.password)===input.fixture.runtime_password);
 return {binding,fixture,checked};
}

export async function observe(input,raw,actual=process.env,operations={fixture:fixtureRun,probe:runStaging}){
 const checked=validate(input,raw,actual);
 try{
  const ready=await operations.fixture(input.fixture);
  need(ready.state==='OWNED_STAGING_FIXTURE_PROVISIONED_NOT_AUTHORIZATION');
  need(Number.isSafeInteger(ready.applied_migrations)&&ready.applied_migrations>0);
  const observed=await operations.probe(input.worker_probe,raw);
  need(observed.state==='OWNED_STAGING_WORKER_OBSERVATIONS_NOT_AUTHORIZATION');
  need(keys(observed.checks,requiredChecks)&&Object.values(observed.checks).every(value=>value===true));
  need(observed.existing_application_databases_changed===false&&observed.global_tick_imported===false&&observed.inbox_delivery_verified===false);
  return {
   state:'SCANNER_DEPENDENCY_WORKFLOWS_OBSERVED_NOT_AUTHORIZATION',
   scanner_binding:checked.binding,application_binding:input.worker_probe.binding,
   ci_run_id:input.worker_probe.ci_run_id,checks:observed.checks,
   disposable_fixture_migrations:ready.applied_migrations,production_schema_migrations:0,
   existing_application_databases_changed:false,global_tick_imported:false,
   inbox_delivery_verified:false,worker_deployed:false,release_records_issued:0,
  };
 }finally{
  // Cleanup checks the exact source/context markers and refuses active clients.
  // A failed cleanup must fail the observation instead of emitting success.
  const removed=await operations.fixture({...input.fixture,action:'cleanup'});
  need(removed.state==='OWNED_STAGING_FIXTURE_REMOVED');
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  need(process.getuid()===1000);
  const chunks=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;need(bytes<=65536);chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const raw=await readFile('/private/runtime.env','utf8');
  console.log(JSON.stringify(await observe(input,raw)));
 }catch(error){
  const database_code=/^[0-9A-Z]{5}$/.test(error?.code||'')?error.code:undefined;
  console.log(JSON.stringify({state:'SCANNER_DEPENDENCY_WORKFLOWS_FAILED_NOT_QUALIFIED',database_code}));
  process.exitCode=1;
 }
}
