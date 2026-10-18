import type {Locale} from '@/config/copy';
import {products} from '@/config/products';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './home-products.module.css';

export function HomePlatform({locale}:{locale:Locale}) {
 const de=locale==='de';
 const features=de?[
  ['Mit Kontext fragen.','Gespräche mit relevantem Wissen verbinden und Quellen nachvollziehen.'],
  ['Abläufe gestalten.','Mit geführten Agenten und Werkzeugen Aufgaben Schritt für Schritt bearbeiten.'],
  ['Möglichkeiten erkunden.','Reisen planen, Ideen vergleichen und Anwendungen auf einer gemeinsamen Plattform entwickeln.'],
 ]:[
  ['Ask with context.','Connect conversations to relevant knowledge and follow the supporting sources.'],
  ['Shape a workflow.','Work through tasks step by step with guided agents and tools.'],
  ['Explore possibilities.','Plan travel, compare ideas and build applications on a shared platform.'],
 ];
 return <section id="products" className={`section ${styles.platform}`} aria-labelledby="home-products-title">
  <div><p className="eyebrow">{de?'DIE PLATTFORM':'THE PLATFORM'}</p><h2 id="home-products-title">{de?'Wissen, das Sie weiterbringt.':'Put your knowledge to work.'}</h2><p className={styles.intro}>{de?'Für Menschen und Teams, die Informationen verstehen und daraus nächste Schritte entwickeln möchten. Modular aufgebaut, aus Europa für den internationalen Einsatz.':'For people and teams turning information into useful next steps. Modular software, developed in Europe for international use.'}</p><Link className={styles.more} href={`/${locale}/products#product-ai`}>{de?'Onesa AI Platform kennenlernen':'Meet Onesa AI Platform'}<span aria-hidden="true">→</span></Link></div>
  <div className={styles.features}>{features.map(([title,text])=><div key={title}><h3>{title}</h3><p>{text}</p></div>)}</div>
 </section>;
}

export function HomeRobot({locale}:{locale:Locale}) {
 const de=locale==='de',robot=products[locale][1];
 return <section className={`section ${styles.robot}`} aria-labelledby="home-robot-title">
  <div className={styles.robotImage}><picture><source media="(max-width:640px)" srcSet="/images/robot-concept-640.webp"/><img src="/images/robot-concept-1280.webp" width="1280" height="853" loading="lazy" decoding="async" alt={robot.imageAlt}/></picture></div>
  <div className={styles.robotCopy}><p className="eyebrow">{de?'ROBOTIK · IN ENTWICKLUNG':'ROBOTICS · UNDER DEVELOPMENT'}</p><h2 id="home-robot-title">Onesa AI Robot</h2><p>{de?'Die Verbindung von Software und intelligenten Maschinen. Heute mit einem geschützten Operator-Arbeitsbereich und Software-Simulation; Hardwareintegration ist der nächste Entwicklungsbereich.':'Connecting software and intelligent machines. Today, a protected operator workspace and software simulation; hardware integration is a separate development direction.'}</p><p className={styles.imageNote}>{de?'Das Bild zeigt eine Gestaltungsvision, keine verfügbare Hardware.':'The artwork shows a design vision, not available hardware.'}</p><Link className={styles.more} href={`/${locale}/products#product-robot`}>{de?'Robotik entdecken':'Explore robotics'}<span aria-hidden="true">→</span></Link></div>
 </section>;
}
