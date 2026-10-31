// No documents or customer messages are read. Aggregate queue/scanner metrics only.
const args=process.argv.slice(2);
if(args.length>1||(args.length===1&&args[0]!=='--scanner-only')){
 console.error('Invalid metrics mode');
 process.exitCode=2;
}else{
 const result={scanner_ready:false};
 // The consumer-visible marker must still be checked when the database is down.
 // Keep this import independent: scanner-only recovery never loads a database client.
 try{
  const {scannerStatusCurrent}=await import('./dist/src/services/storage.js');
  const ready=await scannerStatusCurrent();
  if(typeof ready==='boolean')result.scanner_ready=ready;
 }catch{/* Generic unavailable state, never serialize provider exceptions. */}
 if(args.length===0){
  result.database_available=false;
  let db;
  try{
   ({db}=await import('./dist/src/services/db.js'));
   const r=await db.query("SELECT (SELECT count(*)::int FROM jobs WHERE status='failed')+(SELECT count(*)::int FROM storage_deletions WHERE status='failed') AS failed_jobs,(SELECT coalesce(extract(epoch FROM now()-min(created_at)),0)::float FROM jobs WHERE status IN ('pending','running')) AS queue_age_seconds,(SELECT coalesce(extract(epoch FROM now()-min(run_at)),0)::float FROM storage_deletions WHERE status IN ('pending','running')) AS deletion_age_seconds");
   const row=r.rows[0];
   if(!Number.isSafeInteger(row.failed_jobs)||row.failed_jobs<0
      ||typeof row.queue_age_seconds!=='number'||!Number.isFinite(row.queue_age_seconds)
      ||typeof row.deletion_age_seconds!=='number'||!Number.isFinite(row.deletion_age_seconds))throw Error('Invalid aggregate metrics');
   // A future scheduled deletion has a legitimate negative age. Preserve it.
   Object.assign(result,{database_available:true,failed_jobs:row.failed_jobs,
    queue_age_seconds:row.queue_age_seconds,deletion_age_seconds:row.deletion_age_seconds});
  }catch{/* Database failure must not overwrite independently observed scanner readiness. */}
  finally{
   try{if(db)await db.end();}catch{/* Cleanup failure must not discard collected evidence. */}
  }
 }
 console.log(JSON.stringify(result));
}
