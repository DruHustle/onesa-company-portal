import {ResponsiveLink as Link} from '@/components/responsive-link';
import {industries, type Locale} from '@/config/copy';
import styles from './industry-overview.module.css';

const sectors = [
  {image:'enterprise', en:'Connect teams, information and everyday business workflows.', de:'Teams, Informationen und alltägliche Geschäftsabläufe verbinden.', altEn:'Illustrative contemporary workspace with glass meeting rooms and computer workstations.', altDe:'Illustrativer moderner Arbeitsbereich mit gläsernen Besprechungsräumen und Computerarbeitsplätzen.'},
  {image:'industrial', en:'Bring operational information into clearer focus, from sensors to decisions.', de:'Betriebsinformationen verständlich machen – von Sensoren bis zu Entscheidungen.', altEn:'Illustrative industrial sensor and orderly metal pipework.', altDe:'Illustrativer Industriesensor an einer geordneten Anlage aus Metallrohren.'},
  {image:'manufacturing', en:'Explore software and robotics for more connected production.', de:'Software und Robotik für eine stärker vernetzte Produktion entdecken.', altEn:'Illustrative robotic arm beside a precision metal component in a manufacturing cell.', altDe:'Illustrativer Roboterarm neben einem Präzisionsbauteil in einer Fertigungszelle.'},
  {image:'travel', en:'Help people discover destinations, compare options and plan their next journey.', de:'Reiseziele entdecken, Möglichkeiten vergleichen und die nächste Reise planen.', altEn:'Illustrative Portuguese waterfront with blue water and warm stone architecture.', altDe:'Illustrative portugiesische Uferlandschaft mit blauem Wasser und warmer Steinarchitektur.'},
  {image:'commerce', en:'Connect product discovery, customer experiences and commerce operations.', de:'Produktsuche, Kundenerlebnisse und Handelsabläufe miteinander verbinden.', altEn:'Illustrative organized fulfilment workstation with parcels and a handheld scanner.', altDe:'Illustrativer geordneter Versandarbeitsplatz mit Paketen und einem Handscanner.'},
  {image:'finance', en:'Support research, scenario comparison and informed business decisions.', de:'Recherche, Szenarienvergleich und fundierte Geschäftsentscheidungen unterstützen.', altEn:'Illustrative contemporary glass atrium with layered architectural reflections.', altDe:'Illustratives modernes Glasatrium mit architektonischen Spiegelungen.'},
] as const;

function SectorImage({sector, locale, wide=false}:{sector:typeof sectors[number]; locale:Locale; wide?:boolean}) {
  return <picture className={styles.picture}>
    <img src={`/images/industry-${sector.image}-960.webp`}
      srcSet={`/images/industry-${sector.image}-480.webp 480w, /images/industry-${sector.image}-960.webp 960w`}
      sizes={wide?'(max-width: 760px) calc(100vw - 48px), 88vw':'(max-width: 760px) calc(100vw - 48px), 43vw'}
      width="960" height="640" loading="lazy" decoding="async"
      alt={locale==='de'?sector.altDe:sector.altEn}/>
  </picture>;
}

export function IndustryOverview({locale}:{locale:Locale}) {
  return <div className={styles.grid}>{sectors.map((sector,index)=><article className={styles.card} key={sector.image}>
    <SectorImage sector={sector} locale={locale}/>
    <div className={styles.content}>
      <span className={styles.index}>0{index+1}</span>
      <h2>{industries[locale][index]}</h2>
      <p>{locale==='de'?sector.de:sector.en}</p>
      <Link href={`/${locale}/contact`}>{locale==='de'?'Möglichkeiten besprechen':'Discuss the possibilities'}</Link>
    </div>
  </article>)}</div>;
}

export function CompanyEditorialImage({locale,subject}:{locale:Locale;subject:'enterprise'|'industrial'}) {
  const sector=sectors.find(item=>item.image===subject)!;
  return <figure className={styles.editorial}><SectorImage sector={sector} locale={locale} wide/></figure>;
}
