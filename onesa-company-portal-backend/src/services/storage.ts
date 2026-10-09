import { mkdir,writeFile,readFile,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
const s3=new S3Client({region:env.S3_REGION,endpoint:env.S3_ENDPOINT,forcePathStyle:!!env.S3_ENDPOINT});
function local(key:string){if(!/^[a-f0-9-]{36}$/.test(key))throw new Error('Invalid storage key');return resolve(env.STORAGE_DIR,key);}
export async function store(key:string,bytes:Buffer){if(env.S3_BUCKET)await s3.send(new PutObjectCommand({Bucket:env.S3_BUCKET,Key:key,Body:bytes,ServerSideEncryption:'AES256'}));else{await mkdir(env.STORAGE_DIR,{recursive:true,mode:0o700});await writeFile(local(key),bytes,{mode:0o600,flag:'wx'});}}
export async function retrieve(key:string){if(env.S3_BUCKET){const response=await s3.send(new GetObjectCommand({Bucket:env.S3_BUCKET,Key:key}));return Buffer.from(await response.Body!.transformToByteArray());}return readFile(local(key));}
export async function remove(key:string){if(env.S3_BUCKET)await s3.send(new DeleteObjectCommand({Bucket:env.S3_BUCKET,Key:key}));else await unlink(local(key));}
export function pdfSafe(bytes:Buffer){return bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-1024).includes(Buffer.from('%%EOF'));}
export async function scan(bytes:Buffer):Promise<'clean'|'quarantine'|'rejected'>{if(!env.CLAMAV_HOST)return 'quarantine';return new Promise((resolve,reject)=>{const socket=createConnection({host:env.CLAMAV_HOST!,port:env.CLAMAV_PORT});let response='';socket.setTimeout(15000,()=>socket.destroy(new Error('Scan timed out')));socket.on('error',reject);socket.on('data',b=>response+=b.toString());socket.on('end',()=>resolve(response.includes('stream: OK')?'clean':response.includes('FOUND')?'rejected':'quarantine'));socket.on('connect',()=>{socket.write('zINSTREAM\0');for(let n=0;n<bytes.length;n+=65536){const part=bytes.subarray(n,n+65536);const length=Buffer.alloc(4);length.writeUInt32BE(part.length);socket.write(length);socket.write(part);}socket.write(Buffer.alloc(4));});});}

export function detectMime(bytes:Buffer,filename:string){if(/\.pdf$/i.test(filename)&&pdfSafe(bytes))return 'application/pdf';if(/\.png$/i.test(filename)&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(-12).includes(Buffer.from('IEND')))return 'image/png';if(/\.jpe?g$/i.test(filename)&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217)return 'image/jpeg';if(/\.webp$/i.test(filename)&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';return null;}
