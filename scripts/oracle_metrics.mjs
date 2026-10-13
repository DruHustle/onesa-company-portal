// No documents or customer messages are read. Aggregate queue/scanner metrics only.
import {db} from './dist/src/services/db.js';
import {scannerStatusCurrent} from './dist/src/services/storage.js';
const result={database_available:false,scanner_ready:false};
try{
 const r=await db.query("SELECT (SELECT count(*)::int FROM jobs WHERE status='failed')+(SELECT count(*)::int FROM storage_deletions WHERE status='failed') AS failed_jobs,(SELECT coalesce(extract(epoch FROM now()-min(created_at)),0)::float FROM jobs WHERE status IN ('pending','running')) AS queue_age_seconds,(SELECT coalesce(extract(epoch FROM now()-min(run_at)),0)::float FROM storage_deletions WHERE status IN ('pending','running')) AS deletion_age_seconds");
 Object.assign(result,r.rows[0],{database_available:true,scanner_ready:await scannerStatusCurrent()});
}catch{/* Generic unavailable state, never serialize provider exceptions. */}
finally{await db.end();console.log(JSON.stringify(result));}
