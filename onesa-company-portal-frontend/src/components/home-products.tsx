import type {Locale} from '@/config/copy';
import {products} from '@/config/products';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './home-products.module.css';

export function HomePlatform({locale}:{locale:Locale}) {
 const de=locale==='de';
 return <section id="products" className={`section ${styles.platform}`} aria-labelledby="home-products-title">
  <div><p className="eyebrow">{de?'UNSER PRODUKT':'OUR PRODUCT'}</p><h2 id="home-products-title">Onesa AI Platform</h2><p className={styles.intro}>{de?'Unsere KI-Engine für Anwendungen, vernetztes Wissen und geführte Abläufe. Lernen Sie die Möglichkeiten, den aktuellen Entwicklungsstand und die Produktdokumentation kennen.':'Our AI engine for applications, connected knowledge and guided workflows. Explore its capabilities, current development and product documentation.'}</p><Link className={styles.more} href={`/${locale}/products#product-ai`}>{de?'Plattform entdecken':'Explore the platform'}<span aria-hidden="true">→</span></Link></div>
  <figure className={`${styles.platformDetail} ${styles.previewImage}`}><picture><source media="(max-width:640px)" srcSet="/images/ai-platform-concept-640.webp"/><img src="/images/ai-platform-concept-1280.webp" width="1280" height="853" loading="lazy" decoding="async" alt={products[locale][0].imageAlt}/></picture></figure>
 </section>;
}

export function HomeRobot({locale}:{locale:Locale}) {
 const de=locale==='de',robot=products[locale][1];
 return <section className={`section ${styles.robot}`} aria-labelledby="home-robot-title">
  <div className={styles.robotImage}><picture><source media="(max-width:640px)" srcSet="/images/robot-concept-640.webp"/><img src="/images/robot-concept-1280.webp" width="1280" height="853" loading="lazy" decoding="async" alt={robot.imageAlt}/></picture></div>
  <div className={styles.robotCopy}><p className="eyebrow">{de?'ROBOTIK · IN ENTWICKLUNG':'ROBOTICS · UNDER DEVELOPMENT'}</p><h2 id="home-robot-title">Onesa AI Robot</h2><p>{de?'Die Verbindung von Software und intelligenten Maschinen. Heute mit einem geschützten Operator-Arbeitsbereich und Software-Simulation; Hardwareintegration ist der nächste Entwicklungsbereich.':'Connecting software and intelligent machines. Today, a protected operator workspace and software simulation; hardware integration is a separate development direction.'}</p><p className={styles.imageNote}>{de?'Das Bild zeigt eine Gestaltungsvision, keine verfügbare Hardware.':'The artwork shows a design vision, not available hardware.'}</p><Link className={styles.more} href={`/${locale}/products#product-robot`}>{de?'Robotik entdecken':'Explore robotics'}<span aria-hidden="true">→</span></Link></div>
 </section>;
}
