import {ResponsiveLink as Link} from './responsive-link';
import {products} from '@/config/products';
import type {Locale} from '@/config/copy';
import applications from '@/config/onesa-applications.json';
import {ProductIllustration} from './product-illustration';
import {PlatformVisual} from './platform-visual';
import {EditorialImage} from './editorial-image';
import styles from './product-overview.module.css';

const applicationDirections = {
  en: {
    title: 'Apps powered by the Onesa AI Platform',
    introduction: 'The same intelligence engine can support different industries. Business and investment decision support and smart farming are planned applications.',
    recommendations: 'Recommendations and decision support',
    recommendationsDescription: 'Travel planning, business feasibility and investment research. Help users compare options, explore scenarios and assess risks using relevant information, clearly stated assumptions and supporting sources.',
    farming: 'Smart farming',
    farmingDescription: 'Help farmers choose suitable crops and plan cultivation step by step, from planting to harvest. Combine soil conditions, seasonal weather forecasts, water availability, production costs and market demand to support practical decisions.',
  },
  de: {
    title: 'Apps auf Basis der Onesa AI Platform',
    introduction: 'Dieselbe Intelligenz-Engine kann unterschiedliche Branchen unterstützen. Entscheidungshilfen für Unternehmen und Investitionen sowie intelligente Landwirtschaft sind geplante Anwendungen.',
    recommendations: 'Empfehlungen und Entscheidungshilfen',
    recommendationsDescription: 'Reiseplanung, Machbarkeitsanalysen für Geschäftsideen und Investitionsrecherche. Optionen vergleichen, Szenarien untersuchen und Risiken anhand relevanter Informationen, klar benannter Annahmen und nachvollziehbarer Quellen einschätzen.',
    farming: 'Intelligente Landwirtschaft',
    farmingDescription: 'Landwirte bei der Auswahl geeigneter Kulturen und der schrittweisen Anbauplanung von der Aussaat bis zur Ernte unterstützen. Bodenbedingungen, saisonale Wettervorhersagen, Wasserverfügbarkeit, Produktionskosten und Marktnachfrage verbinden, um praktische Entscheidungen zu erleichtern.',
  },
} as const;

function ApplicationDirections({locale}:{locale:Locale}) {
  const content = applicationDirections[locale];
  return <section className={styles.useCases} aria-labelledby="ai-applications-title">
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
    </div>
  </section>;
}

/** Product information renders with the page, without waiting for the content API. */
export function ProductOverview({locale}:{locale:Locale}) {
  return <><section aria-label={locale==='de'?'Onesa Produkte':'Onesa products'}>
    {products[locale].map(product=><article className={`product-section ${styles.product}`} key={product.id} aria-labelledby={`product-${product.id}`}>
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
            ? (product.id==='ai'?['Wissen verbinden','Abläufe gestalten','Zukunft erforschen']:['Aufgaben steuern','Zustände verstehen','Integration entwickeln'])
            : (product.id==='ai'?['Connect knowledge','Build workflows','Explore what’s next']:['Direct tasks','Understand state','Develop integration']))[index]}</h3>
          <p>{capability}</p>
        </div>)}
      </section>
      {product.id==='ai'&&<section className={styles.workspace} aria-labelledby="ai-workspace-title"><div><p className="eyebrow">{locale==='de'?'IM PRODUKT':'INSIDE THE PRODUCT'}</p><h3 id="ai-workspace-title">{locale==='de'?'Ein Arbeitsbereich für Wissen und nächste Schritte.':'A workspace for knowledge and next steps.'}</h3><p>{locale==='de'?'Chat, Knowledge, Agents und Travel verbinden Gespräche mit eigenem Wissen und geführten Aufgaben. Die Produktdokumentation erklärt die verfügbaren Funktionen und ihre Grenzen.':'Chat, Knowledge, Agents and Travel connect conversations with your knowledge and guided tasks. The product documentation explains the available features and their boundaries.'}</p></div><PlatformVisual locale={locale}/></section>}
    </article>)}
  </section><ApplicationDirections locale={locale}/></>;
}
