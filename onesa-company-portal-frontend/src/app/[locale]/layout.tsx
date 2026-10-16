import {SiteFooter} from '@/components/site-footer';
import {notFound} from 'next/navigation';
import {Navigation} from '@/components/navigation';
import {copy,type Locale} from '@/config/copy';
import {publicationReady} from '@/lib/publication';
export const dynamic='force-dynamic';
export async function generateMetadata(){const approved=await publicationReady();return {robots:{index:approved,follow:approved}};}
export default async function Layout({children,params}:{children:React.ReactNode;params:Promise<{locale:string}>}){const {locale:l}=await params;if(l!=='en'&&l!=='de')notFound();const locale=l as Locale;const ready=await publicationReady();const published=process.env.PUBLIC_RELEASE_ENABLED==='true'&&ready;return <html data-onesa-product="company" lang={locale}><head><meta name="color-scheme" content="light dark"/></head><body><a className="skip-link" href="#main">{locale==='en'?'Skip to content':'Zum Inhalt'}</a>{!published&&<div className="preview-banner" role="region" aria-label={locale==='en'?'Environment':'Umgebung'}>{copy[locale].preview}</div>}<Navigation locale={locale}/>{children}<SiteFooter locale={locale}/></body></html>;}
