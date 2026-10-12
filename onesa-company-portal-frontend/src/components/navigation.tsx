'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useState} from 'react';
import {copy,type Locale} from '@/config/copy';
export function Navigation({locale}:{locale:Locale}){const [open,setOpen]=useState(false);const path=usePathname();const next=locale==='en'?'de':'en';const nextPath=['/','/en','/de'].includes(path)?(next==='en'?'/':'/de'):path.replace(/^\/(en|de)/,`/${next}`);return <header className="site-header"><Link className="wordmark" href={`/${locale}`} aria-label="Onesa UG home">onesa<span>UG</span></Link><button className="mobile-toggle" aria-expanded={open} aria-controls="main-nav" onClick={()=>setOpen(!open)}>{open?(locale==='de'?'Schließen':'Close'):(locale==='de'?'Menü':'Menu')}</button><nav id="main-nav" className={open?'open':''} aria-label={locale==='de'?'Hauptnavigation':'Main navigation'}>{Object.entries(copy[locale].nav).filter(([key])=>['about','products','technology','careers','contact'].includes(key)).map(([key,label])=><Link key={key} href={`/${locale}/${key}`} onClick={()=>setOpen(false)}>{label}</Link>)}<Link className="language" href={nextPath} hrefLang={next}>{next.toUpperCase()}</Link></nav></header>;}
