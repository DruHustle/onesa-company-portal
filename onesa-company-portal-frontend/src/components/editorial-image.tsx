import type {Locale} from '@/config/copy';
import styles from './editorial-image.module.css';

const images = {
  enterprise: {prefix:'industry', en:'Illustrative contemporary workspace with glass meeting rooms and computer workstations.', de:'Illustrativer moderner Arbeitsbereich mit gläsernen Besprechungsräumen und Computerarbeitsplätzen.'},
  industrial: {prefix:'industry', en:'Illustrative industrial sensor and orderly metal pipework.', de:'Illustrativer Industriesensor an einer geordneten Anlage aus Metallrohren.'},
  manufacturing: {prefix:'industry', en:'Illustrative robotic arm beside a precision metal component in a manufacturing cell.', de:'Illustrativer Roboterarm neben einem Präzisionsbauteil in einer Fertigungszelle.'},
  travel: {prefix:'industry', en:'Illustrative Lisbon waterfront with blue water and warm stone architecture.', de:'Illustrative Uferlandschaft in Lissabon mit blauem Wasser und warmer Steinarchitektur.'},
  commerce: {prefix:'industry', en:'Illustrative organized fulfilment workstation with parcels and a handheld scanner.', de:'Illustrativer geordneter Versandarbeitsplatz mit Paketen und einem Handscanner.'},
  finance: {prefix:'industry', en:'Illustrative contemporary glass atrium with layered architectural reflections.', de:'Illustratives modernes Glasatrium mit architektonischen Spiegelungen.'},
  research: {prefix:'editorial', en:'Illustrative optical research setup with a glass prism and precision components.', de:'Illustrativer optischer Forschungsaufbau mit einem Glasprisma und Präzisionskomponenten.'},
  partnerships: {prefix:'editorial', en:'Illustrative shared engineering table with notebooks, laptops and material samples.', de:'Illustrativer gemeinsamer Engineering-Arbeitsplatz mit Notizbüchern, Laptops und Materialmustern.'},
  careers: {prefix:'editorial', en:'Illustrative engineering workspace beside tall windows in natural daylight.', de:'Illustrativer Engineering-Arbeitsplatz an großen Fenstern mit natürlichem Tageslicht.'},
  farming: {prefix:'editorial', en:'Illustrative crop rows with a soil sensor and irrigation in morning light.', de:'Illustrative Pflanzenreihen mit einem Bodensensor und Bewässerung im Morgenlicht.'},
} as const;
export type EditorialSubject = keyof typeof images;

/** Local responsive assets: no image service, remote requests or client JavaScript. */
export function EditorialImage({subject,locale,wide=false,className=''}:{subject:EditorialSubject;locale:Locale;wide?:boolean;className?:string}) {
  const image=images[subject],path=`/images/${image.prefix}-${subject}`;
  return <picture className={`${styles.picture} ${className}`}>
    <img src={`${path}-960.webp`} srcSet={`${path}-480.webp 480w, ${path}-960.webp 960w`}
      sizes={wide?'(max-width: 760px) calc(100vw - 48px), 88vw':'(max-width: 760px) calc(100vw - 48px), 43vw'}
      width="960" height="640" loading="lazy" decoding="async" alt={image[locale]}/>
  </picture>;
}
