import type {Locale} from '@/config/copy';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './industrial-ai.module.css';
import {EditorialImage} from './editorial-image';

const pillars = {
  en: [
    {title:'Industrial Troubleshooting & Fault Investigation', text:'Help engineers investigate unexpected stops, alarms and recurring faults. Bring together event histories, sensor trends, asset information, manuals and maintenance records to narrow down possible causes and identify checks grounded in the available evidence. Show uncertainty and missing information, then prepare an internal work draft for human review.'},
    {title:'Predictive Maintenance & Asset Health', text:'Analyze vibration, acoustics, temperature and motor torque to identify anomalies and support condition-based maintenance. Useful warning time depends on the equipment, sensor coverage and validated models.'},
    {title:'Computer Vision Quality Control', text:'Apply deep learning and Automated Optical Inspection (AOI) to examine surfaces, assemblies and packaging for defects. Inspection accuracy and production speed need validation for the product, lighting and line.'},
    {title:'Process Optimization & Energy Management', text:'Evaluate parameters such as kiln temperatures, chemical mix ratios and pump pressures to support output, material efficiency and energy management. Operational adjustments require their own integration, review and authorization.'},
    {title:'Digital Twins and Physics-Informed ML', text:'Combine CAD/CAE physics simulations with machine learning to explore asset behavior, wear and remaining-useful-life scenarios. Virtual testing and real-time replicas depend on suitable data, model fidelity and validated integration.'},
  ],
  de: [
    {title:'Industrielle Fehlersuche & Störungsanalyse', text:'Ingenieure bei unerwarteten Stillständen, Alarmen und wiederkehrenden Störungen unterstützen. Ereignisverläufe, Sensortrends, Anlageninformationen, Handbücher und Wartungsaufzeichnungen zusammenführen, um mögliche Ursachen einzugrenzen und durch die vorhandenen Belege gestützte Prüfschritte zu identifizieren. Unsicherheit und fehlende Informationen aufzeigen und einen internen Arbeitsentwurf zur menschlichen Prüfung vorbereiten.'},
    {title:'Vorausschauende Wartung & Anlagenzustand', text:'Vibrationen, Akustik, Temperatur und Motordrehmoment analysieren, um Abweichungen zu erkennen und zustandsorientierte Wartung zu unterstützen. Nutzbare Vorwarnzeiten hängen von Anlage, Sensorabdeckung und validierten Modellen ab.'},
    {title:'Qualitätsprüfung mit Computer Vision', text:'Deep Learning und automatische optische Inspektion (AOI) zur Prüfung von Oberflächen, Baugruppen und Verpackungen einsetzen. Prüfgenauigkeit und Fertigungstakt müssen für Produkt, Beleuchtung und Produktionslinie validiert werden.'},
    {title:'Prozessoptimierung & Energiemanagement', text:'Parameter wie Ofentemperaturen, chemische Mischverhältnisse und Pumpendrücke bewerten, um Ausbringung, Materialeffizienz und Energieeinsatz zu unterstützen. Betriebliche Anpassungen benötigen eine eigene Integration, Prüfung und Freigabe.'},
    {title:'Digitale Zwillinge und physikgestütztes ML', text:'CAD-/CAE-Physiksimulationen mit maschinellem Lernen verbinden, um Anlagenverhalten, Verschleiß und Szenarien zur Restnutzungsdauer zu untersuchen. Virtuelle Tests und Echtzeitmodelle benötigen geeignete Daten, Modellgüte und validierte Integration.'},
  ],
};

/** Public product direction with automotive manufacturing imagery. */
export function IndustrialAI({locale,compact=false}:{locale:Locale;compact?:boolean}) {
  const de=locale==='de';
  return <section id={compact?'industrial-preview':'industrial-ai'} className={styles.section} aria-labelledby={compact?'industrial-preview-title':'industrial-ai-title'}>
    <div className={styles.copy}>
      <p className="eyebrow">INDUSTRIAL AI</p>
      <h2 id={compact?'industrial-preview-title':'industrial-ai-title'}>{de?'Weniger suchen. Zusammenhänge verstehen.':'Less searching. More context.'}</h2>
      <p>{de?'Industrial Investigation demonstriert die Untersuchung wiederholter Stillstände anhand synthetischer Ereignisse und versionierter Quelltexte in einer isolierten, geschützten Demo. Sie berechnet bekannte Stillstandszeiten und bereitet einen internen Entwurf zur Prüfung vor.':'Industrial Investigation demonstrates repeated-stop investigation using synthetic events and versioned reference text in an isolated, protected demo. It calculates known downtime and prepares an internal draft for review.'}</p>
      <p>{de?'Die Demo trennt berechnete Fakten von möglichen Erklärungen, zeigt fehlende Belege und kann auf eine Erklärung verzichten. Menschen prüfen jede Schlussfolgerung. Es gibt keine Live-Fabrikanbindung oder Maschinensteuerung; weiterführende industrielle Anwendungen bleiben Entwicklungsrichtungen.':'The demo separates calculated facts from possible explanations, shows missing evidence and can abstain. People review every conclusion. It has no live factory connection or machine control; broader industrial applications remain development directions.'}</p>
      <Link className={styles.link} href={compact?`/${locale}/products#industrial-ai`:`/${locale}/contact?topic=industrial`}>{compact?(de?'Industrial AI kennenlernen':'Explore Industrial AI'):(de?'Pilotumfang besprechen':'Discuss a pilot scope')} <span aria-hidden="true">→</span></Link>
    </div>
    <figure className={styles.assembly}>
      <EditorialImage subject="automotive" locale={locale}/>
    </figure>
    {!compact && <section className={styles.pillars} aria-labelledby="industrial-pillars-title">
      <header><p className="eyebrow">{de?'ANWENDUNGSFELDER':'APPLICATION AREAS'}</p>
        <h3 id="industrial-pillars-title">{de?'Kernbereiche & Anwendungen':'Core Pillars & Applications'}</h3>
        <p>{de?'Unsere Entwicklung beginnt mit nachvollziehbarer Untersuchung und menschlicher Prüfung. Diese Anwendungsfelder beschreiben die weiterführende Ausrichtung von Industrial AI; angebundene Produktionssysteme sind damit nicht als verfügbar ausgewiesen.':'Our development starts with traceable investigation and human review. These application areas describe the wider Industrial AI direction; connected production systems are not currently offered.'}</p>
      </header>
      <div className={styles.pillarRows}>{pillars[locale].map((pillar,index)=><article key={pillar.title}>
        <span className={styles.number} aria-hidden="true">{String(index+1).padStart(2,'0')}</span>
        <div><h4>{pillar.title}</h4><p>{pillar.text}</p></div>
      </article>)}</div>
    </section>}
  </section>;
}
