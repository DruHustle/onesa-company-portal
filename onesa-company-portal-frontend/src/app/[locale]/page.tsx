import {HomeProducts} from '@/components/home-products';
import {company} from '@/config/company';
import {companyMetadata} from '@/lib/metadata';
import {companyOrigin} from '@/lib/site-origin.mjs';
import {notFound} from 'next/navigation';
import {ResponsiveLink as Link} from '@/components/responsive-link';
import {copy,capabilities,industries,type Locale} from '@/config/copy';
import {publicServerApi} from '@/lib/api/server';
import {Suspense} from 'react';
import type {Metadata} from 'next';
import {ContentCard} from '@/components/content-card';
export async function generateMetadata({params}:{params:Promise<{locale:Locale}>}):Promise<Metadata>{const {locale}=await params;if(locale!=='en'&&locale!=='de')notFound();return companyMetadata({locale});}
export default async function Home({params}:{params:Promise<{locale:Locale}>}){const {locale}=await params;if(locale!=='en'&&locale!=='de')notFound();const t=copy[locale];const result=loadContent(locale,'article');const pages=loadContent(locale,'page');const origin=companyOrigin();return <main id="main" className="home-page"><section className="hero"><div className="hero-copy"><p className="eyebrow">{t.eyebrow}</p><h1>{t.hero.split('\n').map((line,i)=><span key={line} className={i===1?'accent':''}>{i>0?' ':''}{line}</span>)}</h1><p className="hero-intro">{t.intro}</p><div className="actions"><Link className="button" href={`/${locale}/technology`}>{t.explore} ↗</Link><Link className="text-link" href={`/${locale}/contact`}>{t.talk} →</Link></div></div><div className="hero-art" aria-hidden="true"><picture><source media="(max-width: 640px)" srcSet="/images/ai-platform-concept-640.webp"/><img src="/images/ai-platform-concept-1280.webp" width="1280" height="853" fetchPriority="high" decoding="async" alt=""/></picture></div><div className="hero-bottom"><span>ONESA UG</span><span>{locale==='en'?'Built with purpose. Designed for possibility.':'Mit Sinn entwickelt. Für Möglichkeiten gestaltet.'}</span><a href="#capabilities" aria-label={locale==='en'?'Explore capabilities':'Kompetenzen entdecken'}>↓</a><p className="mobile-hero-intro">{t.intro}</p></div></section><Suspense fallback={null}><HomepageContent content={pages}/></Suspense><section id="capabilities" className="section"><div className="section-head"><p className="eyebrow">01 / {locale==='en'?'CAPABILITIES':'KOMPETENZEN'}</p><div><h2>{t.capabilities}</h2><p>{t.capText}</p></div></div><div className="capability-grid">{capabilities[locale].slice(0,4).map((name,i)=><Link href={`/${locale}/technology`} className="capability" key={name}><span className="index">0{i+1}</span><h3>{name}</h3><span className="card-arrow">↗</span></Link>)}</div></section><HomeProducts locale={locale}/><section className="section two-columns"><div><p className="eyebrow">03 / {locale==='en'?'PURPOSE':'UNSER ANTRIEB'}</p><h2>{t.mission}</h2><p>{t.missionText}</p></div><div><h2>{t.vision}</h2><p>{t.visionText}</p></div></section><section className="industry-section section"><p className="eyebrow">04 / {locale==='en'?'INDUSTRIES':'BRANCHEN'}</p><h2>{locale==='en'?'Technology across boundaries.':'Technologie über Grenzen hinweg.'}</h2><div className="industry-list">{industries[locale].map(name=><Link href={`/${locale}/industries`} key={name}>{name}<span>↗</span></Link>)}</div></section><section className="section"><div className="section-head"><p className="eyebrow">05 / {locale==='en'?'INSIGHTS':'EINBLICKE'}</p><h2>{t.latest}</h2></div><Suspense fallback={<div className="empty-state" role="status"><p>{locale==='en'?'Loading latest news…':'Aktuelle Meldungen werden geladen…'}</p></div>}><LatestNews content={result} locale={locale}/></Suspense><Link href={`/${locale}/research`}>{t.nav.research} ↗</Link></section><section className="cta section"><p className="eyebrow">{locale==='en'?'BUILD WITH US':'MIT UNS ENTWICKELN'}</p><h2>{locale==='en'?'Let’s make progress\ntogether.':'Gemeinsam Fortschritt\ngestalten.'}</h2><div className="actions"><Link className="button" href={`/${locale}/contact`}>{t.talk} ↗</Link><Link href={`/${locale}/partnerships`}>{t.nav.partnerships} →</Link></div></section>{process.env.PUBLIC_RELEASE_ENABLED==='true'&&<script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify({'@context':'https://schema.org','@type':'Organization',name:company.legalName,url:origin,email:company.email,telephone:company.telephone,address:{'@type':'PostalAddress',streetAddress:'Steinhofweg 47',postalCode:'69123',addressLocality:'Heidelberg',addressCountry:'DE'}}).replace(/</g,'\\u003c')}}/>}</main>;}

function loadContent(locale: Locale, kind: 'article' | 'page') {
  return publicServerApi().GET('/api/v1/public/content', {params: {query: {
    locale, kind, limit: kind === 'article' ? 3 : 1,
    ...(kind === 'page' ? {search: 'homepage'} : {}),
  }}}).catch(() => null);
}

async function HomepageContent({content}: {content: ReturnType<typeof loadContent>}) {
  const pages = await content;
  return <>{pages?.data?.items.map(p => <section className="section" key={p.id}>
    <p className="eyebrow">{p.title}</p>
    <div className="prose">{p.body.split('\n\n').map((text, i) => <p key={i}>{text}</p>)}</div>
  </section>)}</>;
}

async function LatestNews({content, locale}: {content: ReturnType<typeof loadContent>; locale: Locale}) {
  const result = await content;
  const t = copy[locale];
  return result?.data?.items.length
    ? <div className="cards">{result.data.items.map(item => <ContentCard key={item.id} item={item} locale={locale}/>)}</div>
    : <div className="empty-state"><p>{!result
      ? (locale === 'en' ? 'The news service is temporarily unavailable. Please try again.' : 'Der Nachrichtendienst ist vorübergehend nicht verfügbar.')
      : t.noNews}</p><Link href={`/${locale}/products`}>{t.nav.products} →</Link></div>;
}
