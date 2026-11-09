import {z} from 'zod';

const address=z.string().email().max(254);

/** One configured sender only; preserve its bytes across idempotent retries. */
export const mailFromSchema=z.string().min(1).max(320).refine(value=>{
 if([...value].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return false;
 if(address.safeParse(value).success)return true;
 // Accept an ordinary display name, or a quoted name containing a comma.
 // Reject address lists, header syntax, extra brackets and trailing comments.
 const named=/^(?:[^<>"\\,;:]+|"[^"\\]+") *<([^<>]+)>$/.exec(value);
 return !!named&&address.safeParse(named[1]).success;
},{message:'MAIL_FROM must contain one email address, optionally preceded by a display name, without control characters'});

export const mailReplyToSchema=address;
