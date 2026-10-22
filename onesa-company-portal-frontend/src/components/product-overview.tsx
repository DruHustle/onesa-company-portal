import {ResponsiveLink as Link} from './responsive-link';
import {products} from '@/config/products';
import type {Locale} from '@/config/copy';
import applications from '@/config/onesa-applications.json';
import {ProductIllustration} from './product-illustration';
import {ProductProof} from './product-proof';
import {EditorialImage} from './editorial-image';
import styles from './product-overview.module.css';
import {Fragment} from 'react';
import {IndustrialAI} from './industrial-ai';

const applicationDirections = {
  en: {
    title: 'Apps powered by the Onesa AI Platform',
    introduction: 'The same intelligence engine can support different industries. Business and investment decision support, smart farming and application security are planned applications.',
    recommendations: 'Recommendations and decision support',
    recommendationsDescription: 'Travel planning, business feasibility and investment research. Help users compare options, explore scenarios and assess risks using relevant information, clearly stated assumptions and supporting sources.',
    security: 'Application security',
    securityDescription: 'AI-assisted code review, threat modelling and vulnerability triage can help teams identify risks, prioritize fixes and review remediation throughout the software lifecycle.',
    securityScope: 'A development direction for platform applications, with human review and authorization.',
    securityContact: 'Discuss application security',
    farming: 'Smart farming',
    farmingDescription: 'Help farmers choose suitable crops and plan cultivation step by step, from planting to harvest. Combine soil conditions, seasonal weather forecasts, water availability, production costs and market demand to support practical decisions.',
  },
  de: {
    title: 'Apps auf Basis der Onesa AI Platform',
    introduction: 'Dieselbe Intelligenz-Engine kann unterschiedliche Branchen unterstützen. Entscheidungshilfen für Unternehmen und Investitionen, intelligente Landwirtschaft und Anwendungssicherheit sind geplante Anwendungen.',
    recommendations: 'Empfehlungen und Entscheidungshilfen',
    recommendationsDescription: 'Reiseplanung, Machbarkeitsanalysen für Geschäftsideen und Investitionsrecherche. Optionen vergleichen, Szenarien untersuchen und Risiken anhand relevanter Informationen, klar benannter Annahmen und nachvollziehbarer Quellen einschätzen.',
    security: 'Anwendungssicherheit',
    securityDescription: 'KI-gestützte Code-Reviews, Bedrohungsmodellierung und die Bewertung von Schwachstellen können Teams helfen, Risiken zu erkennen, Korrekturen zu priorisieren und die Behebung im gesamten Softwarelebenszyklus zu prüfen.',
    securityScope: 'Ein Entwicklungsbereich für Plattformanwendungen mit menschlicher Prüfung und Autorisierung.',
    securityContact: 'Anwendungssicherheit besprechen',
    farming: 'Intelligente Landwirtschaft',
    farmingDescription: 'Landwirte bei der Auswahl geeigneter Kulturen und der schrittweisen Anbauplanung von der Aussaat bis zur Ernte unterstützen. Bodenbedingungen, saisonale Wettervorhersagen, Wasserverfügbarkeit, Produktionskosten und Marktnachfrage verbinden, um praktische Entscheidungen zu erleichtern.',
  },
} as const;

function ApplicationDirections({locale}:{locale:Locale}) {
  const content = applicationDirections[locale];
  return <section id="platform-applications" className={styles.useCases} aria-labelledby="ai-applications-title">
    <p className="eyebrow">{locale==='de'?'ANWENDUNGEN':'APPLICATIONS'}</p>
    <h2 id="ai-applications-title">{content.title}</h2>
    <p>{content.introduction}</p>
    <div className={styles.useCaseGrid}>
      <div>
        <EditorialImage subject="finance" locale={locale}/>
        <div className={styles.useCaseCopy}>
        <h3>{content.recommendations}</h3>
        <p>{content.recommendationsDescription}</p>
        </div>
      </div>
      <div>
        <EditorialImage subject="farming" locale={locale}/>
        <div className={styles.useCaseCopy}>
        <h3>{content.farming}</h3>
        <p>{content.farmingDescription}</p>
        </div>
      </div>
      <div id="application-security" className={styles.securityDirection}>
        <EditorialImage subject="enterprise" locale={locale}/>
        <div className={styles.useCaseCopy}>
          <h3>{content.security}</h3>
          <p>{content.securityDescription}</p>
          <p className={styles.directionScope}>{content.securityScope}</p>
          <Link href={`/${locale}/contact?topic=application-security`}>{content.securityContact}</Link>
        </div>
      </div>
    </div>
  </section>;
}

/** Product information renders with the page, without waiting for the content API. */
export function ProductOverview({locale}:{locale:Locale}) {
  return <><section aria-label={locale==='de'?'Onesa Produkte':'Onesa products'}>
    {products[locale].map(product=><Fragment key={product.id}><article className={`product-section ${styles.product}`} aria-labelledby={`product-${product.id}`}>
      <div>
      <p className="eyebrow">{product.category}</p>
      <h2 id={`product-${product.id}`}>{product.name}</h2>
      <p>{product.description}</p><p><strong>{locale==='de'?'Entwicklungsstand':'Current scope'}</strong> — {product.id==='ai'?(locale==='de'?'Plattform in Entwicklung. Chat, Knowledge, Agents und Travel stehen im geschützten Arbeitsbereich zur Verfügung.':'Platform under development. Chat, Knowledge, Agents and Travel are available in the protected workspace.'):(locale==='de'?'Separate Robotik-Entwicklung. Derzeit ein geschützter Software-Simulator mit einem Gelenk; keine vollständige humanoide Simulation.':'A separate robotics development line. Currently a protected one-joint software simulator, not a complete humanoid simulation.')}</p>
      <div className="actions">
        <a className="button" href={applications.applications.find(app=>app.id===product.id)!.href}>{product.open} ↗</a>
        <a href={product.docs}>{product.guide}</a><Link href={`/${locale}/contact?topic=${product.id==='ai'?'ai-platform':'robot'}`}>{locale==='de'?'Dieses Produkt besprechen':'Discuss this product'}</Link>
      </div>
      </div>
      <ProductIllustration product={product.id} locale={locale}/>
      <section className={styles.details} aria-label={`${product.name} — ${locale==='de'?'Möglichkeiten':'Capabilities'}`}>
        {product.capabilities.map((capability,index)=><div key={capability}>
          <h3>{(locale==='de'
            ? (product.id==='ai'?['Wissen verbinden','Abläufe gestalten','Industrial AI vorbereiten']:['Aufgaben steuern','Zustände verstehen','Integration entwickeln'])
            : (product.id==='ai'?['Connect knowledge','Build workflows','Prepare Industrial AI']:['Direct tasks','Understand state','Develop integration']))[index]}</h3>
          <p>{capability}</p>
        </div>)}
      </section>
      {product.id==='ai'&&<section className={styles.workspace} aria-labelledby="ai-workspace-title"><div><p className="eyebrow">{locale==='de'?'IM PRODUKT':'INSIDE THE PRODUCT'}</p><h3 id="ai-workspace-title">{locale==='de'?'Ein Arbeitsbereich für Wissen und nächste Schritte.':'A workspace for knowledge and next steps.'}</h3><p>{locale==='de'?'Chat, Knowledge, Agents und Travel verbinden Gespräche mit eigenem Wissen und geführten Aufgaben. Die Produktdokumentation erklärt die verfügbaren Funktionen und ihre Grenzen.':'Chat, Knowledge, Agents and Travel connect conversations with your knowledge and guided tasks. The product documentation explains the available features and their boundaries.'}</p></div><ProductProof product="ai" locale={locale}/></section>}
      {product.id==='robot'&&<section className={styles.workspace} aria-label={locale==='de'?'Die Simulator-Oberfläche':'Inside the simulator'}><div><p className="eyebrow">{locale==='de'?'SOFTWARE-SIMULATION':'SOFTWARE SIMULATION'}</p><h3>{locale==='de'?'Vorschlagen. Prüfen. Den Zustand verstehen.':'Propose. Review. Understand the state.'}</h3><p>{locale==='de'?'Die geschützte Oberfläche trennt Vorschlag, Bestätigung, simulierten Zustand und Stop. Eine Administratorberechtigung ist keine verbundene oder qualifizierte Hardware.':'The protected interface separates proposals, confirmation, simulated state and Stop. Administrator permission is distinct from connected or qualified hardware.'}</p></div><ProductProof product="robot" locale={locale}/></section>}
    </article>{product.id==='ai'&&<><ApplicationDirections locale={locale}/><IndustrialAI locale={locale}/></>}</Fragment>)}
  </section></>;
}
