import {technologyTopics} from '@/config/technology';
import {HomePlatform,HomeRobot} from '@/components/home-products';
import styles from './home.module.css';
import {company} from '@/config/company';
import {companyMetadata} from '@/lib/metadata';
import {companyOrigin} from '@/lib/site-origin.mjs';
import {notFound} from 'next/navigation';
import {ResponsiveLink as Link} from '@/components/responsive-link';
import {copy,industries,type Locale} from '@/config/copy';
import {publicServerApi} from '@/lib/api/server';
import {Suspense} from 'react';
import type {Metadata} from 'next';
import {ContentCard} from '@/components/content-card';
export async function generateMetadata({params}:{params:Promise<{locale:Locale}>}):Promise<Metadata>{const {locale}=await params;if(locale!=='en'&&locale!=='de')notFound();return companyMetadata({locale});}
export default async function Home({params}:{params:Promise<{locale:Locale}>}) {
  const {locale}=await params;
  if(locale!=='en'&&locale!=='de')notFound();
  const t=copy[locale],de=locale==='de';
  const result=loadContent(locale,'article'),pages=loadContent(locale,'page');
  const origin=companyOrigin();
  return <main id="main" className={`home-page ${styles.home}`}>
    <section className={`hero ${styles.hero}`} aria-labelledby="home-title">
      <picture className={styles.heroImage} aria-hidden="true"><img src="/images/onesa-home-hero-1536.webp" srcSet="/images/onesa-home-hero-640.webp 640w, /images/onesa-home-hero-1024.webp 1024w, /images/onesa-home-hero-1536.webp 1536w" sizes="100vw" width="1536" height="1024" fetchPriority="high" alt=""/></picture>
      <div className={styles.opening}>
        <h1 id="home-title">Onesa AI <br/>Platform</h1>
        <p className="hero-intro">{de?'Gespräche, eigenes Wissen und geführte Abläufe. Ein geschützter Arbeitsbereich.':'Conversations, your knowledge and guided workflows. One protected workspace.'}</p>
        <Link className={`button ${styles.primary}`} href={`/${locale}/products#product-ai`}>{de?'Plattform entdecken':'Explore the platform'}<span aria-hidden="true">→</span></Link>
      </div>
    </section>
    <HomePlatform locale={locale}/>
    <section id="capabilities" className="section">
      <div className="section-head"><p className="eyebrow">{de?'DIE TECHNOLOGIE':'THE TECHNOLOGY'}</p><div><h2>{t.capabilities}</h2><p>{t.capText}</p></div></div>
      <div className="capability-grid">{technologyTopics(locale).slice(0,4).map((topic,i)=><Link href={`/${locale}/technology#${topic.id}`} className="capability" key={topic.id}><span className="index">0{i+1}</span><h3>{topic.title}</h3><span className="card-arrow" aria-hidden="true">→</span></Link>)}</div>
    </section>
    <HomeRobot locale={locale}/>
    <section className={`section two-columns ${styles.company}`}>
      <div><p className="eyebrow">{de?'ÜBER ONESA UG':'ABOUT ONESA UG'}</p><h2>{de?'In Europa verwurzelt. International ausgerichtet.':'European roots. An international outlook.'}</h2><p>{t.missionText}</p><Link className={styles.readMore} href={`/${locale}/about`}>{de?'Unser Unternehmen':'Our company'} <span aria-hidden="true">→</span></Link></div>
      <div><h3>{de?'Für unterschiedliche Branchen.':'Built for different industries.'}</h3><div className={`industry-list ${styles.visualIndustries}`}>{industries[locale].map((name,index)=>{const topic=['enterprise','industrial','manufacturing','travel','commerce','finance'][index];return <Link href={`/${locale}/industries#industry-${topic}`} key={name}><img src={`/images/industry-${topic}-480.webp`} width="480" height="320" alt="" loading="lazy" decoding="async"/><span>{name}</span><span aria-hidden="true">→</span></Link>;})}</div></div>
    </section>
    <Suspense fallback={null}><HomepageContent content={pages}/></Suspense>
    <section className="section"><div className="section-head"><p className="eyebrow">{de?'NEUIGKEITEN':'UPDATES'}</p><h2>{t.latest}</h2></div><Suspense fallback={<div className="empty-state" role="status"><p>{de?'Aktuelle Meldungen werden geladen…':'Loading latest news…'}</p></div>}><LatestNews content={result} locale={locale}/></Suspense><Link href={`/${locale}/research`}>{t.nav.research} <span aria-hidden="true">→</span></Link></section>
    <section className={`cta section ${styles.contact}`}><p className="eyebrow">{de?'MIT UNS ENTWICKELN':'BUILD WITH US'}</p><h2>{de?'Was möchten Sie entwickeln?':'What would you like to build?'}</h2><Link className="button" href={`/${locale}/contact`}>{t.talk}<span aria-hidden="true">→</span></Link></section>
    {process.env.PUBLIC_RELEASE_ENABLED==='true'&&<script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify({'@context':'https://schema.org','@type':'Organization',name:company.legalName,url:origin,email:company.email,telephone:company.telephone,address:{'@type':'PostalAddress',streetAddress:'Steinhofweg 47',postalCode:'69123',addressLocality:'Heidelberg',addressCountry:'DE'}}).replace(/</g,'\\u003c')}}/>}
  </main>;
}

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
