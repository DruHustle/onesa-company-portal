import { z } from 'zod';
const schema = z.object({ NODE_ENV:z.enum(['development','test','production']).default('development'), PORT:z.coerce.number().default(8300), DATABASE_URL:z.string().min(1), PUBLIC_ORIGIN:z.string().url().default('http://localhost:3300'), SESSION_KEY:z.string().min(32), STORAGE_DIR:z.string().default('./storage'), S3_BUCKET:z.string().optional(), S3_ENDPOINT:z.string().url().optional(), S3_REGION:z.string().default('eu-central-1'), SMTP_HOST:z.string().optional(), SMTP_PORT:z.coerce.number().default(587), SMTP_USER:z.string().optional(), SMTP_PASSWORD:z.string().optional(), MAIL_FROM:z.string().optional(), NOTIFY_EMAIL:z.string().email().optional(), CLAMAV_HOST:z.string().optional(), CLAMAV_PORT:z.coerce.number().default(3310), PROXY_SHARED_KEY:z.string().min(32).optional(), PUBLISH_ENABLED:z.enum(['true','false']).default('false') });
export const env = schema.parse(process.env);
if (env.NODE_ENV==='production' && (!env.PUBLIC_ORIGIN.startsWith('https://') || env.SESSION_KEY.length<48)) throw new Error('Production requires HTTPS and a 48-character encryption key');

if(env.NODE_ENV==='production'&&!env.PROXY_SHARED_KEY)throw new Error('Production requires PROXY_SHARED_KEY for authenticated request forwarding');

if(process.env.RENDER==='true'&&env.NODE_ENV==='production'&&!env.S3_BUCKET)throw new Error('Render production requires shared durable S3 storage for API and worker');
