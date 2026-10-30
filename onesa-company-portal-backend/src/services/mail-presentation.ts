import {company} from '../config/company.js';
import {mailBrand} from './mail-brand.js';

const escape = (value:string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
const font = 'Arial, Helvetica, sans-serif';
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

/** Branded-v1 is persisted on first claim. Retain its exact rendering when adding
 * a future presentation version: the same job/idempotency key needs the same body. */
export function brandedMailV1(subject:string,text:string,origin?:string){
 const profile=profiles[subject]??{title:subject,preview:'A notification from Onesa.'};
 const action=accessAction(subject,text,origin);
 const paragraphs=(value:string)=>value.split(/\n\s*\n/).filter(Boolean).map(part=>`<p class="copy" style="margin:0 0 18px;color:#334155;font-size:16px;line-height:1.7;overflow-wrap:anywhere;word-break:break-word;">${escape(part).replaceAll('\n','<br>')}</p>`).join('');
 const code=subject==='Your Onesa Engineering sign-in code' ? /^Your Onesa Engineering sign-in code is ([0-9]{6})\. (.+)$/.exec(text) : null;
 let content=paragraphs(text);
 if(action){
  content=`<p class="copy" style="margin:0 0 24px;color:#334155;font-size:16px;line-height:1.7;">${subject==='Complete your Onesa registration'?'Confirm your email address to continue your registration.':'Use your secure link to continue to your Onesa account.'}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td bgcolor="#244f8f" style="border-radius:8px;mso-padding-alt:15px 24px;"><a href="${escape(action.url)}" style="background-color:#244f8f;border:1px solid #244f8f;border-radius:8px;color:#ffffff;display:inline-block;font-family:${font};font-size:16px;font-weight:700;line-height:1.3;padding:15px 24px;text-align:center;text-decoration:none;">${escape(action.label)}</a></td></tr></table>
<div class="notice" style="background-color:#f1f5f9;border-left:3px solid #407cce;border-radius:0 8px 8px 0;padding:16px 18px;margin:0 0 24px;">${paragraphs(action.instructions)}</div>
<p class="muted" style="margin:0 0 8px;color:#526176;font-size:13px;line-height:1.6;">If the button does not work, copy this complete link into your browser:</p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.6;overflow-wrap:anywhere;word-break:break-all;"><a class="fallback" href="${escape(action.url)}" style="color:#244f8f;text-decoration:underline;word-break:break-all;">${escape(action.url)}</a></p>`;
 }else if(code){
  content=`<p class="copy" style="margin:0 0 20px;color:#334155;font-size:16px;line-height:1.7;">Enter this code on the Onesa Engineering Docs sign-in page.</p><p class="code" style="margin:0 0 24px;padding:20px 12px;background-color:#f1f5f9;border:1px solid #dbe4ef;border-radius:8px;font-family:Consolas, monospace;font-size:32px;font-weight:700;letter-spacing:6px;text-align:center;color:#102b4c;">${escape(code[1])}</p>${paragraphs(code[2])}`;
 }
 const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escape(profile.title)}</title>
<style>body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table{border-collapse:collapse}img{border:0;outline:none;text-decoration:none}a:focus-visible{outline:3px solid #407cce;outline-offset:4px}@media screen and (max-width:480px){.outer{padding:20px 12px!important}.content{padding:28px 22px!important}.title{font-size:27px!important}.footer{padding:24px 22px!important}}@media(prefers-color-scheme:dark){.email-bg{background-color:#081322!important}.card{background-color:#102035!important;border-color:#29405a!important}.title,.brand{color:#f0f6ff!important}.copy{color:#dce6f2!important}.muted{color:#b4c5d9!important}.notice,.code{background-color:#182e47!important;color:#f0f6ff!important}.footer{border-color:#29405a!important}.fallback,.contact{color:#9fc9ff!important}}</style></head>
<body class="email-bg" style="margin:0;padding:0;background-color:#f0f4f8;font-family:${font};color:#102b4c;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escape(profile.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="outer" align="center" style="padding:40px 16px;">
<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid #dbe4ef;border-radius:16px;"><tr><td style="height:4px;background-color:#407cce;line-height:4px;font-size:0;">&nbsp;</td></tr>
<tr><td class="content" style="padding:36px 40px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px;"><tr><td width="44" style="width:44px;vertical-align:middle;"><img src="cid:${mailBrand.cid}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;"></td><td class="brand" style="padding-left:12px;font-family:${font};font-size:23px;font-weight:700;letter-spacing:3px;color:#102b4c;">ONESA</td></tr></table>
<h1 class="title" style="margin:0 0 18px;font-family:${font};font-size:32px;line-height:1.2;font-weight:700;letter-spacing:-0.7px;color:#102b4c;">${escape(profile.title)}</h1>
${content}</td></tr>
<tr><td class="footer" style="border-top:1px solid #e2e8f0;padding:24px 40px 28px;"><p class="muted" style="margin:0 0 8px;color:#526176;font-size:12px;line-height:1.7;"><strong>${escape(company.legalName)}</strong><br>${escape(company.address)}<br>Geschäftsführer / Managing Director: ${escape(company.managingDirector)}<br>${escape(company.registerCourt)}, ${escape(company.registerNumber)}</p><p class="muted" style="margin:0;color:#526176;font-size:12px;line-height:1.7;"><a class="contact" href="${escape(company.mailHref)}" style="color:#244f8f;text-decoration:underline;">${escape(company.email)}</a> &nbsp;·&nbsp; ${escape(company.telephone)}</p></td></tr></table>
</td></tr></table></body></html>`;
 return {html,brand:mailBrand};
}
