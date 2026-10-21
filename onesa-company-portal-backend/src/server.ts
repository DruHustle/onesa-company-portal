import {tlsTrustPolicy} from './security/tls-trust.js';
import { buildApp } from './app.js';
import { db } from './services/db.js';
import { env } from './config/env.js';
console.info(JSON.stringify({event:'tls_trust_policy_active',...tlsTrustPolicy}));
const app=await buildApp();await app.listen({host:'0.0.0.0',port:env.PORT});let closing=false;async function stop(){if(closing)return;closing=true;await app.close();await db.end();}process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
