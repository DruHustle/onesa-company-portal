import type {MetadataRoute} from 'next';
import {serverApi} from '@/lib/api/server';
import {companySitemap} from '@/lib/company-sitemap';
import {companyOrigin} from '@/lib/site-origin.mjs';
export const dynamic='force-dynamic';
export default async function sitemap():Promise<MetadataRoute.Sitemap>{
  if(process.env.PUBLIC_RELEASE_ENABLED!=='true')return [];
  const ready=await serverApi().GET('/api/v1/public/company').catch(()=>null);
  if(ready?.data?.publication_enabled!==true&&ready?.data?.release_ready!==true)return [];
  const published=[];
  for(const locale of ['en','de'] as const){
    for(let page=1;page<=500;page++){
      const result=await serverApi().GET('/api/v1/public/content',{params:{query:{locale,page,limit:100}}});
      if(!result.data)throw new Error('Published sitemap content is unavailable');
      published.push(...result.data.items);
      if(published.length>49000)throw new Error('Published content requires a sitemap index');
      if(page*100>=result.data.total||!result.data.items.length)break;
      if(page===500)throw new Error('Published content requires a sitemap index');
    }
  }
  return companySitemap(companyOrigin(),true,published);
}
