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
  return <div className={styles.grid}>{sectors.map((sector,index)=><article className={styles.card} key={sector.image}>
    <EditorialImage subject={sector.image} locale={locale}/>
    <div className={styles.content}>
      <span className={styles.index}>0{index+1}</span>
      <h2>{industries[locale][index]}</h2>
      <p>{locale==='de'?sector.de:sector.en}</p>
      <Link href={`/${locale}/contact`}>{locale==='de'?'Möglichkeiten besprechen':'Discuss the possibilities'}</Link>
    </div>
  </article>)}</div>;
}

export function CompanyEditorialImage({locale,subject}:{locale:Locale;subject:EditorialSubject}) {
  return <figure className={styles.editorial}><EditorialImage subject={subject} locale={locale} wide/></figure>;
}
