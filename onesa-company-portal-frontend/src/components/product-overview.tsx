import type {Locale} from '@/config/copy';
import applications from '@/config/onesa-applications.json';
import {ProductIllustration} from './product-illustration';
import styles from './product-overview.module.css';

const products = {
  en: [
    {
      id: 'ai',
      name: 'Onesa AI Platform',
      category: 'AI engine & applications',
      description: 'An intelligence engine for building useful applications and connecting knowledge, reasoning and tools. Chat, Knowledge, Agents and Travel are application experiences built around the platform.',
      capabilities: ['Conversations and answers grounded in your knowledge.', 'Agents and tools for application workflows.', 'An integration vision for robotics, autonomous ground and aerial vehicles, and physical AI. AGI is a long-term research direction.'],
      docs: 'https://docs.onesa.eu/docs/public/ai-platform',
      open: 'Open AI Platform',
      guide: 'AI Platform documentation',
    },
    {
      id: 'robot',
      name: 'Onesa AI Robot',
      category: 'Robotics & cloud simulation',
      description: 'A robotics product connecting an operator workspace with a cloud simulation. Explore task execution, simulated robot state and the foundations for future physical AI integrations.',
      capabilities: ['An authenticated operator workspace for robot tasks.', 'Protected telemetry and task history.', 'Explicit simulation status and controlled execution. The current cloud experience uses simulation; physical integration is a separate development direction.'],
      docs: 'https://docs.onesa.eu/docs/public/robot',
      open: 'Explore AI Robot',
      guide: 'AI Robot documentation',
    },
  ],
  de: [
    {
      id: 'ai',
      name: 'Onesa AI Platform',
      category: 'KI-Engine & Anwendungen',
      description: 'Eine Intelligenz-Engine für nützliche Anwendungen, die Wissen, Denken und Werkzeuge verbindet. Chat, Knowledge, Agents und Travel sind Anwendungserlebnisse rund um die Plattform.',
      capabilities: ['Gespräche und Antworten auf Grundlage Ihres Wissens.', 'Agenten und Werkzeuge für Anwendungsabläufe.', 'Eine Integrationsvision für Robotik, autonome Boden- und Luftfahrzeuge sowie physische KI. AGI ist eine langfristige Forschungsrichtung.'],
      docs: 'https://docs.onesa.eu/docs/public/ai-platform',
      open: 'AI Platform öffnen',
      guide: 'Dokumentation zur AI Platform',
    },
    {
      id: 'robot',
      name: 'Onesa AI Robot',
      category: 'Robotik & Cloud-Simulation',
      description: 'Ein Robotikprodukt, das einen Operator-Arbeitsbereich mit einer Cloud-Simulation verbindet. Erkunden Sie Aufgabenabläufe, simulierte Roboterzustände und die Grundlagen zukünftiger physischer KI-Integrationen.',
      capabilities: ['Ein geschützter Operator-Arbeitsbereich für Roboteraufgaben.', 'Geschützte Telemetrie und Aufgabenhistorie.', 'Ein klarer Simulationsstatus und kontrollierte Ausführung. Die aktuelle Cloud-Anwendung arbeitet in Simulation; die physische Integration ist eine eigene Entwicklungsrichtung.'],
      docs: 'https://docs.onesa.eu/docs/public/robot',
      open: 'AI Robot entdecken',
      guide: 'Dokumentation zum AI Robot',
    },
  ],
} as const;

const applicationDirections = {
  en: {
    title: 'Apps powered by the Onesa AI Platform',
    introduction: 'The same intelligence engine can support different industries. Business and investment decision support and smart farming are planned applications.',
    recommendations: 'Recommendations and decision support',
    recommendationsDescription: 'Travel planning, business feasibility and investment research. Help users compare options, explore scenarios and assess risks using relevant information, clearly stated assumptions and supporting sources.',
    farming: 'Smart farming',
    farmingDescription: 'Help farmers choose suitable crops and plan cultivation step by step, from planting to harvest. Combine soil conditions, seasonal weather forecasts, water availability, production costs and market demand to support practical decisions.',
    workflow: 'The farming workflow',
    steps: ['Choose a crop', 'Plan cultivation', 'Monitor conditions', 'Adapt activities', 'Evaluate selling opportunities'],
  },
  de: {
    title: 'Apps auf Basis der Onesa AI Platform',
    introduction: 'Dieselbe Intelligenz-Engine kann unterschiedliche Branchen unterstützen. Entscheidungshilfen für Unternehmen und Investitionen sowie intelligente Landwirtschaft sind geplante Anwendungen.',
    recommendations: 'Empfehlungen und Entscheidungshilfen',
    recommendationsDescription: 'Reiseplanung, Machbarkeitsanalysen für Geschäftsideen und Investitionsrecherche. Optionen vergleichen, Szenarien untersuchen und Risiken anhand relevanter Informationen, klar benannter Annahmen und nachvollziehbarer Quellen einschätzen.',
    farming: 'Intelligente Landwirtschaft',
    farmingDescription: 'Landwirte bei der Auswahl geeigneter Kulturen und der schrittweisen Anbauplanung von der Aussaat bis zur Ernte unterstützen. Bodenbedingungen, saisonale Wettervorhersagen, Wasserverfügbarkeit, Produktionskosten und Marktnachfrage verbinden, um praktische Entscheidungen zu erleichtern.',
    workflow: 'Der landwirtschaftliche Ablauf',
    steps: ['Kultur auswählen', 'Anbau planen', 'Bedingungen beobachten', 'Maßnahmen anpassen', 'Verkaufsmöglichkeiten bewerten'],
  },
} as const;

function ApplicationDirections({locale}:{locale:Locale}) {
  const content = applicationDirections[locale];
  return <section className={styles.useCases} aria-labelledby="ai-applications-title">
    <h3 id="ai-applications-title">{content.title}</h3>
    <p>{content.introduction}</p>
    <div className={styles.useCaseGrid}>
      <div>
        <h4>{content.recommendations}</h4>
        <p>{content.recommendationsDescription}</p>
      </div>
      <div>
        <h4>{content.farming}</h4>
        <p>{content.farmingDescription}</p>
      </div>
    </div>
    <p className={styles.workflowLabel} id="farming-workflow-title">{content.workflow}</p>
    <ol className={styles.workflow} aria-labelledby="farming-workflow-title">
      {content.steps.map(step=><li key={step}>{step}</li>)}
    </ol>
  </section>;
}

/** Product information renders with the page, without waiting for the content API. */
export function ProductOverview({locale}:{locale:Locale}) {
  return <section aria-label={locale==='de'?'Onesa Produkte':'Onesa products'}>
    {products[locale].map(product=><article className={`product-section ${styles.product}`} key={product.id} aria-labelledby={`product-${product.id}`}>
      <div>
      <p className="eyebrow">{product.category}</p>
      <h2 id={`product-${product.id}`}>{product.name}</h2>
      <p>{product.description}</p>
      <ul className={styles.features}>{product.capabilities.map(capability=><li key={capability}>{capability}</li>)}</ul>
      <div className="actions">
        <a className="button" href={applications.applications.find(app=>app.id===product.id)!.href}>{product.open} ↗</a>
        <a href={product.docs}>{product.guide} ↗</a>
      </div>
      </div>
      <ProductIllustration product={product.id} locale={locale}/>
      {product.id==='ai'&&<ApplicationDirections locale={locale}/>}
    </article>)}
  </section>;
}
