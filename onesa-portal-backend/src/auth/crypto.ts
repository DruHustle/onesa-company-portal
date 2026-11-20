import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';
export const token=()=>randomBytes(32).toString('hex');
export const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function passwordHash(password:string){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64,{N:32768,maxmem:64*1024*1024}).toString('hex')}`;}
export function passwordValid(password:string,stored:string){const [salt,key]=stored.split(':');const actual=scryptSync(password,salt,64,{N:32768,maxmem:64*1024*1024});const expected=Buffer.from(key,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
const key=Buffer.from(hash(env.SESSION_KEY),'hex');
export function encrypt(value:string){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');}
export function decrypt(value:string){const raw=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8');}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export {base32} from './base32.js';
function decode(secret:string){const bits=secret.split('').map(c=>alphabet.indexOf(c).toString(2).padStart(5,'0')).join('');return Buffer.from((bits.match(/.{8}/g)||[]).map(b=>parseInt(b,2)));}
export function totp(secret:string,step=Math.floor(Date.now()/30000)){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const digest=createHmac('sha1',decode(secret)).update(counter).digest();const offset=digest[19]&15;return ((digest.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0');}
export function validStep(secret:string,code:string,last:number){const now=Math.floor(Date.now()/30000);for(const step of [now-1,now,now+1])if(step>last&&/^\d{6}$/.test(code)&&timingSafeEqual(Buffer.from(totp(secret,step)),Buffer.from(code)))return step;return null;}
