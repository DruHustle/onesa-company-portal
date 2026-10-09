import { mkdir,writeFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
// No network or database use during schema export. Only non-secret placeholders are set.
process.env.DATABASE_URL ||= 'postgresql://export:export@127.0.0.1:1/export';
process.env.SESSION_KEY ||= 'schema-export-placeholder-only-not-a-production-key';
process.env.NODE_ENV='test';
const {buildApp}=await import('../app.js');
const app=await buildApp({logging:false});await app.ready();
const spec=app.swagger();await SwaggerParser.validate(JSON.parse(JSON.stringify(spec)));
const paths=spec.paths||{};let operations=0;const ids=new Set();for(const [path,item] of Object.entries(paths)){for(const [method,op] of Object.entries(item||{})){if(!['get','post','put','patch','delete'].includes(method))continue;const value=op as {operationId?:string;responses?:object};if(!value.operationId||ids.has(value.operationId)||!value.responses)throw new Error(`Invalid operation ${method} ${path}`);ids.add(value.operationId);operations++;}}
if(operations<40)throw new Error('Unexpectedly incomplete OpenAPI');
await mkdir('openapi',{recursive:true});await writeFile('openapi/openapi.json',JSON.stringify(spec,null,2)+'\n');await app.close();console.log(`Validated ${operations} API operations`);
