import Link from 'next/link';
import {publicContentPath} from '@/lib/public-content-url.mjs';
import {PublicDocumentImage} from './public-document-image';
import type {operations} from '@/lib/api/generated/schema';
type Item=operations['listPublishedContent']['responses'][200]['content']['application/json']['items'][number];
export function ContentCard({item,locale}:{item:Item;locale:string}) {
  const href=publicContentPath(item);if(!href)return null;
  const minutes=Math.max(1,Math.ceil(item.body.trim().split(/\s+/).filter(Boolean).length/225));
  return <article className={`content-card${item.metadata.featured?' featured-story':''}`}>
    {item.metadata.imageId&&<PublicDocumentImage id={item.metadata.imageId} alt={item.metadata.imageAlt||item.title}/>}
    <p className="eyebrow">{item.metadata.category||item.kind}</p>
    <h2><Link href={href}>{item.title}</Link></h2><p>{item.summary}</p>
    {item.kind==='article'&&<p className="article-meta">{item.metadata.author||'Onesa'} · {locale==='de'?'Aktualisiert':'Updated'} <time dateTime={item.updated_at}>{new Date(item.updated_at).toLocaleDateString(locale)}</time> · {minutes} {locale==='de'?'Min. Lesezeit':'min read'}</p>}
    <Link className="text-link" href={href}>{locale==='de'?'Weiterlesen':'Read more'} →</Link>
  </article>;
}
