import {capabilities, type Locale} from './copy';

// Stable fragment identifiers are shared by homepage links and Technology headings.
const topics = [
  {id:'ai-engineering', en:[
    'Connect models, knowledge and application workflows to turn information into useful decisions and actions.',
    'Applications include source-backed answers, recommendations and agent-assisted tasks. Evaluation, data access and human oversight belong in the workflow from the start.',
  ], de:[
    'Modelle, Wissen und Anwendungsabläufe verbinden, damit Informationen zu hilfreichen Entscheidungen und Aktionen werden.',
    'Beispiele sind quellenbasierte Antworten, Empfehlungen und agentengestützte Aufgaben. Bewertung, Datenzugriff und menschliche Kontrolle gehören von Anfang an zum Ablauf.',
  ]},
  {id:'software-development', en:[
    'Shape an idea into an application people can use, from the interface to the services behind it.',
    'Web applications, business tools and APIs need clear user journeys, accessible interfaces and dependable integrations. Testing and maintenance keep the experience reliable as the product evolves.',
  ], de:[
    'Aus einer Idee wird eine nutzbare Anwendung – von der Oberfläche bis zu den dahinterliegenden Diensten.',
    'Webanwendungen, Geschäftswerkzeuge und APIs brauchen klare Nutzerwege, zugängliche Oberflächen und verlässliche Integrationen. Tests und Wartung sichern das Nutzungserlebnis bei der Weiterentwicklung.',
  ]},
  {id:'cloud-infrastructure', en:[
    'Give applications a dependable foundation for hosting, networking and secure service communication.',
    'Deployment pipelines, monitoring, backups and recovery connect development with day-to-day operation. Capacity and architecture should follow the workload, with staging and production kept separate.',
  ], de:[
    'Eine verlässliche Grundlage für Hosting, Netzwerke und sichere Kommunikation zwischen Anwendungsdiensten schaffen.',
    'Bereitstellung, Überwachung, Backups und Wiederherstellung verbinden Entwicklung und Betrieb. Kapazität und Architektur richten sich nach der Auslastung; Staging und Produktion bleiben getrennt.',
  ]},
  {id:'data-engineering', en:[
    'Bring information from different sources into a form that applications, analytics and AI can use.',
    'Data pipelines, validation and retrieval connect source systems to useful outputs. Quality, provenance, access permissions and retention need attention throughout the data lifecycle.',
  ], de:[
    'Informationen aus verschiedenen Quellen so aufbereiten, dass Anwendungen, Analysen und KI sie nutzen können.',
    'Datenpipelines, Validierung und gezielter Abruf verbinden Quellsysteme mit nutzbaren Ergebnissen. Qualität, Herkunft, Zugriffsrechte und Aufbewahrung sind im gesamten Datenlebenszyklus zu berücksichtigen.',
  ]},
  {id:'enterprise-systems', en:[
    'Connect the tools and processes teams rely on to run their organization.',
    'Internal portals, approval workflows and integrations can reduce repeated manual work. Clear responsibilities, role-based access and traceable changes help teams retain control.',
  ], de:[
    'Die Werkzeuge und Abläufe verbinden, auf die Teams im täglichen Betrieb angewiesen sind.',
    'Interne Portale, Freigabeprozesse und Integrationen können wiederholte manuelle Arbeit reduzieren. Klare Zuständigkeiten, rollenbasierte Zugriffe und nachvollziehbare Änderungen unterstützen die Kontrolle.',
  ]},
  {id:'industrial-ai', en:[
    'Explore how intelligence can connect software with machines and physical environments.',
    'Potential applications include condition monitoring, inspection and operator decision support. Robotics and physical AI require hardware integration, validated sensing and control, and operating safeguards specific to each deployment.',
  ], de:[
    'Untersuchen, wie intelligente Systeme Software mit Maschinen und physischen Umgebungen verbinden können.',
    'Mögliche Anwendungen sind Zustandsüberwachung, Inspektion und Entscheidungsunterstützung. Robotik und physische KI benötigen Hardwareintegration, validierte Sensorik und Steuerung sowie einsatzspezifische Schutzmaßnahmen.',
  ]},
  {id:'digital-platforms', en:[
    'Build a shared foundation that can support multiple applications, teams and integrations.',
    'Reusable services, APIs and consistent identity let new experiences build on existing capabilities. Clear boundaries between public content, user workspaces and administration help a platform grow coherently.',
  ], de:[
    'Eine gemeinsame Grundlage für mehrere Anwendungen, Teams und Integrationen entwickeln.',
    'Wiederverwendbare Dienste, APIs und eine konsistente Identität ermöglichen neue Angebote auf bestehenden Fähigkeiten. Klare Grenzen zwischen öffentlichen Inhalten, Nutzerbereichen und Administration unterstützen ein geordnetes Wachstum.',
  ]},
  {id:'commerce-fintech', en:[
    'Design the application infrastructure behind digital commerce and financial workflows.',
    'Examples include product catalogues, transaction integrations and reconciliation tools. Security, auditability and applicable regulatory requirements must shape each implementation before real transactions are introduced.',
  ], de:[
    'Anwendungsinfrastruktur für digitalen Handel und finanzbezogene Abläufe gestalten.',
    'Beispiele sind Produktkataloge, Transaktionsintegrationen und Abstimmungswerkzeuge. Sicherheit, Nachvollziehbarkeit und anwendbare regulatorische Anforderungen prägen die Umsetzung vor der Einführung realer Transaktionen.',
  ]},
] as const;

export function technologyTopics(locale: Locale) {
  return topics.map((topic, index) => ({
    id: topic.id,
    title: capabilities[locale][index],
    introduction: topic[locale][0],
    detail: topic[locale][1],
  }));
}
