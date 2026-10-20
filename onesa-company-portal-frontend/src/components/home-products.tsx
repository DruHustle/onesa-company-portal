import type {Locale} from '@/config/copy';
import {products} from '@/config/products';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './home-products.module.css';

export function HomePlatform({locale}:{locale:Locale}) {
 const de=locale==='de';
 return <section id="products" className={`section ${styles.platform}`} aria-labelledby="home-products-title">
  <div><p className="eyebrow">{de?'KI-SOFTWARE':'AI SOFTWARE'}</p><h2 id="home-products-title">Onesa AI Platform</h2><p className={styles.intro}>{de?'Heute verbinden Chat, Knowledge, Agents und Travel Wissen mit geführten Aufgaben. Industrial AI ist unser geplanter Entwicklungsbereich für nachvollziehbare, von Menschen geprüfte betriebliche Arbeitsabläufe.':'Chat, Knowledge, Agents and Travel connect knowledge with guided tasks. Industrial AI is our planned development track for traceable operational workflows reviewed by people.'}</p><nav className={styles.tracks} aria-label={de?'Bereiche der AI Platform':'AI Platform tracks'}><Link href={`/${locale}/products#platform-applications`}>{de?'Anwendungen':'Applications'} <span aria-hidden="true">→</span></Link><Link href={`/${locale}/products#industrial-ai`}>Industrial AI <span aria-hidden="true">→</span></Link></nav><Link className={styles.more} href={`/${locale}/products#product-ai`}>{de?'Plattform entdecken':'Explore the platform'}<span aria-hidden="true">→</span></Link></div>
  <figure className={`${styles.platformDetail} ${styles.previewImage}`}><picture><source media="(max-width:640px)" srcSet="/images/ai-platform-concept-640.webp"/><img src="/images/ai-platform-concept-1280.webp" width="1280" height="853" loading="lazy" decoding="async" alt={products[locale][0].imageAlt}/></picture></figure>
 </section>;
}

export function HomeRobot({locale}:{locale:Locale}) {
 const de=locale==='de',robot=products[locale][1];
 return <section className={`section ${styles.robot}`} aria-labelledby="home-robot-title">
  <div className={styles.robotImage}><picture><source media="(max-width:640px)" srcSet="/images/robot-concept-640.webp"/><img src="/images/robot-concept-1280.webp" width="1280" height="853" loading="lazy" decoding="async" alt={robot.imageAlt}/></picture></div>
  <div className={styles.robotCopy}><p className="eyebrow">{de?'ROBOTIK · PHYSISCHE KI':'ROBOTICS · PHYSICAL AI'}</p><h2 id="home-robot-title">Onesa AI Robot</h2><p>{de?'Unsere Entwicklungsrichtung für KI in physischen Systemen. Heute: ein geschützter Operator-Arbeitsbereich mit Software-Simulation eines Gelenks. Wahrnehmung, Roboterhardware und physische Steuerung benötigen eine eigene Integration und Qualifikation.':'Our development direction for AI in physical systems. Today: a protected operator workspace with a one-joint software simulator. Perception, robot hardware and physical control require their own integration and qualification.'}</p><p className={styles.imageNote}>{de?'Das Bild zeigt eine Gestaltungsvision, keine verfügbare Hardware.':'The artwork shows a design vision, not available hardware.'}</p><Link className={styles.more} href={`/${locale}/products#product-robot`}>{de?'Robotik entdecken':'Explore robotics'}<span aria-hidden="true">→</span></Link></div>
 </section>;
}
