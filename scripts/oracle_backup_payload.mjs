// Pure encrypted envelope for the existing private Oracle backup transport.
import crypto from 'node:crypto';
const MAX=64*1024*1024;
export function sealDatabaseSnapshot(input,publicKey,now=new Date()){
 const required=['action','product','id','snapshot','manifest'];
 if(!input||Object.keys(input).sort().join(',')!==required.sort().join(',')||input.action!=='database-backup'||!['ai','robot'].includes(input.product)||!/^[a-f0-9]{32}$/.test(input.id)||!Array.isArray(input.manifest)||input.manifest.length<1||input.manifest.length>100)throw Error('Invalid database snapshot');
 if(typeof input.snapshot!=='string'||input.snapshot.length>MAX*1.4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.snapshot))throw Error('Invalid snapshot encoding');
 const plain=Buffer.from(input.snapshot,'base64');
 if(!plain.length||plain.length>MAX||(input.product==='ai'&&plain.subarray(0,5).toString()!=='PGDMP'))throw Error('Invalid snapshot format');
 for(const row of input.manifest)if(!row||Object.keys(row).sort().join(',')!=='count,sha256,table'||!/^[a-z][a-z0-9_]{0,62}$/.test(row.table)||!Number.isSafeInteger(row.count)||row.count<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('Invalid snapshot manifest');
 if(new Set(input.manifest.map(r=>r.table)).size!==input.manifest.length)throw Error('Duplicate manifest table');
 if(input.product==='robot'){
  const data=JSON.parse(plain.toString());
  if(data.format!=='onesa-robot-snapshot-v1'||!Array.isArray(data.tables)||data.tables.length!==input.manifest.length||new Set(data.tables.map(t=>t.name)).size!==data.tables.length)throw Error('Invalid Robot snapshot');
  for(const table of data.tables){const row=input.manifest.find(r=>r.table===table.name);if(!row||typeof table.rows_json!=='string'||!Array.isArray(JSON.parse(table.rows_json))||JSON.parse(table.rows_json).length!==row.count||crypto.createHash('sha256').update(table.rows_json).digest('hex')!==row.sha256||typeof table.schema!=='string'||!table.schema.startsWith('CREATE TABLE '))throw Error('Robot manifest mismatch');}
 }
 const publicObject=crypto.createPublicKey(publicKey);if(publicObject.asymmetricKeyType!=='rsa'||publicObject.asymmetricKeyDetails.modulusLength<2048)throw Error('RSA recovery key required');
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const meta={format:'onesa-database-backup-v1',product:input.product,id:input.id,key_id:sha(publicKey),created_at:now.toISOString(),snapshot_sha256:sha(plain),manifest:input.manifest};
 const key=crypto.randomBytes(32),nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(JSON.stringify(meta)));
 const sealed={meta,wrapped_key:crypto.publicEncrypt({key:publicObject,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),nonce:nonce.toString('base64'),body:Buffer.concat([cipher.update(plain),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};key.fill(0);
 return {object:`.onesa-database-backups/v1/${input.product}/${input.id}.json`,body:Buffer.from(JSON.stringify(sealed)),meta};
}
