import {PublicDocumentImage} from '@/components/public-document-image';
import {companyMetadata} from '@/lib/metadata';
import {notFound} from 'next/navigation';
import {ResponsiveLink as Link} from '@/components/responsive-link';
import type {Metadata} from 'next';
import {publicServerApi} from '@/lib/api/server';
import {ApiError} from '@/lib/api/client';
import {cache,Suspense} from 'react';
import {publicContentAllowed} from '@/lib/publication';
import {PublicReleaseHold} from '@/components/public-release-hold';
import type {Locale} from '@/config/copy';
import {ProductIllustration} from '@/components/product-illustration';
import {ContentProse} from '@/components/content-prose';
import applications from '@/config/onesa-applications.json';
import {ApplicationForm} from '@/components/application-form';
const kinds={products:'product',news:'article',careers:'job',research:'research'} as const;
// Primitive keys share a fresh resolution between head and body, never across requests.
const get=cache(async(locale:Locale,section:string,slug:string)=>{
  if(locale!=='en'&&locale!=='de')notFound();
  const kind=kinds[section as keyof typeof kinds];if(!kind)notFound();
  if(!await publicContentAllowed())return null;
  try {
    const result=await publicServerApi().GET('/api/v1/public/content/{kind}/{locale}/{slug}',{params:{path:{kind,locale,slug}}});
    return result.data||null;
  } catch(error) {
    if(error instanceof ApiError&&error.status===404)notFound();
    return null;
  }
});
export async function generateMetadata({params}:{params:Promise<{locale:Locale;section:string;slug:string}>}):Promise<Metadata>{const p=await params;const item=await get(p.locale,p.section,p.slug);if(!item)return {...companyMetadata({locale:p.locale,path:`/${p.section}/${encodeURIComponent(p.slug)}`,translated:false}),robots:{index:false,follow:false}};return companyMetadata({locale:p.locale,path:`/${p.section}/${encodeURIComponent(p.slug)}`,title:item.metadata.seoTitle||item.title,description:item.metadata.seoDescription||item.summary,translated:false,article:item.kind==='article'});}
export default async function Detail({params}:{params:Promise<{locale:Locale;section:string;slug:string}>}){const p=await params;const item=await get(p.locale,p.section,p.slug);if(!await publicContentAllowed())return <PublicReleaseHold locale={p.locale}/>;if(!item)return <main id="main" className="section"><h1>{p.locale==='de'?'Inhalt vorübergehend nicht verfügbar':'Content is temporarily unavailable'}</h1><p>{p.locale==='de'?'Bitte versuchen Sie es erneut.':'Please try again.'}</p><a className="button" href={`/${p.locale}/${p.section}/${encodeURIComponent(p.slug)}`}>{p.locale==='de'?'Erneut versuchen':'Try again'}</a> <Link href={`/${p.locale}/${p.section}`}>← {p.locale==='de'?'Zurück':'Back'}</Link></main>;return <main id="main" className="section"><p className="eyebrow">{item.kind.toUpperCase()} / {item.metadata.category}</p><h1>{item.title}</h1><p className="lead">{item.summary}</p>{item.kind==='article'&&<p>{item.metadata.author||'Onesa'} · {p.locale==='de'?'Aktualisiert':'Updated'} {new Date(item.updated_at).toLocaleDateString(p.locale)}</p>}{item.metadata.imageId&&<figure className="article-figure"><PublicDocumentImage id={item.metadata.imageId} alt={item.metadata.imageAlt||item.title}/>{(item.metadata.imageCaption||item.metadata.imageCredit)&&<figcaption>{item.metadata.imageCaption} {item.metadata.imageCredit}</figcaption>}</figure>}{item.kind==='product'&&!item.metadata.imageId&&['onesa-ai-platform','onesa-ai-robot'].includes(item.slug)&&<ProductIllustration product={item.slug==='onesa-ai-platform'?'ai':'robot'} locale={p.locale}/> }<ContentProse body={item.body}/>{item.kind==='product'&&<div className="actions">{applications.applications.filter(a=>a.id===(item.slug==='onesa-ai-platform'?'ai':item.slug==='onesa-ai-robot'?'robot':'')).map(a=><a key={a.id} className="button" href={a.href}>{p.locale==='de'?'Produkt öffnen':'Open product'} ↗</a>)}<a href="https://docs.onesa.eu">Onesa Developer Docs ↗</a><Link href={`/${p.locale}/contact`}>{p.locale==='de'?'Kontakt':'Contact'} →</Link></div>}{item.kind==='job'&&<ApplicationForm locale={p.locale} jobId={item.id}/>}{item.kind==='article'&&<Suspense fallback={null}><RelatedArticles locale={p.locale} id={item.id} category={item.metadata.category}/></Suspense>}<Link href={`/${p.locale}/${p.section}`}>← {p.locale==='en'?'Back':'Zurück'}</Link></main>;}

async function RelatedArticles({locale,id,category}:{locale:Locale;id:string;category?:string}) {
  const related=await publicServerApi().GET('/api/v1/public/content',{params:{query:{locale,kind:'article',category,limit:4}}}).catch(()=>null);
  return <div className="cards">{related?.data?.items.filter(item=>item.id!==id).slice(0,3).map(item=><Link key={item.id} href={`/${locale}/news/${item.slug}`} className="content-card">{item.title}</Link>)}</div>;
}
