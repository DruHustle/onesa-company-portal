import type {Metadata} from 'next';
import {copy, type Locale} from '../config/copy';
import {companyOrigin, companyPageUrl, companyLanguages} from './site-origin.mjs';

export const socialImage = {
  url: 'https://onesa.eu/social/onesa-social-card.png',
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: 'Onesa — Engineering Intelligent Possibilities',
};


export function homepageMetadata(): Metadata {
  const title = 'Onesa | Engineering Intelligent Possibilities';
  const description = 'Onesa develops AI platforms, digital products and intelligent applications for businesses, developers and institutions across Europe and global markets.';
  const origin = companyOrigin();
  const url = companyPageUrl(origin, 'en');
  return {
    // All homepage sharing URLs are absolute; avoid Next normalizing the root slash.
    metadataBase: null, title: {absolute: title}, description,
    alternates: {canonical: url, languages: companyLanguages(origin)},
    openGraph: {type: 'website', siteName: 'Onesa', title, description, url,
      locale: 'en_US', alternateLocale: ['de_DE'],
      images: [{...socialImage, secureUrl: socialImage.url}]},
    twitter: {card: 'summary_large_image', title, description, images: [socialImage]},
  };
}

export const portalSocialImage = {
  url: '/social/onesa-banner.png',
  width: 1536,
  height: 1024,
  type: 'image/png',
  alt: 'ONESA wordmark',
};

export function companyMetadata({locale, path = '', title, description, translated = true, article = false}: {
  locale: Locale;
  path?: string;
  title?: string;
  description?: string;
  translated?: boolean;
  article?: boolean;
}): Metadata {
  if (locale === 'en' && !path && !title && !description) return homepageMetadata();
  const origin = companyOrigin();
  const url = companyPageUrl(origin, locale, path);
  const resolvedTitle = title ? `${title} | Onesa UG` : `Onesa UG — ${copy[locale].footer}`;
  const resolvedDescription = description || copy[locale].intro;
  return {
    metadataBase: null,
    title: {absolute: resolvedTitle},
    description: resolvedDescription,
    alternates: {
      canonical: url,
      ...(translated ? {languages: companyLanguages(origin, path)} : {}),
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
