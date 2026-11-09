import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderEmailV1} from '../src/services/email-design-v1.js';
import {brandedMailV1} from '../src/services/mail-presentation.js';
import {brandedMailV2} from '../src/services/mail-presentation-v2.js';
import {createMailer} from '../src/services/mail.js';

const origin='https://portal.example.invalid';
const link=origin+'/access/confirm#access-link='+'x'.repeat(43);
const subject='Complete your Onesa registration';
const text=`Open this Onesa link to verify your email and complete registration:\n${link}\nThe link expires in 15 minutes and can be used once. Ignore this message if unexpected.`;
const basic={product:'Onesa Portal',category:'Account security',title:'Confirm your email',preview:'Continue your registration.',paragraphs:['Welcome.'],footer:['Onesa']};

test('versioned mail preserves the action, security instructions and plain-text alternative',async()=>{
 const result=brandedMailV2(subject,text,origin);
 assert.match(result.html,/Welcome to Onesa/);assert.match(result.html,/expires in 15 minutes/);
 assert.match(result.html,/max-width:600px/);assert.match(result.html,/prefers-color-scheme:dark/);
 assert.match(result.html,/\[if mso\]/);assert.match(result.html,/cid:onesa-company-logo/);
 assert.doesNotMatch(result.html,/<(?:script|iframe|form)|src="https?:|@import/i);
 const bodies:string[]=[];
 const send=createMailer({MAIL_PROVIDER:'resend',RESEND_API_KEY:'synthetic',MAIL_FROM:'Onesa <notification@example.invalid>',SMTP_PORT:587,NODE_ENV:'test',PUBLIC_ORIGIN:origin},async(_url,options)=>{
  bodies.push(String(options?.body));return Response.json({id:'5f907c4c-6b34-452b-88c3-03d199dd33a0'});
 });
 const input={id:'883bc062-62ad-453f-a79d-5744ef984b55',to:'recipient@example.invalid',subject,text};
 await send!({...input,presentation:'branded-v2'});await send!({...input,presentation:'branded-v2'});
 assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[0]).html,result.html);
 assert.ok(JSON.parse(bodies[0]).text.startsWith(text));
 await send!({...input,presentation:'branded-v1'});
 assert.equal(JSON.parse(bodies[2]).html,brandedMailV1(subject,text,origin).html,'Existing v1 request bytes are not redesigned');
});

test('every text field is escaped, including malicious subject, detail, code and footer values',()=>{
 const bad='<img src=x onerror="alert(1)">';
 const html=renderEmailV1({...basic,title:bad,preview:bad,product:bad,category:bad,paragraphs:[bad],footer:[bad],note:bad,code:bad,details:[{label:bad,value:bad}],status:{label:bad,tone:'warning'}});
 assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('buttons cannot turn untrusted origins, credentials or scripts into account actions',()=>{
 for(const url of ['javascript:alert(1)','https://attacker.invalid/reset','https://name:password@portal.example.invalid/reset']){
  assert.throws(()=>renderEmailV1({...basic,action:{label:'Continue',url,origin}}));
 }
 assert.throws(()=>renderEmailV1({...basic,action:{label:'Continue',url:link,origin:origin+'/untrusted/path'}}));
 assert.doesNotMatch(brandedMailV2(subject,text.replace(origin,'https://attacker.invalid'),origin).html,/href="https:\/\/attacker/);
});

test('security codes never appear in the inbox preview and recovery retains MFA instructions',()=>{
 const html=brandedMailV2('Your Onesa Engineering sign-in code','Your Onesa Engineering sign-in code is 123456. It expires in 10 minutes.').html;
 assert.match(html,/>123456<\/p>/);assert.doesNotMatch(html,/<title>[^<]*123456|mso-hide:all;">[^<]*123456/);
 const recovery=brandedMailV2('Onesa password recovery','Password reset token: '+'x'.repeat(43)+'\nIt expires in 30 minutes. MFA remains required.').html;
 assert.match(recovery,/MFA remains required/);assert.match(recovery,/word-break:break-all/);
});
