import nodemailer from 'nodemailer';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {company} from '../config/company.js';
import {mailFromSchema,mailReplyToSchema} from '../config/mail-address.js';
import {brandedMailV1} from './mail-presentation.js';
import {brandedMailV2} from './mail-presentation-v2.js';

export const companyMailSignature = [company.legalName, company.address,
 `Geschäftsführer / Managing Director: ${company.managingDirector}`,
 `${company.registerCourt}, ${company.registerNumber}`,
 `${company.email} · ${company.telephone}`].join('\n');
const signedText = (text:string) => text.endsWith(companyMailSignature) ? text : `${text}\n\n${companyMailSignature}`;

export type Configuration={MAIL_PROVIDER:'smtp'|'resend';RESEND_API_KEY?:string;MAIL_FROM?:string;MAIL_REPLY_TO?:string;SMTP_HOST?:string;SMTP_PORT:number;SMTP_USER?:string;SMTP_PASSWORD?:string;NODE_ENV:string;PUBLIC_ORIGIN?:string};
const messageSchema=z.object({id:z.string().uuid(),to:z.string().email(),subject:z.string().min(1).max(998).refine(value=>!/[\r\n]/.test(value)),text:z.string().max(100000),presentation:z.enum(['plain-v0','branded-v1','branded-v2']).default('plain-v0')});
export type MailMessage=z.input<typeof messageSchema>;
const bodyWithoutSignature=(text:string)=>text.endsWith(companyMailSignature)?text.slice(0,-companyMailSignature.length).trimEnd():text;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const attemptSchema=z.object({
 version:z.literal(1),id:z.string().uuid(),provider:z.enum(['resend','smtp']),
 idempotencyKey:z.string().max(100),
 binding:z.string().regex(/^[a-f0-9]{64}$/),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),
 bytes:z.string().min(1).max(2_000_000),
 envelope:z.object({from:z.email(),to:z.array(z.email()).length(1)}).optional(),
}).strict();
export type MailAttempt=z.infer<typeof attemptSchema>;
export type Mailer=((input:MailMessage)=>Promise<void>)&{
 prepare:(input:MailMessage)=>Promise<MailAttempt>;
 validate:(attempt:unknown,input?:MailMessage)=>MailAttempt;
 deliver:(attempt:MailAttempt)=>Promise<void>;
};
export class MailReconciliationRequired extends Error {
 constructor(){super('Email attempt requires reconciliation before delivery');}
}
/** Preparation performs no network I/O. The worker must commit its encrypted
 * result before deliver(), including before the first possibly ambiguous send. */
export function createMailer(config:Configuration,request:typeof fetch=fetch,transportFactory:typeof nodemailer.createTransport=nodemailer.createTransport):Mailer|null{
 config={...config};
 const from=config.MAIL_FROM?mailFromSchema.parse(config.MAIL_FROM):undefined;
 const replyTo=config.MAIL_REPLY_TO?mailReplyToSchema.parse(config.MAIL_REPLY_TO):undefined;
 if(config.MAIL_PROVIDER==='resend'&&(!config.RESEND_API_KEY||!from))throw new Error('Resend is not configured');
 if(config.MAIL_PROVIDER==='smtp'&&(!config.SMTP_HOST||!from))return null;
 // Keep the credential fingerprint inside the encrypted attempt, never logs or
 // operational API output. Rotation is conservative even within one account.
 const binding=digest(JSON.stringify({provider:config.MAIL_PROVIDER,from,replyTo,
  ...(config.MAIL_PROVIDER==='resend'?{key:config.RESEND_API_KEY}:{host:config.SMTP_HOST,port:config.SMTP_PORT,user:config.SMTP_USER,password:config.SMTP_PASSWORD,requireTLS:config.NODE_ENV==='production'})}));
 const transport=config.MAIL_PROVIDER==='smtp'?transportFactory({host:config.SMTP_HOST,port:config.SMTP_PORT,secure:config.SMTP_PORT===465,requireTLS:config.NODE_ENV==='production',auth:config.SMTP_USER?{user:config.SMTP_USER,pass:config.SMTP_PASSWORD}:undefined,connectionTimeout:10000,socketTimeout:15000}):null;
 const validate=(value:unknown,input?:MailMessage)=>{
  const parsed=attemptSchema.safeParse(value);
  if(!parsed.success)throw new MailReconciliationRequired();
  const attempt=parsed.data;
  if(attempt.provider!==config.MAIL_PROVIDER||attempt.binding!==binding||attempt.idempotencyKey!==`onesa-portal/${attempt.id}`||
   (input&&(attempt.id!==input.id||attempt.inputDigest!==digest(JSON.stringify(messageSchema.parse(input)))))||
   (attempt.provider==='smtp'&&!attempt.envelope)||(attempt.provider==='resend'&&attempt.envelope))throw new MailReconciliationRequired();
  return attempt;
 };
 const prepare=async(input:MailMessage):Promise<MailAttempt>=>{
  const mail=messageSchema.parse(input);
  const branded=mail.presentation==='branded-v2'?brandedMailV2(mail.subject,bodyWithoutSignature(mail.text),config.PUBLIC_ORIGIN):mail.presentation==='branded-v1'?brandedMailV1(mail.subject,bodyWithoutSignature(mail.text),config.PUBLIC_ORIGIN):null;
  const common={version:1 as const,id:mail.id,idempotencyKey:`onesa-portal/${mail.id}`,provider:config.MAIL_PROVIDER,binding,inputDigest:digest(JSON.stringify(mail))};
  if(config.MAIL_PROVIDER==='resend')return validate({...common,bytes:JSON.stringify({from,to:[mail.to],subject:mail.subject,text:signedText(mail.text),...(branded?{html:branded.html,attachments:[{filename:branded.brand.filename,content:branded.brand.base64,content_type:'image/png',content_id:branded.brand.cid}]}:{}),...(replyTo?{reply_to:replyTo}:{})})},mail);
  // Stream transport compiles Date, MIME boundaries and attachments once. It
  // cannot connect to an SMTP server; subsequent sends use only these raw bytes.
  const compiler=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows'});
  const compiled=await compiler.sendMail({from,to:mail.to,subject:mail.subject,text:signedText(mail.text),...(branded?{html:branded.html,attachments:[{filename:branded.brand.filename,content:Buffer.from(branded.brand.base64,'base64'),contentType:'image/png',cid:branded.brand.cid,contentDisposition:'inline' as const}]}:{}),replyTo,messageId:`<${mail.id}@onesa-portal.invalid>`});
  if(!Buffer.isBuffer(compiled.message))throw new Error('Email compiler did not return bounded bytes');
  return validate({...common,bytes:compiled.message.toString('base64'),envelope:compiled.envelope},mail);
 };
 const deliver=async(value:MailAttempt)=>{
  const attempt=validate(value);
  if(attempt.provider==='resend'){
   const response=await request('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':attempt.idempotencyKey},body:attempt.bytes,redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('Email provider did not accept the message');
   const result:unknown=await response.json();
   if(!z.object({id:z.string().uuid()}).safeParse(result).success)throw new Error('Email provider returned an invalid receipt');
  }else{
   const result=await transport!.sendMail({envelope:attempt.envelope,raw:Buffer.from(attempt.bytes,'base64')});
   if(!result.accepted?.length)throw new Error('Email provider did not accept the message');
  }
 };
 return Object.assign(async(input:MailMessage)=>deliver(await prepare(input)),{prepare,validate,deliver});
}
