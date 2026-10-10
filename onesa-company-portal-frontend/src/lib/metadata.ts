import type {Metadata} from 'next';
import {copy, type Locale} from '../config/copy';

export const socialImage = {
  url: '/brand/onesa-orbit.png',
  width: 972,
  height: 882,
  type: 'image/png',
  alt: 'ONESA UG orbit logo',
};

export function companyMetadata({locale, path = '', title, description, translated = true, article = false}: {
  locale: Locale;
  path?: string;
  title?: string;
  description?: string;
  translated?: boolean;
  article?: boolean;
}): Metadata {
  const origin = new URL(process.env.SITE_URL || 'http://localhost:3300').origin;
  const url = `${origin}/${locale}${path}`;
  const resolvedTitle = title ? `${title} | Onesa UG` : `Onesa UG — ${copy[locale].footer}`;
  const resolvedDescription = description || copy[locale].intro;
  return {
    title: {absolute: resolvedTitle},
    description: resolvedDescription,
    alternates: {
      canonical: url,
      ...(translated ? {languages: {en: `${origin}/en${path}`, de: `${origin}/de${path}`}} : {}),
    },
    openGraph: {
      type: article ? 'article' : 'website',
      siteName: 'Onesa UG',
      title: resolvedTitle,
      description: resolvedDescription,
      url,
      locale: locale === 'de' ? 'de_DE' : 'en_US',
      ...(translated ? {alternateLocale: [locale === 'de' ? 'en_US' : 'de_DE']} : {}),
      images: [socialImage],
    },
    twitter: {
      card: 'summary_large_image',
      title: resolvedTitle,
      description: resolvedDescription,
      images: [socialImage],
    },
  };
}

export function sectionTitle(locale: Locale, section: string): string {
  const legal: Record<string, string> = {
    impressum: 'Impressum',
    privacy: locale === 'en' ? 'Privacy information' : 'Datenschutzhinweise',
    cookies: 'Cookies',
    accessibility: locale === 'en' ? 'Accessibility' : 'Barrierefreiheit',
    search: locale === 'en' ? 'Search' : 'Suche',
  };
  return copy[locale].nav[section as keyof typeof copy.en.nav] || legal[section] || section;
}

export function sectionDescription(locale: Locale, section: string): string {
  const t = copy[locale];
  const descriptions: Record<string, string> = {
    about: t.missionText,
    products: t.productText,
    technology: t.capText,
    industries: locale === 'en'
      ? 'Explore Onesa UG’s technology for enterprise, industry, manufacturing, travel, e-commerce and financial technology.'
      : 'Entdecken Sie die Technologie von Onesa UG für Unternehmen, Industrie, Produktion, Reisen, E-Commerce und Finanztechnologie.',
    research: locale === 'en' ? 'Explore research and innovation at Onesa UG.' : 'Entdecken Sie Forschung und Innovation bei Onesa UG.',
    partnerships: locale === 'en' ? 'Connect with Onesa UG to discuss partnerships in software, AI and digital platforms.' : 'Sprechen Sie mit Onesa UG über Partnerschaften für Software, KI und digitale Plattformen.',
    careers: locale === 'en' ? 'Explore career opportunities and published vacancies at Onesa UG.' : 'Entdecken Sie Karrieremöglichkeiten und offene Stellen bei Onesa UG.',
    news: locale === 'en' ? 'Read the latest published company news and insights from Onesa UG.' : 'Lesen Sie die veröffentlichten Neuigkeiten und Einblicke von Onesa UG.',
    contact: locale === 'en' ? 'Contact Onesa UG about your software, AI and digital platform requirements.' : 'Kontaktieren Sie Onesa UG zu Ihren Anforderungen an Software, KI und digitale Plattformen.',
  };
  return descriptions[section] || `${sectionTitle(locale, section)} — Onesa UG. ${t.footer}`;
}
