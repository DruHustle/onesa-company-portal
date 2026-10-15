import {company} from '@/config/company';
import type {Locale} from '@/config/copy';

export function CompanyDetails({locale, register = false, footer = false}: {locale: Locale; register?: boolean; footer?: boolean}) {
  return <div className="company-details">
    <p><strong>{company.legalName}</strong></p>
    <address>{locale === 'de' ? company.address.replace(', Germany', ', Deutschland') : company.address}</address>
    {footer ? <p><a href={`/${locale}/contact`}>{locale === 'de' ? 'Kontakt' : 'Contact'}</a></p> : <p><a href={company.mailHref}>{company.email}</a> · <a href={company.telephoneHref}>{company.telephone}</a></p>}
    {register && <dl>
      <dt>{locale === 'de' ? 'Geschäftsführer' : 'Managing Director'}</dt><dd>{company.managingDirector}</dd>
      <dt>{locale === 'de' ? 'Registergericht' : 'Register court'}</dt><dd>{company.registerCourt}</dd>
      <dt>{locale === 'de' ? 'Handelsregisternummer' : 'Commercial register number'}</dt><dd>{company.registerNumber}</dd>
    </dl>}
  </div>;
}

export function LegalNotice({locale}: {locale: Locale}) {
  return <section className="prose" aria-label={locale === 'de' ? 'Anbieterangaben' : 'Service provider information'}>
    <h2>{locale === 'de' ? 'Angaben gemäß § 5 DDG' : 'Information under section 5 DDG'}</h2>
    <CompanyDetails locale={locale} register/>
  </section>;
}

export function PrivacyController({locale}: {locale: Locale}) {
  return <section className="prose">
    <h2>{locale === 'de' ? 'Verantwortlicher und Datenschutzkontakt' : 'Controller and privacy contact'}</h2>
    <CompanyDetails locale={locale}/>
    <p>{locale === 'de' ? 'Datenschutzanfragen: ' : 'Privacy enquiries: '}<a href={`mailto:${company.privacyEmail}`}>{company.privacyEmail}</a></p>
  </section>;
}
