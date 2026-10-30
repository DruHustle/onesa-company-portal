import nodemailer from 'nodemailer';
import {z} from 'zod';
import {company} from '../config/company.js';
import {brandedMailV1} from './mail-presentation.js';

export const companyMailSignature = [company.legalName, company.address,
 `Geschäftsführer / Managing Director: ${company.managingDirector}`,
 `${company.registerCourt}, ${company.registerNumber}`,
 `${company.email} · ${company.telephone}`].join('\n');
const signedText = (text:string) => text.endsWith(companyMailSignature) ? text : `${text}\n\n${companyMailSignature}`;

type Configuration={MAIL_PROVIDER:'smtp'|'resend';RESEND_API_KEY?:string;MAIL_FROM?:string;MAIL_REPLY_TO?:string;SMTP_HOST?:string;SMTP_PORT:number;SMTP_USER?:string;SMTP_PASSWORD?:string;NODE_ENV:string;PUBLIC_ORIGIN?:string};
const messageSchema=z.object({id:z.string().uuid(),to:z.string().email(),subject:z.string().min(1).max(998).refine(value=>!/[\r\n]/.test(value)),text:z.string().max(100000),presentation:z.enum(['plain-v0','branded-v1']).default('plain-v0')});
export type MailMessage=z.input<typeof messageSchema>;
const bodyWithoutSignature=(text:string)=>text.endsWith(companyMailSignature)?text.slice(0,-companyMailSignature.length).trimEnd():text;
/** A successful return means provider acceptance, never confirmed inbox delivery. */
export function createMailer(config:Configuration,request:typeof fetch=fetch,transportFactory:typeof nodemailer.createTransport=nodemailer.createTransport){
 if(config.MAIL_PROVIDER==='resend'){
  if(!config.RESEND_API_KEY||!config.MAIL_FROM)throw new Error('Resend is not configured');
  return async(input:MailMessage)=>{
   const mail=messageSchema.parse(input);
   const branded=mail.presentation==='branded-v1'?brandedMailV1(mail.subject,bodyWithoutSignature(mail.text),config.PUBLIC_ORIGIN):null;
   // Job UUID is stable across worker retries. Resend retains this key for 24 hours.
   const response=await request('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`onesa-portal/${mail.id}`},body:JSON.stringify({from:config.MAIL_FROM,to:[mail.to],subject:mail.subject,text:signedText(mail.text),...(branded?{html:branded.html,attachments:[{filename:branded.brand.filename,content:branded.brand.base64,content_type:'image/png',content_id:branded.brand.cid}]}:{}),...(config.MAIL_REPLY_TO?{reply_to:config.MAIL_REPLY_TO}:{})}),redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('Email provider did not accept the message');
   const result:unknown=await response.json();
   if(!z.object({id:z.string().uuid()}).safeParse(result).success)throw new Error('Email provider returned an invalid receipt');
  };
 }
 if(!config.SMTP_HOST||!config.MAIL_FROM)return null;
 const transport=transportFactory({host:config.SMTP_HOST,port:config.SMTP_PORT,secure:config.SMTP_PORT===465,requireTLS:config.NODE_ENV==='production',auth:config.SMTP_USER?{user:config.SMTP_USER,pass:config.SMTP_PASSWORD}:undefined,connectionTimeout:10000,socketTimeout:15000});
 return async(input:MailMessage)=>{const mail=messageSchema.parse(input);const branded=mail.presentation==='branded-v1'?brandedMailV1(mail.subject,bodyWithoutSignature(mail.text),config.PUBLIC_ORIGIN):null;const result=await transport.sendMail({from:config.MAIL_FROM,to:mail.to,subject:mail.subject,text:signedText(mail.text),...(branded?{html:branded.html,attachments:[{filename:branded.brand.filename,content:Buffer.from(branded.brand.base64,'base64'),contentType:'image/png',cid:branded.brand.cid,contentDisposition:'inline' as const}]}:{}),replyTo:config.MAIL_REPLY_TO,messageId:`<${mail.id}@onesa-portal.invalid>`});if(!result.accepted?.length)throw new Error('Email provider did not accept the message');};
}
