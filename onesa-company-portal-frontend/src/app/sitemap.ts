import type {MetadataRoute} from 'next';
import {serverApi} from '@/lib/api/server';
import {companySitemap} from '@/lib/company-sitemap';
export const dynamic='force-dynamic';
export default async function sitemap():Promise<MetadataRoute.Sitemap>{
  if(process.env.PUBLIC_RELEASE_ENABLED!=='true')return [];
  const ready=await serverApi().GET('/api/v1/public/company').catch(()=>null);
  return companySitemap(process.env.SITE_URL,ready?.data?.release_ready===true);
}
