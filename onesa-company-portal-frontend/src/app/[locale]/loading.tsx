'use client';
import {useParams} from 'next/navigation';

export default function Loading() {
  const {locale} = useParams<{locale:string}>();
  return <main id="main" className="section page-content" aria-busy="true">
    <p className="eyebrow">Onesa</p>
    <p role="status">{locale === 'de' ? 'Seite wird geladen…' : 'Loading page…'}</p>
  </main>;
}
