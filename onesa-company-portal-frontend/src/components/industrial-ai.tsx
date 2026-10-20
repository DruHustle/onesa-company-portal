import type {Locale} from '@/config/copy';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './industrial-ai.module.css';

/** Static synthetic example. No model, industrial endpoint or customer data is used. */
export function IndustrialAI({locale,compact=false}:{locale:Locale;compact?:boolean}) {
  const de=locale==='de';
  return <section id={compact?'industrial-preview':'industrial-ai'} className={styles.section} aria-labelledby={compact?'industrial-preview-title':'industrial-ai-title'}>
    <div className={styles.copy}>
      <p className="eyebrow">{de?'INDUSTRIAL AI · GEPLANT':'INDUSTRIAL AI · PLANNED'}</p>
      <h2 id={compact?'industrial-preview-title':'industrial-ai-title'}>{de?'Weniger suchen. Zusammenhänge verstehen.':'Less searching. More context.'}</h2>
      <p>{de?'Unser nächster Entwicklungsbereich: berechtigte Maschineninformationen und versionierte Anleitungen zusammenführen, wiederholte Stillstände untersuchen und einen prüfbaren internen Arbeitsentwurf vorbereiten.':'Our next development track: connect authorized machine information with versioned manuals, investigate repeated stops and prepare an internal work draft for review.'}</p>
      <p>{de?'Die geplante Unterstützung erklärt Quellen, Datenlücken und Unsicherheit. Menschen prüfen die Schlussfolgerungen und entscheiden über das weitere Vorgehen.':'The proposed assistant would show sources, missing information and uncertainty. People review the conclusions and decide what happens next.'}</p>
      <Link className={styles.link} href={compact?`/${locale}/products#industrial-ai`:`/${locale}/contact?topic=industrial`}>{compact?(de?'Industrial AI kennenlernen':'Explore Industrial AI'):(de?'Pilotumfang besprechen':'Discuss a pilot scope')} <span aria-hidden="true">→</span></Link>
    </div>
    <figure className={styles.example}>
      <div className={styles.exampleHeading}><span>{de?'SYNTHETISCHES BEISPIEL':'SYNTHETIC EXAMPLE'}</span><strong>DEMO-01</strong></div>
      <h3>{de?'Wiederholte Stillstände untersuchen':'Investigate repeated stops'}</h3>
      <p>{de?'Eine Beispielmaschine · 09:00–10:00 UTC':'One example asset · 09:00–10:00 UTC'}</p>
      <dl className={styles.facts}>
        <div><dt>{de?'Erfasste Stillstände':'Recorded stops'}</dt><dd>3</dd></div>
        <div><dt>{de?'Gesamtdauer':'Combined duration'}</dt><dd>{de?'12 Minuten':'12 minutes'}</dd></div>
      </dl>
      <ol className={styles.events} aria-label={de?'Erfundene Ereignisdaten':'Invented event data'}><li><time>09:12</time><span>{de?'Stillstand':'Stop'} · 4 min</span></li><li><time>09:31</time><span>{de?'Stillstand':'Stop'} · 3 min</span></li><li><time>09:48</time><span>{de?'Stillstand':'Stop'} · 5 min</span></li></ol>
      <p className={styles.boundary}>{de?'Ursache unbekannt. Keine Sensordaten oder freigegebene Anleitung vorhanden. Keine Diagnose oder Handlungsempfehlung ableitbar.':'Cause unknown. No sensor readings or approved manual supplied. These facts alone cannot establish a diagnosis or recommended action.'}</p>
      <figcaption>{de?'Statisches Konzept mit erfundenen Daten. Keine KI-Ausgabe, Live-Anbindung oder Maschinensteuerung.':'Static concept using invented data. No AI-generated result, live integration or machine control.'}</figcaption>
    </figure>
  </section>;
}
