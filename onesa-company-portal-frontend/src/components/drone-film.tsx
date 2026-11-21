'use client';

import {useRef, useState} from 'react';
import type {Locale} from '@/config/copy';
import styles from './drone-product.module.css';

/** Silent animated artwork, loaded only after an explicit play request. */
export function DroneFilm({locale}: {locale: Locale}) {
  const video = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);
  const de = locale === 'de';

  function play() {
    const element = video.current;
    if (!element) return;
    setFailed(false);
    setActive(true);
    element.src = '/media/onesa-drone-concept.mp4';
    element.controls = true;
    void element.play().catch(() => setFailed(true));
  }

  return <figure className={styles.film}>
    <div className={styles.filmFrame}>
      <video ref={video} controls={active} aria-hidden={!active} playsInline preload="none"
        poster="/images/drone-flight-1280.webp" width="1280" height="720"
        aria-label={de ? 'Onesa Drone Konzeptfilm: zwei animierte Konzeptbilder, ohne Ton.' : 'Onesa Drone concept film: two animated concept illustrations, without sound.'}
        aria-describedby="drone-film-caption"
        onError={() => setFailed(true)}
      />
      {!active && <button className={styles.play} type="button" onClick={play}>
        <span className={styles.playIcon} aria-hidden="true">▶</span>
        <span>{de ? 'Konzeptfilm abspielen' : 'Play concept film'}<small>{de ? '12 Sek. · ohne Ton' : '12 sec · silent'}</small></span>
      </button>}
    </div>
    <figcaption id="drone-film-caption">{de
      ? 'Animierte, KI-generierte Konzeptbilder. Keine Flugaufnahmen oder Aufnahmen eines Prototyps. Der Film startet nur auf Ihren Wunsch; die Bilder und Produktinformationen sind auch ohne Wiedergabe verfügbar.'
      : 'Animated, AI-generated concept artwork. No flight footage or prototype footage. The film plays only when you choose; the images and product information are also available without playback.'}</figcaption>
    {failed && <p role="status">{de ? 'Der Film konnte nicht abgespielt werden. Die Konzeptbilder und Produktinformationen bleiben verfügbar.' : 'The film could not play. The concept images and product information remain available.'}</p>}
  </figure>;
}
