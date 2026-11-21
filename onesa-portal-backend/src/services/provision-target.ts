import {portalDatabaseURL} from './render-role-repair.js';

/** Validate an explicitly reviewed operator target before opening a connection. */
export function provisionTarget(raw:string,expectedHost:string,expectedDatabase:string) {
 try {
  const url=new URL(raw);
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==expectedHost||decodeURIComponent(url.pathname.slice(1))!==expectedDatabase||url.hash||url.port&&!['5432'].includes(url.port))throw new Error();
  if(expectedDatabase==='neondb')return portalDatabaseURL(raw,true);
  if(!expectedDatabase.startsWith('onesa_portal'))throw new Error();
  const local=['localhost','127.0.0.1'].includes(url.hostname);
  if(!local&&!['require','verify-full'].includes(url.searchParams.get('sslmode')||''))throw new Error();
  for(const key of ['sslmode','channel_binding'])if(url.searchParams.getAll(key).length>1)throw new Error();
  return url;
 }catch {throw new Error('Database identity or TLS does not match the reviewed Portal target');}
}
