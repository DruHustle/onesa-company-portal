import {company} from '../config/company.js';
import {mailBrand} from './mail-brand.js';
import {renderEmailV1, type EmailDesign} from './email-design-v1.js';

const profiles:Record<string,{title:string;preview:string;action?:string}> = {
 'Your Onesa sign-in link': {title:'Sign in to Onesa',preview:'Your secure link to continue to Onesa.',action:'Sign in to Onesa'},
 'Complete your Onesa registration': {title:'Confirm your email',preview:'One more step to complete your Onesa registration.',action:'Confirm email address'},
 'Your Onesa Engineering sign-in code': {title:'Your sign-in code',preview:'Continue to Onesa Engineering Docs.'},
 'Onesa password recovery': {title:'Password recovery',preview:'Instructions for your requested Onesa password recovery.'},
 'Onesa application received': {title:'Application received',preview:'Thank you. Your application has been saved.'},
};

/** Only the existing access-link routes on this worker's configured Portal origin
 * become buttons. User-supplied notification text never creates an action URL. */
function accessAction(subject:string, text:string, origin?:string){
 if(!profiles[subject]?.action || !origin)return null;
 const lines=text.split('\n');
 if(lines[0] !== (subject==='Complete your Onesa registration'
  ? 'Open this Onesa link to verify your email and complete registration:'
  : 'Open this Onesa link to sign in:'))return null;
 try{
  const trusted=new URL(origin),url=new URL(lines[1]);
  if(trusted.protocol!=='https:'||trusted.username||trusted.password||trusted.search||trusted.hash||trusted.pathname!=='/'||url.origin!==trusted.origin||url.username||url.password||url.search)return null;
  if(!/^#access-link=[A-Za-z0-9_-]{43}$/.test(url.hash))return null;
  if(subject==='Complete your Onesa registration' ? url.pathname!=='/access/confirm'
   : !(url.pathname==='/admin'||/^\/engineering\/sign-in\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname)))return null;
  return {url:lines[1],label:profiles[subject].action!,instructions:lines.slice(2).join('\n')};
 }catch{return null;}
}

/** Selected only for unattempted jobs. Legacy plain-v0 and branded-v1 stay unchanged. */
export function brandedMailV2(subject:string,text:string,origin?:string){
 const profile=profiles[subject]??{title:subject,preview:'A notification from Onesa.'};
 const action=accessAction(subject,text,origin);
 const code=subject==='Your Onesa Engineering sign-in code'
  ? /^Your Onesa Engineering sign-in code is ([0-9]{6})\. (.+)$/.exec(text) : null;
 const recovery=subject==='Onesa password recovery'
  ? /^Password reset token: ([A-Za-z0-9_-]{43})\n([\s\S]+)$/.exec(text) : null;
 const presentation:EmailDesign={
  product:'Onesa Portal',category:'Account & notifications',title:profile.title,preview:profile.preview,
  paragraphs:text.split(/\n\s*\n/).filter(Boolean),brandCid:mailBrand.cid,
  footer:[company.legalName,company.address,
   `Geschäftsführer / Managing Director: ${company.managingDirector}`,
   `${company.registerCourt}, ${company.registerNumber}`,`${company.email} · ${company.telephone}`],
 };
 if(action){
  presentation.category='Your Onesa account';
  presentation.paragraphs=[subject==='Complete your Onesa registration'
   ? 'Welcome to Onesa. Confirm your email address to continue your registration.'
   : 'Use your secure link to continue to your Onesa account.'];
  presentation.action={label:action.label,url:action.url,origin:origin!};
  presentation.note=action.instructions;
 }else if(code||recovery){
  const match=(code||recovery)!;
  presentation.category='Account security';presentation.code=match[1];
  presentation.paragraphs=[code?'Enter this code on the Onesa Engineering Docs sign-in page.'
   :'Use this code on the administration password recovery screen.'];
  presentation.note=match[2];
 }else if(subject==='Onesa application received'){
  presentation.category='Your application';
  presentation.status={label:'Application saved',tone:'success'};
 }
 return {html:renderEmailV1(presentation),brand:mailBrand};
}
