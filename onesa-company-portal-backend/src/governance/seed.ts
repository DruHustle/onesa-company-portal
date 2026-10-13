/** Pure package validation/mapping. No environment, database, network or approval effects. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {snapshot,reference,type Snapshot} from './schemas.js';

const documentIds=['ONESA-PRIV-RET-001','ONESA-PRIV-PROC-001','ONESA-PRIV-DEC-001'] as const;
const nullApproval={approved_at:z.null(),effective_at:z.null(),approver_user_id:z.null(),approval_evidence_ref:z.null()};
const doc=z.object({id:z.enum(documentIds),slug:z.string(),title:z.string(),classification:z.literal('INTERNAL'),locale:z.enum(['en','de']),version:z.string(),status:z.literal('DRAFT_PENDING_APPROVAL'),...nullApproval,review_due_at:z.null(),source_file:z.string().regex(/^0[123]_[A-Z_]+_DRAFT\.md$/),markdown:z.string().max(150000)}).strict();
const retention=z.object({rule_id:z.string().regex(/^RET-[0-9]{2}$/),product_scope:z.enum(['portal','ai','shared','corporate']),data_class:z.string(),expiry_trigger:z.string(),proposed_period:z.number().int().positive().nullable(),proposed_period_unit:z.string(),notes:z.string(),approval_status:z.literal('PENDING'),effective_at:z.null(),enabled_for_automatic_deletion:z.literal(false)}).strict();
const processor=z.object({processor_id:z.string().regex(/^PROC-[0-9]{2}$/),provider:z.string(),service_scope:z.string(),decision_status:z.string(),contract_or_account_identifier:z.null(),signed_or_accepted_dpa_evidence:z.null(),actual_processing_regions:z.null(),subprocessor_inventory_ref:z.null(),extra_eea_transfer_assessment:z.null(),transfer_mechanism:z.null(),provider_log_retention:z.null(),reviewed_at:z.null(),approved_by:z.null(),reference_terms_url:reference.nullable(),reference_dpa_url:reference.nullable()}).strict();
const decision=z.object({decision_id:z.string().regex(/^DEC-[0-9]{2}$/),status:z.literal('PENDING'),approved_by:z.null(),approved_at:z.null(),evidence_ref:z.null()}).strict();
export const seedSchema=z.object({$schema:z.string(),kind:z.literal('onesa_privacy_governance_seed'),seed_version:z.string(),prepared_on:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),database_target:z.literal('EXISTING_COMPANY_PORTAL_DB_TO_BE_RESOLVED_FROM_RUNTIME'),publication_policy:z.literal('INTERNAL_DRAFT_ONLY'),owner_approval_not_inferred:z.literal(true),import_behavior:z.literal('IDEMPOTENT_INSERT_DRAFT_ONLY_DO_NOT_OVERWRITE_EXISTING_APPROVED_OR_NEWER_RECORDS'),documents:z.array(doc).length(3),retention_rules:z.array(retention).length(16),processors:z.array(processor).length(9),privacy_decisions:z.array(decision).length(12),security_policy:z.object({publicly_publishable:z.literal(false),must_use_server_side_rbac:z.literal(true),restricted_secrets_excluded:z.literal(true),require_owner_review_before_effective:z.literal(true),do_not_execute_deletions_from_seed:z.literal(true),record_change_audit_required:z.literal(true)}).strict()}).strict();
export const contextSchema=z.object({vercel:z.object({currentPlan:z.literal('hobby'),verifiedAt:z.string().datetime(),accountIdentifier:reference,managementStatement:z.string().min(20).max(4000),futurePlan:z.literal('Pro or Enterprise'),dpaReference:z.literal('https://vercel.com/legal/dpa'),termsReference:z.literal('https://vercel.com/legal/terms'),fairUseReference:z.literal('https://vercel.com/docs/limits/fair-use-guidelines'),currentDpaStatus:z.literal('not_established'),eligibilityStatus:z.literal('subject_to_terms_review'),reviewTriggers:z.array(z.string()).min(1).max(20)}).strict(),additionalProviders:z.array(z.object({name:z.string(),service:z.string(),accountIdentifier:reference.nullable(),plan:z.string().nullable(),evidenceRefs:z.array(reference)}).strict()).max(20)}).strict();
export type ImportRecord={id:string;kind:Snapshot['payload']['type'];documentId:string|null;sourceFile:string|null;snapshot:Snapshot};
function table(markdown:string,id:string){
 const line=markdown.split('\n').find(line=>new RegExp('^\\|\\s*'+id+'\\s*\\|').test(line));
 if(!line)throw new Error('Missing structured source table row: '+id);
 return line.split('|').slice(1,-1).map(cell=>cell.trim());
}
export function normalizeSeed(raw:unknown,rawContext?:unknown){
 const seed=seedSchema.parse(raw),context=rawContext===undefined?undefined:contextSchema.parse(rawContext);
 const ids=[...seed.documents.map(x=>x.id),...seed.retention_rules.map(x=>x.rule_id),...seed.processors.map(x=>x.processor_id),...seed.privacy_decisions.map(x=>x.decision_id)];
 if(new Set(ids).size!==40||!documentIds.every(id=>ids.includes(id)))throw new Error('Unique stable package IDs required');
 for(const [prefix,count] of [['RET',16],['PROC',9],['DEC',12]] as const){for(let i=1;i<=count;i++)if(!ids.includes(prefix+'-'+String(i).padStart(2,'0')))throw new Error('Complete stable package ID sequence required');}
 const documents=new Map(seed.documents.map(d=>[d.id,d]));
 const records:ImportRecord[]=[];
 const add=(id:string,documentId:string|null,sourceFile:string|null,input:Snapshot)=>records.push({id,documentId,sourceFile,kind:input.payload.type,snapshot:snapshot.parse(input)});
 const base={owner:'Onesa UG management',versionLabel:'0.1',reviewDueAt:null,evidenceRefs:[]};
 for(const d of seed.documents)add(d.id,null,d.source_file,{...base,title:d.title,versionLabel:d.version,productScopes:['portal','ai','robot','shared','corporate'],payload:{type:'document',documentType:d.id===documentIds[0]?'retention_policy':d.id===documentIds[1]?'processor_register':'decision_record',locale:d.locale,markdown:d.markdown}});
 const retentionDoc=documents.get(documentIds[0])!,processorDoc=documents.get(documentIds[1])!,decisionDoc=documents.get(documentIds[2])!;
 for(const r of seed.retention_rules){
  const row=table(retentionDoc.markdown,r.rule_id);
  add(r.rule_id,retentionDoc.id,retentionDoc.source_file,{...base,title:row[1],productScopes:[r.product_scope],payload:{type:'retention',dataClass:r.data_class,purpose:row[1],proposedPeriod:r.proposed_period,periodUnit:r.proposed_period_unit,expiryTrigger:r.expiry_trigger,deletionMethod:row[3],exceptions:r.notes,notes:row[2],automaticDeletionEnabled:false}});
 }
 const scopes:Snapshot['productScopes'][]=[['portal','ai','robot'],['portal','ai','robot'],['portal','ai'],['portal'],['ai'],['shared'],['portal','shared'],['shared'],['shared','robot']];
 for(const [index,p] of seed.processors.entries()){
  const row=table(processorDoc.markdown,p.processor_id),v=p.processor_id==='PROC-01'?context?.vercel:undefined;
  add(p.processor_id,processorDoc.id,processorDoc.source_file,{...base,title:p.provider,productScopes:scopes[index],evidenceRefs:v?[v.termsReference,v.dpaReference,v.fairUseReference]:[],payload:{type:'processor',provider:p.provider,legalEntity:null,serviceScope:p.service_scope,purpose:row[1],dataCategories:[row[2]],relationship:null,accountPlan:v?.currentPlan??null,planVerifiedAt:v?.verifiedAt??null,planEligibility:v?.eligibilityStatus??'unverified',businessStage:v?'Pre-commercial setup; management states no commercial activity has commenced.':null,accountIdentifier:v?.accountIdentifier??null,processingGeography:null,remoteAccess:null,dpaReference:v?.dpaReference??p.reference_dpa_url,termsReference:v?.termsReference??p.reference_terms_url,dpaApplicability:v?.currentDpaStatus??'unverified',dpaAcceptanceEvidence:null,dpaAcceptedAt:null,subprocessorReference:null,transferAssessment:null,transferMechanism:null,vendorLogging:null,vendorRetention:null,technicalSafeguards:row[3],assessmentStage:p.decision_status,managementStatement:v?.managementStatement??'',futurePlan:v?.futurePlan??null,reviewTriggers:v?.reviewTriggers??[],discoveredProviders:p.processor_id==='PROC-09'?context?.additionalProviders??[]:[]}});
 }
 for(const d of seed.privacy_decisions){const row=table(decisionDoc.markdown,d.decision_id);add(d.decision_id,decisionDoc.id,decisionDoc.source_file,{...base,title:row[1],productScopes:['portal','ai','robot','shared','corporate'],payload:{type:'decision',requiredDecision:row[1],proposedPosition:row[2],itemReferences:[],processingEnabled:false}});}
 return {records,seedFingerprint:createHash('sha256').update(JSON.stringify(seed)).digest('hex'),preparedOn:seed.prepared_on};
}
