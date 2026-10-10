import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMailer} from '../src/services/mail.js';
const config={MAIL_PROVIDER:'resend' as const,RESEND_API_KEY:'synthetic-test-key',MAIL_FROM:'Onesa <notifications@mail.onesa.eu>',MAIL_REPLY_TO:'reply@example.invalid',SMTP_PORT:587,NODE_ENV:'test'};
const message={id:'883bc062-62ad-453f-a79d-5744ef984b55',to:'recipient@example.invalid',subject:'Synthetic notification',text:'Synthetic message'};
test('Resend retries reuse the job key and preserve the encrypted-outbox plaintext only in the request',async()=>{
 const calls:RequestInit[]=[];
 const send=createMailer(config,async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');calls.push(options!);return Response.json({id:'5f907c4c-6b34-452b-88c3-03d199dd33a0'});});
 await send!(message);await send!(message);
 assert.equal(new Headers(calls[0].headers).get('Idempotency-Key'),new Headers(calls[1].headers).get('Idempotency-Key'));
 assert.equal(new Headers(calls[0].headers).get('Authorization'),'Bearer synthetic-test-key');
 assert.equal(calls[0].redirect,'error');assert.ok(calls[0].signal);
 assert.deepEqual(JSON.parse(calls[0].body as string),{from:config.MAIL_FROM,to:[message.to],subject:message.subject,text:message.text,reply_to:config.MAIL_REPLY_TO});
});
test('Resend failures and malformed receipts cannot mark a job accepted or disclose provider responses',async()=>{
 for(const response of [new Response('confidential-provider-response',{status:429}),Response.json({error:'confidential-provider-response'}),Response.json({id:123})]){
  const send=createMailer(config,async()=>response);
  await assert.rejects(send!(message),error=>error instanceof Error&&!error.message.includes('confidential'));
 }
});
test('Resend refuses missing configuration and invalid destinations before network I/O',async()=>{
 assert.throws(()=>createMailer({...config,RESEND_API_KEY:undefined}));
 const send=createMailer(config,async()=>{throw new Error('Unexpected network access');});
 await assert.rejects(send!({...message,to:'victim@example.invalid\r\nBcc: someone@example.invalid'}));
 await assert.rejects(send!({...message,subject:'Injected\nheader'}));
 assert.equal(createMailer({...config,MAIL_PROVIDER:'smtp',SMTP_HOST:undefined}),null);
});
