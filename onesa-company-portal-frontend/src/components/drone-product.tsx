import {ResponsiveLink as Link} from './responsive-link';
import type {Locale} from '@/config/copy';
import {DroneVisual} from './drone-visual';
import {DroneImage} from './drone-image';
import {DroneFilm} from './drone-film';
import styles from './drone-product.module.css';

export function DronePortfolio({locale}:{locale:Locale}) {
 const de=locale==='de';
 return <section id="product-drone" className={`product-section ${styles.portfolio} ${styles.portfolioCard}`} aria-labelledby="product-drone-title"><div><p className="eyebrow">PHYSICAL AI / {de?'LIEFERDROHNEN':'DELIVERY DRONES'}</p><h2 id="product-drone-title">Onesa Drone</h2><p className={styles.tagline}>Intelligent Delivery Beyond Roads</p><p>{de?'Luftlogistik neu denken. Wir entwickeln eine Plattform, die Lieferplanung, Flottenkoordination und Missionssimulation in einem klaren Ablauf verbindet.':'Rethink aerial logistics. We are developing a platform that brings delivery planning, fleet coordination and mission simulation into one clear workflow.'}</p><p><strong>{de?'In Entwicklung · ausschließlich Simulation':'Under development · simulation only'}</strong></p><div className="actions"><Link className="button" href={`/${locale}/products/onesa-drone`}>{de?'Onesa Drone entdecken':'Explore Onesa Drone'}</Link><Link href={`/${locale}/contact?topic=drone`}>{de?'Projekt besprechen':'Discuss your project'}</Link></div></div><figure className={styles.portfolioImage}><DroneImage locale={locale}/><figcaption>{de?'KI-generierte Konzeptvisualisierung.':'AI-generated concept visualization.'}</figcaption></figure></section>;
}
const sections={
 en:[
  ['Autonomous delivery workflow','Register a package, assess compatibility, plan a route, validate preflight and authorize a simulation. Follow virtual delivery and return through a durable mission history.'],
  ['Fleet intelligence','Manage illustrative multirotor, VTOL and fixed-wing configurations, inspect availability, battery state and maintenance records. Aircraft specifications are simulation assumptions.'],
  ['3D simulation','Explore a procedural campus, camera views, weather visualization, telemetry and recorded mission replay. The digital twin is an illustrative kinematic environment, not validated flight dynamics.'],
  ['Enterprise use cases','Evaluate industrial campuses, warehouses, healthcare supplies, agriculture, remote communities and enterprise logistics. Geography, operating preferences and regional review remain configurable.'],
  ['Onesa AI integration','Read-only operational summaries explain fleet conditions and mission outcomes. The existing Onesa AI conversation adapter requires a separately approved identity and qualified connection; AI cannot authorize missions.'],
  ['Security and safety','Tenant-scoped access, explicit operator permissions, auditable commands and an independent deterministic safety supervisor. Physical-aircraft interfaces remain disabled.'],
  ['Product development roadmap','Foundation and delivery simulation → richer environments and qualified SITL → approved AI and observability integration → hosted acceptance. Physical development requires its own authorization, hardware validation and regulatory process.'],
 ],
 de:[
  ['Autonomer Lieferablauf','Paket registrieren, Kompatibilität prüfen, Route planen, Vorflugregeln validieren und eine Simulation autorisieren. Virtuelle Lieferung und Rückkehr bleiben im Missionsverlauf nachvollziehbar.'],
  ['Flottenintelligenz','Illustrative Multirotor-, VTOL- und Starrflügel-Konfigurationen verwalten, Verfügbarkeit, Batteriezustand und Wartung prüfen. Leistungsdaten sind Simulationsannahmen.'],
  ['3D-Simulation','Prozeduralen Campus, Kameraansichten, Wettervisualisierung, Telemetrie und aufgezeichnete Missionen untersuchen. Der digitale Zwilling ist ein illustratives kinematisches Modell, keine validierte Flugdynamik.'],
  ['Anwendungen für Unternehmen','Industriecampus, Lager, medizinische Versorgung, Landwirtschaft, abgelegene Gemeinden und Unternehmenslogistik evaluieren. Regionen und Betriebseinstellungen benötigen eine eigene Prüfung.'],
  ['Onesa AI Integration','Schreibgeschützte Zusammenfassungen erklären Flottenzustand und Missionsergebnisse. Der Adapter zur bestehenden Onesa AI benötigt eine gesondert genehmigte Identität und qualifizierte Verbindung; KI kann keine Missionen autorisieren.'],
  ['Sicherheit und Schutz','Mandantengebundener Zugriff, ausdrückliche Operator-Berechtigungen, nachvollziehbare Befehle und eine unabhängige deterministische Sicherheitsüberwachung. Physische Flugzeugschnittstellen bleiben deaktiviert.'],
  ['Produkt-Roadmap','Grundlage und Liefersimulation → erweiterte Umgebungen und qualifizierte SITL → genehmigte KI- und Monitoring-Anbindung → Abnahme im Hosting. Physische Entwicklung benötigt eigene Autorisierung, Hardwarevalidierung und regulatorische Verfahren.'],
 ],
} as const;
export function DroneProduct({locale}:{locale:Locale}) {
 const de=locale==='de';
 return <main id="main">
  <section className={`page-hero section ${styles.hero}`} aria-labelledby="drone-title">
   <div className={styles.heroCopy}>
    <p className="eyebrow">PHYSICAL AI / {de?'IN ENTWICKLUNG · NUR SIMULATION':'UNDER DEVELOPMENT · SIMULATION ONLY'}</p>
    <h1 id="drone-title">Onesa Drone</h1>
    <p className={styles.tagline}>Intelligent Delivery Beyond Roads</p>
    <p>{de?'Neue Wege für Ihre Lieferkette. Wir entwickeln intelligente Luftlogistik – von der Lieferanfrage bis zur simulierten Mission.':'New possibilities for your supply chain. We are developing intelligent aerial logistics, from delivery request to simulated mission.'}</p>
    <div className="actions"><a className="button" href="#platform">{de?'Plattform entdecken':'Explore the platform'} <span aria-hidden="true">→</span></a><a href="#concept-film">{de?'Konzeptfilm ansehen':'Watch the concept film'} <span aria-hidden="true">↘</span></a></div>
   </div>
   <figure className={styles.heroVisual}><DroneImage locale={locale} priority/><figcaption>{de?'KI-generierte Konzeptvisualisierung · kein realer Prototyp':'AI-generated concept visualization · not a real prototype'}</figcaption></figure>
  </section>
  <div className={`section ${styles.highlights}`} aria-label={de?'Die Produktidee':'The product vision'}>
   {(de ? [['01 / PLANEN','Ihre Mission im Mittelpunkt.'],['02 / SIMULIEREN','Jeden Schritt nachvollziehen.'],['03 / VERBINDEN','Logistik weiterdenken.']] : [['01 / PLAN','Start with your mission.'],['02 / SIMULATE','Understand every step.'],['03 / CONNECT','See logistics differently.']]).map(([label,title])=><div key={label}><span>{label}</span><p>{title}</p></div>)}
  </div>
  <section id="platform" className={`section ${styles.portfolio}`} aria-labelledby="drone-platform-title">
   <div><p className="eyebrow">{de?'PRODUKTÜBERBLICK':'PRODUCT OVERVIEW'}</p><h2 id="drone-platform-title">{de?'Luftlogistik als ein zusammenhängender Ablauf.':'Aerial logistics, as one connected workflow.'}</h2><p>{de?'Die Entwicklungssoftware verbindet Lieferanfragen, Flottenplanung, Missionssimulation und aufgezeichnete Telemetrie in einem modularen Arbeitsbereich. Die Implementierung ist ausschließlich für Simulation bestimmt; öffentliches Hosting und Nutzerabnahme benötigen eine eigene Freigabe.':'The development software combines delivery requests, fleet planning, mission simulation and recorded telemetry in one modular workspace. The implementation is simulation only; public hosting and user acceptance require separate release verification.'}</p><p>{de?'Keine betrieblichen Lieferdienste, Flugfreigaben oder Zertifizierung werden angeboten.':'No operational delivery service, flight authorization or certification is offered.'}</p></div>
   <figure className={styles.cargoVisual}><DroneImage locale={locale} scene="cargo"/><figcaption>{de?'Fracht und Fluggerät als zusammenhängendes Konzept. KI-generierte Illustration; keine festgelegte Hardware-Spezifikation.':'Cargo and aircraft, imagined together. AI-generated illustration; not a finalized hardware specification.'}</figcaption></figure>
  </section>
  <section id="concept-film" className={`section ${styles.filmSection}`} aria-labelledby="drone-film-title">
   <div className={styles.sectionHead}><div><p className="eyebrow">{de?'DIE VISION IN BEWEGUNG':'THE VISION IN MOTION'}</p><h2 id="drone-film-title">{de?'Eine neue Perspektive auf Lieferung.':'A new perspective on delivery.'}</h2></div><p>{de?'Ein kurzer visueller Einblick in unsere Produktidee. Originale Konzeptbilder, als ruhiger Film inszeniert.':'A short visual introduction to the product vision. Original concept imagery, brought together in a quiet cinematic sequence.'}</p></div>
   <DroneFilm locale={locale}/>
  </section>
  <div className={`section ${styles.sections}`}><p className="eyebrow">{de?'SOFTWAREUMFANG UND ENTWICKLUNGSPLAN':'SOFTWARE SCOPE AND DEVELOPMENT ROADMAP'}</p>{sections[locale].map(([title,body],i)=><section key={title}><span className={styles.number}>0{i+1}</span><div><h2>{title}</h2><p>{body}</p></div></section>)}
   <details className={styles.explorer}><summary>{de?'Illustrative Fluggeräteansicht erkunden':'Explore an illustrative aircraft view'}</summary><DroneVisual locale={locale}/></details>
  </div>
  <section className={`section ${styles.enquiry}`}><p className="eyebrow">{de?'GEMEINSAM ENTWICKELN':'BUILD WITH US'}</p><h2>{de?'Ihre nächste Lieferung beginnt mit einer Idee.':'Your next delivery starts with an idea.'}</h2><p>{de?'Campus, Lager oder abgelegener Standort? Beschreiben Sie Ihr Logistik-Szenario und besprechen Sie mit uns einen möglichen Simulations-Pilotversuch.':'Campus, warehouse or remote location? Share your logistics scenario and talk to us about a potential simulation pilot.'}</p><Link className="button" href={`/${locale}/contact?topic=drone`}>{de?'Projekt besprechen':'Discuss your project'} <span aria-hidden="true">→</span></Link></section>
 </main>;
}
