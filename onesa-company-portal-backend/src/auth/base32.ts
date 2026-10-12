/** RFC 4648 encoding shared by authenticator enrollment and synthetic fixtures. */
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes:Buffer){let bits='';for(const b of bytes)bits+=b.toString(2).padStart(8,'0');return (bits.match(/.{1,5}/g)||[]).map(b=>alphabet[parseInt(b.padEnd(5,'0'),2)]).join('');}
