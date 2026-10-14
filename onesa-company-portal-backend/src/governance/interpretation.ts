/** Read-only policy diagnostics. Calendar periods are never converted into fixed-day TTLs. */
export function retentionInterpretationIssues(payload: {
 type: string; proposedPeriod?: number | null; periodUnit?: string; notes?: string; exceptions?: string;
}): string[] {
 if(payload.type!=='retention')return [];
 const issues:string[]=[],wording=payload.notes??'',unit=payload.periodUnit??'';
 const months=wording.match(/\b(\d+)\s*(?:\*\*)?\s*(?:calendar\s+)?months?\b/i);
 if(months&&unit.startsWith('days'))issues.push(`Source wording proposes ${months[1]} calendar months; the structured proposal is ${payload.proposedPeriod} ${unit}. Calendar months and a fixed day count are not interchangeable. Amend the duration and unit explicitly before approval.`);
 if(/\bannual\b|\byearly\b/i.test(wording)&&/\b365\s+days\b/i.test(payload.exceptions??''))issues.push('Source wording proposes an annual inactivity review; the structured notes use 365 days. Resolve the calendar-year versus fixed-day interpretation in an amendment before approval.');
 return issues;
}
