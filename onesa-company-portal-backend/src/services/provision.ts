import { db,transaction } from './db.js';
import { provisionApplicationRole } from './database-role.js';

const password=process.env.PORTAL_APP_DB_PASSWORD;
if(!password)throw new Error('PORTAL_APP_DB_PASSWORD must be supplied privately');
try {
 await transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(757831)');
  await provisionApplicationRole(client,password);
 });
 console.log('Restricted application role provisioned; existing passwords are not changed.');
} finally {await db.end();}
