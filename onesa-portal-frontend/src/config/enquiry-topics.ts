/** Public visitor context only; no access or processing permission is inferred. */
export const enquiryTopics = {
  "ai-platform": {
    en: "Onesa AI Platform",
    de: "Onesa AI Platform",
    category: "enterprise",
  },
  "application-security": {
    en: "Application security — platform development",
    de: "Anwendungssicherheit — Plattformentwicklung",
    category: "enterprise",
  },
  robot: {
    en: "Onesa Robot — software development",
    de: "Onesa Robot — Softwareentwicklung",
    category: "enterprise",
  },
  drone: {
    en: "Onesa Drone — simulation development",
    de: "Onesa Drone — Simulationsentwicklung",
    category: "enterprise",
  },
  enterprise: {
    en: "Enterprise technology",
    de: "Unternehmenstechnologie",
    category: "enterprise",
  },
  industrial: {
    en: "Industrial information and monitoring",
    de: "Industrielle Informationen und Überwachung",
    category: "enterprise",
  },
  manufacturing: {
    en: "Manufacturing",
    de: "Produktion",
    category: "enterprise",
  },
  travel: {
    en: "Travel applications",
    de: "Reiseanwendungen",
    category: "enterprise",
  },
  commerce: {
    en: "Commerce applications",
    de: "Handelsanwendungen",
    category: "enterprise",
  },
  finance: {
    en: "Business and investment research",
    de: "Unternehmens- und Investitionsrecherche",
    category: "enterprise",
  },
  farming: {
    en: "Smart farming — planned application",
    de: "Intelligente Landwirtschaft — geplante Anwendung",
    category: "enterprise",
  },
  partnership: {
    en: "Product or research partnership",
    de: "Produkt- oder Forschungspartnerschaft",
    category: "partnership",
  },
  research: {
    en: "Research collaboration",
    de: "Forschungskooperation",
    category: "research",
  },
} as const;
export type EnquiryTopic = keyof typeof enquiryTopics;
export function enquiryTopic(value: unknown): EnquiryTopic | undefined {
  return typeof value === "string" && Object.hasOwn(enquiryTopics, value)
    ? (value as EnquiryTopic)
    : undefined;
}
