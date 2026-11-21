import {X509Certificate} from 'node:crypto';
import type pg from 'pg';
import {permittedCertificateRoots} from '../security/tls-trust.js';

/** The optional, runtime-pinned CA applies to PostgreSQL connections only. */
export function databaseConnection(databaseURL:string, encodedCA:string|undefined):pg.PoolConfig {
 if(encodedCA===undefined)return {connectionString:databaseURL};
 const refuse=():never=>{throw new Error('DATABASE_PRIVATE_CA_CONFIGURATION_INVALID');};
 if(!encodedCA||encodedCA.length>12000||!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCA))return refuse();
 const bytes=Buffer.from(encodedCA,'base64');
 if(bytes.toString('base64')!==encodedCA||bytes.length>8192)return refuse();
 const pem=bytes.toString('utf8');
 if(!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(pem))return refuse();
 let certificate:X509Certificate;try{certificate=new X509Certificate(pem);}catch{return refuse();}
 if(!certificate.ca||permittedCertificateRoots([pem]).length!==1)return refuse();
 let url:URL;try{url=new URL(databaseURL);}catch{return refuse();}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password||url.pathname==='/'||url.hash)return refuse();
 if(url.searchParams.getAll('sslmode').length!==1||url.searchParams.get('sslmode')!=='verify-full')return refuse();
 // Reject driver-specific overrides, including sslrootcert, ssl and channel_binding.
 if([...url.searchParams.keys()].some(key=>key!=='sslmode'))return refuse();
 url.searchParams.delete('sslmode');
 return {connectionString:url.href,ssl:{ca:pem,rejectUnauthorized:true,servername:url.hostname},enableChannelBinding:true};
}
