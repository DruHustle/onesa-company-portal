import { randomUUID } from 'node:crypto';
import { db,transaction } from '../services/db.js';
import { passwordHash } from './crypto.js';
import { env } from '../config/env.js';
const email=process.env.BOOTSTRAP_EMAIL; const password=process.env.BOOTSTRAP_PASSWORD;
if(!email||!password||password.length<14)throw new Error('Set BOOTSTRAP_EMAIL and a BOOTSTRAP_PASSWORD of at least 14 characters');
await transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(757831)');if((await c.query('SELECT id FROM users')).rowCount)throw new Error('Bootstrap is only available for an empty user table');await c.query('INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)',[randomUUID(),email.toLowerCase(),passwordHash(password),'owner']);});
// A generated key is not a verified authenticator. The password-authenticated UI
// stores the active factor only after the owner proves a current app code.
console.log(`Owner account created. Set up your authenticator at ${env.PUBLIC_ORIGIN}/access/setup-authenticator before signing in.`);await db.end();
