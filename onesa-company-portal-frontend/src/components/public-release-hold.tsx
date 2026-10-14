import type {Locale} from '@/config/copy';

export function PublicReleaseHold({locale}:{locale:Locale}) {
  return <main id="main" className="section"><h1>{locale==='en'
    ?'Company website awaiting release approval'
    :'Unternehmensseite wartet auf Freigabe'}</h1></main>;
}
