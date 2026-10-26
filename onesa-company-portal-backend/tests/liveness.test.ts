import './local-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL='postgresql://unit:unit@127.0.0.1:1/unit';
process.env.SESSION_KEY='isolated-liveness-test-key-not-for-runtime-123456';
const {db}=await import('../src/services/db.js');
const {buildApp}=await import('../src/app.js');

test('Full liveness path never queries or connects, including caller session cookies',async()=>{
 const app=await buildApp({logging:false});
 let attempts=0;
 const query=db.query,connect=db.connect;
 const unavailable=()=>{attempts++;throw new Error('Database intentionally unavailable');};
 db.query=unavailable as typeof db.query;
 db.connect=unavailable as typeof db.connect;
 try{
  for(let i=0;i<20;i++){
   const result=await app.inject({method:i%2?'HEAD':'GET',url:'/api/v1/health?probe='+i,headers:{cookie:'onesa_session=synthetic-invalid-session'}});
   assert.equal(result.statusCode,200);
   assert.equal(result.headers['cache-control'],'no-store');
  }
  assert.equal(attempts,0);
  const result=await app.inject({url:'/api/v1/ready'});
  assert.equal(result.statusCode,503);
  assert.equal(result.json().error.code,'DATABASE_CONNECTION');
  assert.equal(attempts,1);
 }finally{db.query=query;db.connect=connect;await app.close();await db.end();}
});
