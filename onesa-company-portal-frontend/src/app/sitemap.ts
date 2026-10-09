import type {MetadataRoute} from 'next';
import {serverApi} from '@/lib/api/server';
export const dynamic='force-dynamic';
export default async function sitemap():Promise<MetadataRoute.Sitemap>{if(process.env.PUBLIC_RELEASE_ENABLED!=='true')return [];const ready=await serverApi().GET('/api/v1/public/company').catch(()=>null);if(!ready?.data?.release_ready)return [];const origin=process.env.SITE_URL!;const sections=['','/about','/products','/technology','/industries','/research','/partnerships','/careers','/news','/contact'];return (['en','de'] as const).flatMap(locale=>sections.map(section=>({url:`${origin}/${locale}${section}`,alternates:{languages:{en:`${origin}/en${section}`,de:`${origin}/de${section}`}}})));}
