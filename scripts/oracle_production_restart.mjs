// Bounded recovery probe: stops before processing any business records.
import {db} from './dist/src/services/db.js';
import {databaseReady} from './dist/src/services/database-readiness.js';
import {tick} from './dist/src/jobs/worker.js';

let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
const until=Date.now()+120000;
try{
 if(new URL(process.env.DATABASE_URL).hostname!=='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech')throw Error('Target');
 await databaseReady(db,true);
 while(!stopping&&Date.now()<until){
  const counts=(await db.query("SELECT (SELECT count(*)::int FROM users)+(SELECT count(*)::int FROM files)+(SELECT count(*)::int FROM jobs)+(SELECT count(*)::int FROM applications)+(SELECT count(*)::int FROM enquiries)+(SELECT count(*)::int FROM storage_deletions) AS records")).rows[0];
  if(counts.records!==0)throw Error('Business data must remain untouched');
  await tick();
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 console.log(JSON.stringify({bounded_recovery_probe_completed:true,real_documents_accessed:false}));
}catch{console.log(JSON.stringify({bounded_recovery_probe_completed:false,real_documents_accessed:false}));process.exitCode=1;}
finally{await db.end();}
