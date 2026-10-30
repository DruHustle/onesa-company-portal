import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import nodemailer from 'nodemailer';
import {brandedMailV1} from '../src/services/mail-presentation.js';
import {mailBrand} from '../src/services/mail-brand.js';
import {createMailer,companyMailSignature} from '../src/services/mail.js';

const origin='https://portal.example.invalid';
const url=origin+'/engineering/sign-in/synthetic-interaction#access-link='+'x'.repeat(43);
const text='Open this Onesa link to sign in:\n'+url+'\nThe link expires in 15 minutes and can be used once. Opening the email alone does not sign you in. If you did not request this, ignore it.';
const message={id:'883bc062-62ad-453f-a79d-5744ef984b55',to:'recipient@example.invalid',subject:'Your Onesa sign-in link',text,presentation:'branded-v1' as const};
const config={MAIL_PROVIDER:'resend' as const,RESEND_API_KEY:'synthetic-test-key',MAIL_FROM:'Onesa <notifications@example.invalid>',SMTP_PORT:587,NODE_ENV:'test',PUBLIC_ORIGIN:origin};

test('branded sign-in mail embeds the exact owner artwork and retains the complete one-use action and instructions',()=>{
 const {html,brand}=brandedMailV1(message.subject,text,origin);
 assert.match(html,/<h1[^>]*>Sign in to Onesa<\/h1>/);
 assert.equal((html.match(new RegExp('href="'+url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"','g'))??[]).length,2);
 assert.match(html,/expires in 15 minutes and can be used once/);
 assert.match(html,/Opening the email alone does not sign you in/);
 assert.match(html,/cid:onesa-company-logo/);
 assert.equal(createHash('sha256').update(Buffer.from(brand.base64,'base64')).digest('hex'),mailBrand.sha256);
 assert.equal(mailBrand.sha256,'8104289c621d141332ac7d8f6176b74fb3b4246cecac1b7c174404cfefb685d0');
 assert.deepEqual(Buffer.from(brand.base64,'base64'),readFileSync(new URL('../../onesa-company-portal-frontend/public/brand/icons/v1/onesa-company-64.png',import.meta.url)));
 assert.equal(Buffer.from(brand.base64,'base64').length,2916);
 assert.doesNotMatch(html,/<(?:script|iframe|form)|onerror=|@import|src="https?:/i);
 assert.match(html,/Arial, Helvetica, sans-serif/);
 assert.match(html,/prefers-color-scheme:dark/);
 assert.match(html,/max-width:480px/);
 assert.match(html,/Managing Director/);
});

test('unknown notification content is escaped and cannot supply a button, remote image or script',()=>{
 const html=brandedMailV1('<img src=x onerror=alert(1)>','<script>unsafe</script>\nhttps://attacker.example.invalid/#secret',origin).html;
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);
 assert.doesNotMatch(html,/<script>|<img src=x|href="https:\/\/attacker/);
});

test('actions fail closed for foreign origins, credentials, malformed routes, query strings and tokens',()=>{
 for(const bad of [
  url.replace(origin,'https://attacker.example.invalid'),
  url.replace('https://','https://name:password@'),
  url.replace('/engineering/sign-in/synthetic-interaction','/unrelated'),
  url.replace('#access-link=','?tracking=yes#access-link='),
  url.replace('x'.repeat(43),'short'),
  'javascript:alert(1)',
 ]){
  const html=brandedMailV1(message.subject,text.replace(url,bad),origin).html;
  assert.doesNotMatch(html,/href="(?:https?:|javascript:)/);
 }
 assert.doesNotMatch(brandedMailV1(message.subject,text).html,/href="https?:/);
 assert.doesNotMatch(brandedMailV1(message.subject,text,'http://portal.example.invalid').html,/href="https?:/);
});

test('engineering code has a readable code panel and a generic secret-free inbox preview',()=>{
 const {html}=brandedMailV1('Your Onesa Engineering sign-in code','Your Onesa Engineering sign-in code is 123456. It expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.',origin);
 assert.match(html,/>123456<\/p>/);
 assert.match(html,/expires in 10 minutes/);
 assert.doesNotMatch(html,/<title>[^<]*123456/);
 assert.doesNotMatch(html,/mso-hide:all;">[^<]*123456/);
});

test('Resend sends multipart content and an inline CID image with a stable legacy idempotency key',async()=>{
 const calls:RequestInit[]=[];
 const send=createMailer(config,async(_url,options)=>{calls.push(options!);return Response.json({id:'5f907c4c-6b34-452b-88c3-03d199dd33a0'});});
 await send!(message);await send!({...message,text:text+'\n\n'+companyMailSignature});
 assert.equal(calls[0].body,calls[1].body);
 assert.equal(new Headers(calls[0].headers).get('Idempotency-Key'),'onesa-portal/'+message.id);
 const body=JSON.parse(String(calls[0].body));
 assert.equal(body.text,text+'\n\n'+companyMailSignature);
 assert.match(body.html,/Sign in to Onesa/);
 assert.deepEqual(body.attachments,[{filename:mailBrand.filename,content:mailBrand.base64,content_type:'image/png',content_id:mailBrand.cid}]);
 assert.equal(body.html.split('Onesa UG (haftungsbeschränkt)').length,2);
});

test('previously attempted plain jobs retain their exact request body; unknown presentation fails before I/O',async()=>{
 let body='';let calls=0;
 const send=createMailer(config,async(_url,options)=>{calls++;body=String(options?.body);return Response.json({id:'5f907c4c-6b34-452b-88c3-03d199dd33a0'});});
 await send!({...message,presentation:'plain-v0'});
 assert.deepEqual(JSON.parse(body),{from:config.MAIL_FROM,to:[message.to],subject:message.subject,text:text+'\n\n'+companyMailSignature});
 await assert.rejects(send!({...message,presentation:'unsupported' as 'branded-v1'}));assert.equal(calls,1);
});

test('SMTP generates actual text, HTML and inline-image MIME without network access',async()=>{
 const stream=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix'});
 let mime='';
 const factory=(()=>({async sendMail(options:Parameters<typeof stream.sendMail>[0]){const result=await stream.sendMail(options);mime=String(result.message);return {accepted:[message.to]};}})) as unknown as typeof nodemailer.createTransport;
 const send=createMailer({...config,MAIL_PROVIDER:'smtp',SMTP_HOST:'smtp.example.invalid'},async()=>{throw Error('NETWORK_FORBIDDEN');},factory);
 await send!(message);
 assert.match(mime,/Content-Type: multipart\/alternative/);
 assert.match(mime,/Content-Type: text\/plain/);
 assert.match(mime,/Content-Type: text\/html/);
 assert.match(mime,/Content-ID: <onesa-company-logo>/);
 assert.match(mime,/Content-Disposition: inline/);
 assert.match(mime,/Content-Type: image\/png/);
});
