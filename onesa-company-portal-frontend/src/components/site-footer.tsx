import {company} from '@/config/company';
import {copy, type Locale} from '@/config/copy';
import applications from '@/config/onesa-applications.json';
import {ResponsiveLink as Link} from './responsive-link';
import styles from './site-footer.module.css';

export function SiteFooter({locale}: {locale: Locale}) {
  const de = locale === 'de';
  const t = copy[locale];
  return <footer className={styles.footer}>
    <div className={styles.grid}>
      <div className={styles.brand}>
        <Link href={`/${locale}`} className="wordmark">onesa<span>UG</span></Link>
        <p className={styles.tagline}>{t.footer}</p>
        <Link className={styles.contact} href={`/${locale}/contact`}>{t.talk} <span aria-hidden="true">↗</span></Link>
        <address>{de ? company.address.replace(', Germany', ', Deutschland') : company.address}</address>
      </div>
      <nav className={styles.group} aria-labelledby="footer-company">
        <h2 id="footer-company">{de ? 'Unternehmen' : 'Company'}</h2>
        <ul>{(['about', 'technology', 'industries', 'partnerships', 'careers'] as const).map(key =>
          <li key={key}><Link href={`/${locale}/${key}`}>{t.nav[key]}</Link></li>)}</ul>
      </nav>
      <nav className={styles.group} aria-labelledby="footer-products">
        <h2 id="footer-products">{t.nav.products}</h2>
        <ul>
          <li><Link href={`/${locale}/products`}>{de ? 'Produkte entdecken' : 'Explore products'}</Link></li>
          {applications.applications.filter(app => app.id === 'ai' || app.id === 'robot').map(app =>
            <li key={app.id}><a href={app.href}>{app.label} <span aria-hidden="true">↗</span></a></li>)}
        </ul>
      </nav>
      <nav className={`${styles.group} ${styles.resources}`} aria-labelledby="footer-resources">
        <h2 id="footer-resources">{de ? 'Wissen & Einblicke' : 'Resources'}</h2>
        <ul>
          <li><a href={applications.applications.find(app => app.id === 'docs')!.href}>{de ? 'Dokumentation' : 'Developer docs'} <span aria-hidden="true">↗</span></a></li>
          <li><Link href={`/${locale}/news`}>{t.nav.news}</Link></li>
          <li><Link href={`/${locale}/research`}>{t.nav.research}</Link></li>
        </ul>
      </nav>
    </div>
    <div className={styles.bottom}>
      <p>© {new Date().getFullYear()} {company.legalName}</p>
      <nav aria-label={de ? 'Rechtliches und Verwaltung' : 'Legal and administration'}>
        <Link href={`/${locale}/impressum`}>{de ? 'Impressum' : 'Legal notice'}</Link>
        <Link href={`/${locale}/privacy`}>{de ? 'Datenschutz' : 'Privacy'}</Link>
        <Link href={`/${locale}/cookies`}>Cookies</Link>
        <Link href={`/${locale}/accessibility`}>{de ? 'Barrierefreiheit' : 'Accessibility'}</Link>
        <Link href="/admin">Administration</Link>
      </nav>
    </div>
  </footer>;
}
