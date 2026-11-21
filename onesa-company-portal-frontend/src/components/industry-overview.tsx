import {ResponsiveLink as Link} from '@/components/responsive-link';
import {industries, type Locale} from '@/config/copy';
import {EditorialImage,type EditorialSubject} from './editorial-image';
import styles from './industry-overview.module.css';

const sectors = [
  {image:'enterprise', en:'Connect teams, information and everyday business workflows.', de:'Teams, Informationen und alltägliche Geschäftsabläufe verbinden.'},
  {image:'industrial', en:'Bring operational information into clearer focus, from sensors to decisions.', de:'Betriebsinformationen verständlich machen – von Sensoren bis zu Entscheidungen.'},
  {image:'manufacturing', en:'Explore software and robotics for more connected production.', de:'Software und Robotik für eine stärker vernetzte Produktion entdecken.'},
  {image:'travel', en:'Help people discover destinations, compare options and plan their next journey.', de:'Reiseziele entdecken, Möglichkeiten vergleichen und die nächste Reise planen.'},
  {image:'commerce', en:'Connect product discovery, customer experiences and commerce operations.', de:'Produktsuche, Kundenerlebnisse und Handelsabläufe miteinander verbinden.'},
  {image:'finance', en:'Support research, scenario comparison and informed business decisions.', de:'Recherche, Szenarienvergleich und fundierte Geschäftsentscheidungen unterstützen.'},
] as const;

export function IndustryOverview({locale}:{locale:Locale}) {
  return <div className={styles.grid}>{sectors.map((sector,index)=><article className={styles.card} key={sector.image} id={`industry-${sector.image}`}>
    <EditorialImage subject={sector.image} locale={locale}/>
    <div className={styles.content}>
      <span className={styles.index}>0{index+1}</span>
      <h2>{industries[locale][index]}</h2>
      <p>{locale==='de'?sector.de:sector.en}</p>
      <p>{locale==='de'?'Anwendungsrichtung — die konkrete Integration ist projektabhängig.':'Application direction — each integration requires its own implementation.'}</p>
      <dl>{(locale==='de'?[
       ['Eingabe',['Interne Dokumente und Teamfragen','Sensordaten und Betriebsmeldungen','Produktionsinformationen und Prüfkriterien','Reisewünsche, Budget und Reisedaten','Produktinformationen und Kundenfragen','Quellen, Annahmen und Unternehmensdaten'][index]],
       ['Ablauf',['Berechtigte Quellen abrufen und Antworten belegen','Meldungen zusammenführen und zur Prüfung aufbereiten','Abweichungen zur menschlichen Prüfung zusammenstellen','Optionen vergleichen und einen Reiseplan entwerfen','Informationen abrufen und Optionen vergleichen','Szenarien vergleichen und Unsicherheiten kennzeichnen'][index]],
       ['Ergebnis',['Nachvollziehbare Antworten für Mitarbeitende','Eine priorisierte Übersicht für das Betriebsteam','Eine nachvollziehbare Prüfgrundlage','Ein editierbarer Vorschlag ohne Buchung','Quellenbasierte Entscheidungshilfe','Eine Recherchegrundlage, keine Anlageempfehlung'][index]]
      ]:[
       ['Input',['Team documents and questions','Sensor readings and operational reports','Production information and inspection criteria','Travel preferences, budget and dates','Product information and customer questions','Sources, assumptions and business information'][index]],
       ['Workflow',['Retrieve permitted sources and ground answers','Combine reports for operator review','Prepare exceptions for human inspection','Compare options and draft an itinerary','Retrieve information and compare options','Compare scenarios and identify uncertainty'][index]],
       ['Outcome',['Traceable answers for the team','A prioritized view for the operations team','An auditable basis for inspection','An editable proposal with no booking','Source-backed decision support','Research material, not investment advice'][index]]
      ]).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <Link href={`/${locale}/contact?topic=${sector.image}`}>{locale==='de'?'Möglichkeiten besprechen':'Discuss the possibilities'}</Link>
    </div>
  </article>)}</div>;
}

export function CompanyEditorialImage({locale,subject}:{locale:Locale;subject:EditorialSubject}) {
  return <figure className={styles.editorial}><EditorialImage subject={subject} locale={locale} wide/></figure>;
}
