import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
process.env.DATABASE_URL='postgresql://export:export@127.0.0.1:1/export';process.env.SESSION_KEY='schema-tests-only-not-production-key-1234567890';process.env.NODE_ENV='test';
test('OpenAPI is generated from all registered routes, with unique IDs and error schemas',async()=>{const {buildApp}=await import('../src/app.js');const app=await buildApp({logging:false});await app.ready();const generated=app.swagger();const saved=JSON.parse(await readFile('openapi/openapi.json','utf8'));assert.deepEqual(JSON.parse(JSON.stringify(generated)),saved);await SwaggerParser.validate(JSON.parse(JSON.stringify(generated)));let count=0;for(const [path,item] of Object.entries(saved.paths)){assert.match(path,/^\/api\/v1\//);for(const op of Object.values(item as Record<string,{operationId:string;responses:Record<string,unknown>;security:unknown[]}>)){assert.ok(op.operationId);assert.ok(op.responses['400']);assert.ok(op.responses['403']);assert.ok(Array.isArray(op.security));count++;}}assert.ok(count>=50);await app.close();});
