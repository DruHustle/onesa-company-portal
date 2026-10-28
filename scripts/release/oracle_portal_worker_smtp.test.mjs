import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startSink} from './oracle_portal_worker_smtp.mjs';

test('Only ephemeral or the isolated release-fixture SMTP port is eligible',async()=>{
 for(const port of [25,465,587,2526,'2525',true,-1]){
  await assert.rejects(startSink({cert:'synthetic',key:'synthetic',recipient:'01234567-89ab-4cde-8123-456789abcdef@example.invalid',jobId:'01234567-89ab-4cde-8123-456789abcdef',port}),/SMTP_FIXTURE_SCOPE/);
 }
});

function reader(socket){
 let text='',lines=[],waiters=[];
 const receive=chunk=>{text+=chunk.toString();while(text.includes('\r\n')){const n=text.indexOf('\r\n'),line=text.slice(0,n);text=text.slice(n+2);if(waiters.length)waiters.shift()(line);else lines.push(line);}};
 socket.on('data',receive);
 return {detach(){socket.removeListener('data',receive);},async reply(){let line;do{line=lines.length?lines.shift():await new Promise(resolve=>waiters.push(resolve));}while(/^\d{3}-/.test(line));return line;}};
}

async function fixture(fn){
 const folder=await mkdtemp(join(tmpdir(),'onesa-smtp-fixture-')),keyPath=join(folder,'key.pem'),certPath=join(folder,'cert.pem');
 const old=process.umask(0o077);
 try{execFileSync(process.platform==='darwin'?'/opt/homebrew/bin/openssl':'/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',keyPath,'-out',certPath],{stdio:'pipe'});}finally{process.umask(old);}
 const cert=await readFile(certPath),key=await readFile(keyPath),jobId='01234567-89ab-4cde-8123-456789abcdef',recipient=jobId+'@example.invalid';
 const sink=await startSink({cert,key,jobId,recipient});
 try{await fn({sink,cert,jobId,recipient});}finally{await sink.close();await rm(folder,{recursive:true});}
}

async function connection(sink,cert){
 const socket=net.createConnection({host:'127.0.0.1',port:sink.port}),plain=reader(socket);
 await once(socket,'connect');assert.match(await plain.reply(),/^220 /);
 socket.write('EHLO fixture\r\n');assert.match(await plain.reply(),/^250 /);
 socket.write('STARTTLS\r\n');assert.match(await plain.reply(),/^220 /);plain.detach();
 const secure=tls.connect({socket,ca:cert,servername:'localhost',rejectUnauthorized:true});
 const replies=reader(secure);await once(secure,'secureConnect');assert.equal(secure.authorized,true);
 const send=async line=>{secure.write(line+'\r\n');return replies.reply();};
 assert.match(await send('EHLO fixture'),/^250 /);
 return {secure,send};
}

test('SMTP fixture requires TLS before envelope acceptance',{timeout:10000},()=>fixture(async({sink})=>{
 const socket=net.createConnection({host:'127.0.0.1',port:sink.port}),replies=reader(socket);
 await once(socket,'connect');await replies.reply();socket.write('MAIL FROM:<fixture@example.invalid>\r\n');
 assert.match(await replies.reply(),/^530 /);assert.equal(sink.accepted.length,0);socket.destroy();
}));

test('only the named synthetic recipient and stable job identity are accepted',{timeout:10000},()=>fixture(async({sink,cert,jobId,recipient})=>{
 const {secure,send}=await connection(sink,cert);
 assert.match(await send('MAIL FROM:<fixture@example.invalid>'),/^250 /);
 assert.match(await send('RCPT TO:<customer@example.com>'),/^550 /);
 assert.match(await send('DATA'),/^550 /);
 assert.match(await send('RCPT TO:<'+recipient+'>'),/^250 /);
 assert.match(await send('DATA'),/^354 /);
 assert.match(await send('Message-ID: <'+jobId+'@onesa-portal.invalid>\r\nSubject: Synthetic fixture\r\n\r\nOwned test\r\n.'),/^250 /);
 assert.deepEqual(sink.accepted.map(x=>[x.job_id,x.tls]),[[jobId,true]]);
 assert.match(sink.accepted[0].body_sha256,/^[a-f0-9]{64}$/);
 assert.match(await send('QUIT'),/^221 /);secure.destroy();
}));

test('modified Message-ID cannot manufacture acceptance',{timeout:10000},()=>fixture(async({sink,cert,recipient})=>{
 const {secure,send}=await connection(sink,cert);
 await send('MAIL FROM:<fixture@example.invalid>');await send('RCPT TO:<'+recipient+'>');await send('DATA');
 assert.match(await send('Message-ID: <foreign@onesa-portal.invalid>\r\n\r\nOwned test\r\n.'),/^550 /);
 assert.equal(sink.accepted.length,0);secure.destroy();
}));
