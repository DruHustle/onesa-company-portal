'use client';
import {ResponsiveLink as Link} from '@/components/responsive-link';
import {usePathname} from 'next/navigation';
import {useRef} from 'react';
import {copy,type Locale} from '@/config/copy';
export function Navigation({locale}:{locale:Locale}) {
  const mobile = useRef<HTMLDetailsElement>(null);
  const path = usePathname();
  const next = locale === 'en' ? 'de' : 'en';
  const nextPath = ['/', '/en', '/de'].includes(path)
    ? (next === 'en' ? '/' : '/de')
    : path.replace(/^\/(en|de)/, `/${next}`);
  const navigationLabel = locale === 'de' ? 'Hauptnavigation' : 'Main navigation';
  function closeMobile() {
    if (mobile.current) mobile.current.open = false;
  }
  function links(close?: () => void) {
    return <>
      {Object.entries(copy[locale].nav)
        .filter(([key]) => ['about','products','technology','careers','contact'].includes(key))
        .map(([key,label]) => <Link key={key} href={`/${locale}/${key}`} onClick={close}>{label}</Link>)}
      <Link className="language" href={nextPath} hrefLang={next} onClick={close}>{next.toUpperCase()}</Link>
    </>;
  }
  return <header className="site-header">
    <Link className="wordmark" href={`/${locale}`} aria-label="Onesa UG home">onesa<span>UG</span></Link>
    <nav id="main-nav" className="desktop-navigation" aria-label={navigationLabel}>{links()}</nav>
    <details className="mobile-navigation" ref={mobile} onKeyDown={event => {
      if (event.key === 'Escape' && mobile.current?.open) {
        event.preventDefault();
        closeMobile();
        mobile.current.querySelector('summary')?.focus();
      }
    }}>
      <summary className="mobile-toggle" role="button" aria-controls="mobile-main-nav">
        <span className="menu-closed-label">{locale === 'de' ? 'Menü' : 'Menu'}</span>
        <span className="menu-open-label">{locale === 'de' ? 'Schließen' : 'Close'}</span>
      </summary>
      <nav id="mobile-main-nav" aria-label={navigationLabel}>{links(closeMobile)}</nav>
    </details>
  </header>;
}
