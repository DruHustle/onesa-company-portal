import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {company} from '../config/company.js';

const source=`Owner-approved company particulars, 2026-10-12; record SHA256 ${company.sourceSha256}. Owner confirmation, not an independent register extract.`;
export const approvedCompanyFacts={legal_name:company.legalName,address:company.address,director:company.managingDirector,register_court:company.registerCourt,register_number:company.registerNumber,contact_email:company.email,privacy_contact:company.privacyEmail,telephone:company.telephone};

export function approvedLegalNotice(locale:'en'|'de') {
 return [locale==='de'?'Angaben gemäß § 5 DDG':'Information under section 5 DDG',company.legalName,
  locale==='de'?company.address.replace(', Germany',', Deutschland'):company.address,
  `${locale==='de'?'Geschäftsführer':'Managing Director'}: ${company.managingDirector}`,
  `${locale==='de'?'Registergericht':'Register court'}: ${company.registerCourt}`,
  `${locale==='de'?'Handelsregisternummer':'Commercial register number'}: ${company.registerNumber}`,
  `Email: ${company.email}`,`${locale==='de'?'Telefon':'Telephone'}: ${company.telephone}`].join('\n\n');
}

/** Explicit operator seeding only. Caller owns the transaction; no privacy or publication gate is approved. */
export async function synchronizeApprovedCompany(client:Pick<pg.PoolClient,'query'>) {
 await client.query('SELECT pg_advisory_xact_lock(757835)');
 for(const [key,value] of Object.entries(approvedCompanyFacts)) {
  await client.query("INSERT INTO facts(key,value,status,source,verified_at) VALUES($1,$2,'verified',$3,now()) ON CONFLICT(key) DO UPDATE SET value=$2,status='verified',source=$3,verified_by=NULL,verified_at=now() WHERE facts.value IS DISTINCT FROM $2 OR facts.source IS DISTINCT FROM $3 OR facts.status<>'verified'",[key,value,source]);
 }
 for(const locale of ['en','de'] as const) {
  const title=locale==='de'?'Impressum':'Legal Notice',body=approvedLegalNotice(locale);
  const summary=`${company.legalName}, ${company.address}. ${company.registerCourt}, ${company.registerNumber}.`;
  const old=(await client.query("SELECT * FROM content WHERE kind='page' AND slug='impressum' AND locale=$1 FOR UPDATE",[locale])).rows[0];
  if(old?.title===title&&old?.body===body&&old?.summary===summary)continue;
  if(old)await client.query('INSERT INTO revisions(content_id,snapshot) VALUES($1,$2)',[old.id,JSON.stringify(old)]);
  const metadata=JSON.stringify({companyFactsSha256:company.sourceSha256,companyParticularsApproved:true,economicIdentifierAssignmentVerified:false});
  const next=(await client.query("INSERT INTO content(id,kind,slug,locale,title,summary,body,metadata) VALUES($1,'page','impressum',$2,$3,$4,$5,$6) ON CONFLICT(kind,slug,locale) DO UPDATE SET title=$3,summary=$4,body=$5,metadata=content.metadata||$6::jsonb,revision=content.revision+1,updated_at=now() RETURNING *",[old?.id||randomUUID(),locale,title,summary,body,metadata])).rows[0];
  await client.query('INSERT INTO revisions(content_id,snapshot) VALUES($1,$2)',[next.id,JSON.stringify(next)]);
 }
 await client.query("INSERT INTO audit(action,record_id) VALUES('company.owner_particulars_synchronized',$1)",[company.sourceSha256]);
}
