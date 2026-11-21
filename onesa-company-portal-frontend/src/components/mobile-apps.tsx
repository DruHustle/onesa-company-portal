import type {Locale} from '@/config/copy';
import {mobileApps, type MobileApp} from '@/config/mobile-apps';
import styles from './mobile-apps.module.css';

type Platform = 'ios' | 'android';

function PlatformBadge({app, platform, locale}: {app: MobileApp; platform: Platform; locale: Locale}) {
  const release = app[platform];
  const label = platform === 'ios' ? 'iOS' : 'Android';
  const channel = release?.channel === 'APK'
    ? (locale === 'de' ? 'APK herunterladen' : 'Download APK')
    : release?.channel;
  const status = channel ?? (locale === 'de' ? 'Noch nicht verfügbar' : 'Not yet available');
  const contents = <>
    <span className={styles[platform]} aria-hidden="true" />
    <span><strong>{label}</strong><small>{status}</small></span>
  </>;
  if (release) {
    return <a className={styles.badge} href={release.url}
      aria-label={`${app.name} · ${label} · ${status}`}>{contents}</a>;
  }
  return <span className={styles.badge}>{contents}</span>;
}

export function MobileApps({locale}: {locale: Locale}) {
  const de = locale === 'de';
  return <section id="mobile-apps" aria-labelledby="mobile-apps-title" className={styles.directory}>
    <h2 id="mobile-apps-title">{de ? 'Mobile Apps' : 'Mobile apps'}</h2>
    <ul>{mobileApps.map(app => <li key={app.name} className={styles.row}>
      <div>
        <h3>{app.website ? <a href={app.website}>{app.name} <span aria-hidden="true">↗</span></a> : app.name}</h3>
        {app.parent && <p>{de ? `Ein Produkt von ${app.parent}` : `An ${app.parent} product`}</p>}
      </div>
      <div className={styles.platforms}>
        <PlatformBadge app={app} platform="ios" locale={locale} />
        <PlatformBadge app={app} platform="android" locale={locale} />
      </div>
    </li>)}</ul>
  </section>;
}
