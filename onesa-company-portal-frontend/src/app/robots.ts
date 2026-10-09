import type {MetadataRoute} from 'next';
export const dynamic='force-dynamic';
export default function robots():MetadataRoute.Robots{return {rules:{userAgent:'*',disallow:process.env.PUBLIC_RELEASE_ENABLED==='true'?['/admin','/api/']:['/']},sitemap:process.env.PUBLIC_RELEASE_ENABLED==='true'?`${process.env.SITE_URL}/sitemap.xml`:undefined};}
