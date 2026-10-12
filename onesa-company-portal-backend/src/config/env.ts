import { z } from 'zod';
const schema = z.object({ MAX_FILE_STORAGE_BYTES:z.coerce.number().int().min(10485760).default(1073741824), MAX_OWNER_FILE_STORAGE_BYTES:z.coerce.number().int().min(10485760).default(134217728), METRICS_TOKEN:z.preprocess(v=>v||undefined,z.string().min(32).optional()), NODE_ENV:z.enum(['development','test','production']).default('development'), PORT:z.coerce.number().default(8300), DATABASE_URL:z.string().min(1), PUBLIC_ORIGIN:z.string().url().default('http://localhost:3300'), SESSION_KEY:z.string().min(32), STORAGE_DIR:z.string().default('./storage'), S3_BUCKET:z.string().optional(), S3_ENDPOINT:z.string().url().optional(), S3_REGION:z.string().default('eu-central-1'), SMTP_HOST:z.string().optional(), SMTP_PORT:z.coerce.number().default(587), SMTP_USER:z.string().optional(), SMTP_PASSWORD:z.string().optional(), MAIL_FROM:z.string().optional(), NOTIFY_EMAIL:z.string().email().optional(), CLAMAV_HOST:z.string().optional(), CLAMAV_SOCKET:z.string().max(200).regex(/^\/[A-Za-z0-9_./-]+$/).optional(), CLAMAV_PORT:z.coerce.number().default(3310), PROXY_SHARED_KEY:z.string().min(32).optional(), PUBLISH_ENABLED:z.enum(['true','false']).default('false') });
export const env = schema.parse({
 ...process.env,
 S3_ENDPOINT:process.env.S3_ENDPOINT||process.env.AWS_ENDPOINT_URL_S3||undefined,
 S3_REGION:process.env.S3_REGION||process.env.AWS_REGION||undefined,
});
export const emailConfig = z.object({MAIL_PROVIDER:z.enum(['smtp','resend']).default('smtp'),RESEND_API_KEY:z.string().min(1).optional(),MAIL_REPLY_TO:z.string().email().optional()}).parse(process.env);
export const companyOrigin = process.env.COMPANY_ORIGIN;
if(companyOrigin){const url=new URL(companyOrigin);if(url.origin!==companyOrigin||(env.NODE_ENV==='production'&&url.protocol!=='https:')||companyOrigin===env.PUBLIC_ORIGIN)throw new Error('COMPANY_ORIGIN must be a distinct exact HTTPS origin in production');}
if(emailConfig.MAIL_PROVIDER==='resend'&&(!emailConfig.RESEND_API_KEY||!env.MAIL_FROM))throw new Error('Resend requires RESEND_API_KEY and MAIL_FROM');
if (env.NODE_ENV==='production' && (!env.PUBLIC_ORIGIN.startsWith('https://') || env.SESSION_KEY.length<48)) throw new Error('Production requires HTTPS and a 48-character encryption key');

if(env.NODE_ENV==='production'&&!env.PROXY_SHARED_KEY)throw new Error('Production requires PROXY_SHARED_KEY for authenticated request forwarding');

if(process.env.RENDER==='true'&&env.NODE_ENV==='production'&&!env.S3_BUCKET)throw new Error('Render production requires shared durable S3 storage for API and worker');

const browserOrigin=new URL(env.PUBLIC_ORIGIN);
if(browserOrigin.origin!==env.PUBLIC_ORIGIN)throw new Error('PUBLIC_ORIGIN must be an exact origin without a path or credentials');
