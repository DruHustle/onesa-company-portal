import {z} from 'zod';
import {reauthentication} from '../api/contracts.js';

export const stableId=z.string().regex(/^(ONESA-PRIV-(RET|PROC|DEC)-001|(RET|PROC|DEC)-[0-9]{2})$/);
export const kind=z.enum(['document','retention','processor','decision']);
export const status=z.enum(['draft','draft_pending_review','pending_review','approved','needs_changes','rejected']);
export const product=z.enum(['portal','ai','robot','shared','corporate']);
const text=(max=4000)=>z.string().max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),'Control characters are not permitted').refine(value=>!/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:github_pat_|ghp_|sk_live_)[a-zA-Z0-9_]{20,}|\bBearer\s+[a-zA-Z0-9._-]{32,}|(?:https?|postgres(?:ql)?|libsql):\/\/[^\s/]+:[^\s/@]+@)/i.test(value),'Do not include credentials in governance content');
export const reference=text(2000).min(1).refine(value=>{
 if(/(?:bearer\s+[a-z0-9._-]{20,}|\b(?:ghp_|github_pat_|sk_live_)[a-z0-9_]+|\b(?:password|api[_-]?key|secret|token)\s*[=:]\s*\S+)/i.test(value))return false;
 if(!/^[a-z][a-z0-9+.-]*:/i.test(value))return !value.includes('..');
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&![...url.searchParams.keys()].some(key=>/token|secret|password|api.?key|bypass|signature|credential|access.?key|authorization|(^|_)sig($|_)|(^|_)code($|_)/i.test(key));}catch{return false;}
},'Use a non-secret HTTPS URL or internal record path');
const nullableText=text().nullable();
const date=z.string().datetime().nullable();
const document=z.object({type:z.literal('document'),documentType:z.enum(['retention_policy','processor_register','decision_record']),locale:z.enum(['en','de']),markdown:text(150000)}).strict();
const retention=z.object({type:z.literal('retention'),dataClass:text(200).min(1),purpose:text().min(1),proposedPeriod:z.number().int().min(1).max(36500).nullable(),periodUnit:text(200).min(1),expiryTrigger:text(500).min(1),deletionMethod:text().min(1),exceptions:text(),notes:text(),automaticDeletionEnabled:z.literal(false)}).strict();
const discoveredProvider=z.object({name:text(200),service:text(1000),accountIdentifier:reference.nullable(),plan:nullableText,evidenceRefs:z.array(reference).max(20)}).strict();
const processor=z.object({type:z.literal('processor'),provider:text(200).min(1),legalEntity:nullableText,serviceScope:text(1000).min(1),purpose:text().min(1),dataCategories:z.array(text(500)).max(30),relationship:nullableText,accountPlan:nullableText,planVerifiedAt:date,planEligibility:z.enum(['unverified','subject_to_terms_review','confirmed_eligible','ineligible']),businessStage:nullableText,accountIdentifier:reference.nullable(),processingGeography:nullableText,remoteAccess:nullableText,dpaReference:reference.nullable(),termsReference:reference.nullable(),dpaApplicability:z.enum(['unverified','not_established','applicable','not_applicable']),dpaAcceptanceEvidence:reference.nullable(),dpaAcceptedAt:date,subprocessorReference:reference.nullable(),transferAssessment:nullableText,transferMechanism:nullableText,vendorLogging:nullableText,vendorRetention:nullableText,technicalSafeguards:text(),assessmentStage:text(100),managementStatement:text(),futurePlan:nullableText,reviewTriggers:z.array(text(500)).max(20),discoveredProviders:z.array(discoveredProvider).max(20)}).strict();
const decision=z.object({type:z.literal('decision'),requiredDecision:text(1000).min(1),proposedPosition:text(10000).min(1),itemReferences:z.array(stableId).max(50),processingEnabled:z.literal(false)}).strict();
export const payload=z.discriminatedUnion('type',[document,retention,processor,decision]);
export const snapshot=z.object({title:text(300).min(1),owner:text(200).min(1),productScopes:z.array(product).min(1).max(5),versionLabel:z.string().min(1).max(32).regex(/^[0-9]+(?:\.[0-9]+){0,2}(?:-[a-zA-Z0-9.-]+)?$/),reviewDueAt:date,evidenceRefs:z.array(reference).max(30),payload}).strict();
export type Snapshot=z.infer<typeof snapshot>;
export const version=snapshot.extend({recordId:stableId,revision:z.number().int(),status,sourceFingerprint:z.string(),sourceFile:z.string().nullable(),createdBy:z.string().nullable(),createdAt:z.string(),effectiveAt:date,approvedBy:z.string().nullable(),approvedEmail:z.string().nullable(),approvedRole:z.literal('owner').nullable(),approvedAt:date,approvalScope:z.string().nullable(),approvalEvidenceRefs:z.array(reference).nullable(),displayStatus:z.enum([...status.options,'superseded','archived'])});
export const versionSummary=version.omit({payload:true});
export const historyQuery=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(20).default(20)});
export const record=z.object({stableId,kind,documentId:stableId.nullable(),classification:z.literal('INTERNAL'),currentRevision:z.number().int(),effectiveRevision:z.number().int().nullable(),archived:z.boolean(),createdAt:z.string(),updatedAt:z.string(),lastReviewedAt:date,version});
export const query=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(100).default(20),search:z.string().max(200).default(''),kind:kind.optional(),status:status.optional(),product:product.optional(),archived:z.enum(['true','false']).default('false')});
export const event=z.object({id:z.coerce.number(),recordId:stableId,revision:z.number().int(),actorId:z.string().nullable(),actorEmail:z.string().nullable(),actorRole:z.string().nullable(),action:z.string(),note:z.string(),scope:z.string(),evidenceRefs:z.array(reference),createdAt:z.string()});
export const overview=z.object({documents:z.number().int(),draftDocuments:z.number().int(),approvedDocuments:z.number().int(),decisionsAwaitingReview:z.number().int(),processorAssessmentsPending:z.number().int(),upcomingReviews:z.number().int(),missingEvidence:z.number().int(),automaticDeletionEnabled:z.literal(false),publicPublicationEnabled:z.literal(false),restrictions:z.array(z.string())});
export const revisionInput=snapshot.extend({expectedRevision:z.number().int().min(1)}).strict();
export const reviewInput=z.object({expectedRevision:z.number().int().min(1),verdict:z.enum(['pending_review','approved','needs_changes','rejected']),note:text().min(10),scope:text(2000).min(10),evidenceRefs:z.array(reference).max(30),effectiveAt:date,reviewDueAt:date,stepUp:reauthentication.optional()}).strict().superRefine((value,ctx)=>{
 if(value.verdict==='approved'&&(!value.effectiveAt||!value.reviewDueAt||!value.evidenceRefs.length))ctx.addIssue({code:'custom',message:'Approval requires an effective date, review date and evidence reference'});
 if(value.effectiveAt&&value.reviewDueAt&&Date.parse(value.reviewDueAt)<=Date.parse(value.effectiveAt))ctx.addIssue({code:'custom',message:'Review date must follow the effective date'});
});
