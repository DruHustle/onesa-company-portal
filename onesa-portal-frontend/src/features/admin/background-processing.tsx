'use client';
import {useEffect,useState} from 'react';
import {api,ApiError} from '@/lib/api/client';
import type {operations} from '@/lib/api/generated/schema';
type Overview=operations['processingOverview']['responses'][200]['content']['application/json'];
type Jobs=operations['listProcessingJobs']['responses'][200]['content']['application/json'];
export function BackgroundProcessing(){
 const [overview,setOverview]=useState<Overview|null>(null),[jobs,setJobs]=useState<Jobs|null>(null),[page,setPage]=useState(1),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');
  void Promise.all([api.GET('/api/v1/admin/processing/overview',{signal:controller.signal}),api.GET('/api/v1/admin/processing/jobs',{signal:controller.signal,params:{query:{page,limit:20,status:status?status as 'pending'|'running'|'accepted'|'failed':undefined}}})]).then(([o,j])=>{if(!controller.signal.aborted){setOverview(o.data!);setJobs(j.data!);}}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof ApiError?e.message:'Processing status is temporarily unavailable. Try again.');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
  return()=>controller.abort();
 },[page,status]);
 return <section aria-labelledby="processing-title"><p className="eyebrow">Onesa Company Portal · Administration · Internal</p><h2 id="processing-title">Background Processing</h2><p>Asynchronous jobs, private quarantine and observed operations.</p>
 {error&&<p role="alert" className="admin-notice">{error}</p>}{busy&&<p role="status">Loading processing records…</p>}
 {overview&&<><div className="admin-stats"><div className="admin-card"><h3>Queue age</h3><strong>{Math.round(overview.oldestQueueAgeSeconds)} s</strong></div><div className="admin-card"><h3>Quarantine</h3><strong>{overview.quarantineFiles}</strong></div><div className="admin-card"><h3>Worker observation</h3><p>{overview.workerState.replaceAll('_',' ')}</p><time>{overview.workerLastSuccessAt||'No successful observation recorded'}</time></div><div className="admin-card"><h3>Backup observation</h3><time>{overview.backupLastSuccessAt||'No successful observation recorded'}</time></div></div>
 <div className="admin-card"><h3>Scanner and email</h3><p>Scanner: {overview.scannerConfigurationPresent?'Configuration present; live readiness requires runtime evidence':'Scanner configuration unavailable in this API runtime'}.</p><p>{overview.mailAcceptanceNote}</p><p>All timestamps identify recorded observations; configuration presence does not establish delivery or current health.</p></div>
 <details><summary>Action prerequisites</summary>{overview.mutationRestrictions.map(x=><p key={x}>{x}</p>)}</details></>}
 <label style={{maxWidth:300}}>Job state<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">All states</option>{['pending','running','accepted','failed'].map(x=><option key={x}>{x}</option>)}</select></label>
 {jobs&&<><div className="table-wrap" role="region" aria-label="Background processing jobs" tabIndex={0}><table><thead><tr><th>Job</th><th>Type</th><th>State</th><th>Attempts</th><th>Run time</th><th>Diagnostic</th></tr></thead><tbody>{jobs.items.map(j=><tr key={j.id}><td>{j.id}</td><td>{j.kind}</td><td>{j.status}</td><td>{j.attempts}</td><td><time dateTime={j.run_at}>{j.run_at}</time></td><td>{j.errorCategory?.replaceAll('_',' ')||'No recorded error'}</td></tr>)}</tbody></table></div>{jobs.items.length===0&&<p>No jobs match this state.</p>}<div className="admin-actions"><button disabled={busy||page===1} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page} · {jobs.total} jobs</span><button disabled={busy||page*20>=jobs.total} onClick={()=>setPage(page+1)}>Next</button></div></>}
 </section>;
}
