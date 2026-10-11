import { db,transaction } from './db.js';
import { applyMigrationPlan } from './migration-plan.js';
export async function migrate(){await transaction(applyMigrationPlan);}
if((process.argv[1]?.endsWith('migrate.ts')||process.argv[1]?.endsWith('migrate.js'))){await migrate();await db.end();}
