import type {MetadataRoute} from 'next';
import {companyPageUrl,companyLanguages} from './site-origin.mjs';
import {companySections,publicContentPath} from './public-content-url.mjs';

type PublishedContent = {kind:string;locale:string;slug:string;updated_at:string};

/** Only canonical public pages belong here; redirects and administration do not. */
export function companySitemap(origin:string|undefined,releaseReady:boolean,published:PublishedContent[]=[]):MetadataRoute.Sitemap{
  if(!releaseReady||!origin)return [];
  const site=new URL(origin);
  if(site.protocol!=='https:'||site.origin!==origin)return [];
  const sections=['',...companySections.map(section=>`/${section}`),'/products/onesa-drone'];
  // No guessed lastmod: add dates only when verified page revisions are available.
  const pages:MetadataRoute.Sitemap = (['en','de'] as const).flatMap(locale=>sections.map(section=>({
    url:companyPageUrl(origin,locale,section),
    alternates:{languages:companyLanguages(origin,section)},
  })));
  const byUrl = new Map(pages.map(page=>[page.url,page]));
  for(const item of published){
    if(item.kind==='product'&&item.slug==='onesa-ai-drone')continue;
    const path=publicContentPath(item);
    if(!path)continue;
    const url=`${origin}${path}`,page=byUrl.get(url)||{url};
    const date=new Date(item.updated_at);
    if(!Number.isNaN(date.getTime())&&(!page.lastModified||date>new Date(page.lastModified)))page.lastModified=date;
    byUrl.set(url,page);
  }
  return [...byUrl.values()];
}
