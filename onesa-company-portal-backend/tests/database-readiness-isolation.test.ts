import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('database readiness imports without application credentials in an isolated migration process', () => {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  delete environment.DATABASE_URL;
  delete environment.SESSION_KEY;
  const child = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "import {databaseReady} from './src/services/database-readiness.ts'; if(typeof databaseReady!=='function')process.exit(2);",
  ], { cwd: process.cwd(), env: environment, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, 'readiness imports must not require application runtime credentials');
});
