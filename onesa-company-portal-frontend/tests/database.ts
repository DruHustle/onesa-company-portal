import '../../onesa-company-portal-backend/tests/local-environment';
import {test as base} from '@playwright/test';
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Browser fixtures require an isolated TEST_DATABASE_URL ending _test');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
export const {db}=await import('../../onesa-company-portal-backend/src/services/db');
// Test files in one Playwright worker share the cached backend module/pool.
// Close it once at worker teardown, after every file using it has finished.
export const test=base.extend<{}, {databaseLifecycle:void}>({databaseLifecycle:[async({},use)=>{try{await use();}finally{await db.end();}},{scope:'worker',auto:true}]});
