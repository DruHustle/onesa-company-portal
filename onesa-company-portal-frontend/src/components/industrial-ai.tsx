import type {Locale} from '@/config/copy';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './industrial-ai.module.css';
import {EditorialImage} from './editorial-image';

/** Public product direction with automotive manufacturing imagery. */
export function IndustrialAI({locale,compact=false}:{locale:Locale;compact?:boolean}) {
  const de=locale==='de';
  return <section id={compact?'industrial-preview':'industrial-ai'} className={styles.section} aria-labelledby={compact?'industrial-preview-title':'industrial-ai-title'}>
    <div className={styles.copy}>
      <p className="eyebrow">INDUSTRIAL AI</p>
      <h2 id={compact?'industrial-preview-title':'industrial-ai-title'}>{de?'Weniger suchen. Zusammenhänge verstehen.':'Less searching. More context.'}</h2>
      <p>{de?'Unser nächster Entwicklungsbereich: berechtigte Maschineninformationen und versionierte Anleitungen zusammenführen, wiederholte Stillstände untersuchen und einen prüfbaren internen Arbeitsentwurf vorbereiten.':'Our next development track: connect authorized machine information with versioned manuals, investigate repeated stops and prepare an internal work draft for review.'}</p>
      <p>{de?'Die geplante Unterstützung erklärt Quellen, Datenlücken und Unsicherheit. Menschen prüfen die Schlussfolgerungen und entscheiden über das weitere Vorgehen.':'The proposed assistant would show sources, missing information and uncertainty. People review the conclusions and decide what happens next.'}</p>
      <Link className={styles.link} href={compact?`/${locale}/products#industrial-ai`:`/${locale}/contact?topic=industrial`}>{compact?(de?'Industrial AI kennenlernen':'Explore Industrial AI'):(de?'Pilotumfang besprechen':'Discuss a pilot scope')} <span aria-hidden="true">→</span></Link>
    </div>
    <figure className={styles.assembly}>
      <EditorialImage subject="automotive" locale={locale}/>
    </figure>
  </section>;
}
