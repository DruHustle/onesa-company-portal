import type {MetadataRoute} from 'next';

/** Only canonical public pages belong here; redirects and administration do not. */
export function companySitemap(origin:string|undefined,releaseReady:boolean):MetadataRoute.Sitemap{
  if(!releaseReady||!origin)return [];
  const site=new URL(origin);
  if(site.protocol!=='https:'||site.origin!==origin)return [];
  const sections=['','/about','/products','/technology','/industries','/research','/partnerships','/careers','/news','/contact','/impressum','/privacy','/cookies','/accessibility'];
  // No guessed lastmod: add dates only when verified page revisions are available.
  return (['en','de'] as const).flatMap(locale=>sections.map(section=>({
    url:`${origin}/${locale}${section}`,
    alternates:{languages:{en:`${origin}/en${section}`,de:`${origin}/de${section}`}},
  })));
}
