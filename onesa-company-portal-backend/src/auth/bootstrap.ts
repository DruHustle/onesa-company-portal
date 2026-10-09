import { randomUUID,randomBytes } from 'node:crypto';
import { db,transaction } from '../services/db.js';
import { passwordHash,encrypt,base32 } from './crypto.js';
const email=process.env.BOOTSTRAP_EMAIL; const password=process.env.BOOTSTRAP_PASSWORD;
if(!email||!password||password.length<14)throw new Error('Set BOOTSTRAP_EMAIL and a BOOTSTRAP_PASSWORD of at least 14 characters');
const secret=base32(randomBytes(20));
await transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(757831)');if((await c.query('SELECT id FROM users')).rowCount)throw new Error('Bootstrap is only available for an empty user table');await c.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[randomUUID(),email.toLowerCase(),passwordHash(password),'owner',encrypt(secret)]);});
console.log(`Enroll this TOTP secret in the owner authenticator now: ${secret}\notpauth://totp/Onesa:${encodeURIComponent(email)}?secret=${secret}&issuer=Onesa`);await db.end();
