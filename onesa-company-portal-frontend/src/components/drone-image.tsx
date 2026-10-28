import type {Locale} from '@/config/copy';
import styles from './drone-product.module.css';

/** Original concept artwork; these images do not depict existing aircraft. */
export function DroneImage({locale, scene = 'flight', priority = false}: {
  locale: Locale;
  scene?: 'flight' | 'cargo';
  priority?: boolean;
}) {
  const de = locale === 'de';
  return <picture className={styles.image}>
    <img
      src={`/images/drone-${scene}-1280.webp`}
      srcSet={`/images/drone-${scene}-640.webp 640w, /images/drone-${scene}-1280.webp 1280w`}
      sizes="(max-width: 760px) 100vw, 50vw"
      width="1280" height={scene === 'flight' ? '720' : '853'}
      loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      alt={scene === 'flight'
        ? (de ? 'KI-generiertes Konzept einer Lieferdrohne über einer grünen Flusslandschaft im Morgenlicht.' : 'AI-generated delivery drone concept above a green river landscape at dawn.')
        : (de ? 'KI-generiertes Konzept einer Lieferdrohne mit Frachtbehälter auf einem Landeplatz vor einem Lager.' : 'AI-generated delivery drone and cargo pod concept on a landing pad outside a warehouse.')}
    />
  </picture>;
}
