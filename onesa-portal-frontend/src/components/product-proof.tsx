import type {Locale} from '@/config/copy';
import styles from './product-proof.module.css';

/** Screenshots of the actual local interfaces with invented, isolated API fixtures. */
export function ProductProof({product,locale}:{product:'ai'|'robot';locale:Locale}) {
 const de=locale==='de',ai=product==='ai';
 return <figure className={styles.figure}>
  <picture><source media="(prefers-color-scheme: dark)" srcSet={`/images/${product}-workspace-example-dark.png`}/><img src={`/images/${product}-workspace-example-light.png`} width="1440" height="1050" loading="lazy" decoding="async" alt={ai?(de?'Die tatsächliche Knowledge-Oberfläche mit erfundenen Projektnotizen.':'The actual Knowledge interface with invented project notes.'):(de?'Die tatsächliche Operator-Oberfläche mit gestoppter Simulation und nicht verbundener Hardware.':'The actual operator interface with a stopped simulation and no connected hardware.')}/></picture>
  <figcaption>{de?'Tatsächliche Softwareoberfläche, lokal mit synthetischen Daten gerendert. Keine Live-Nutzerdaten oder KI-Ergebnisse.':'Actual software interface, rendered locally with synthetic data. No live user data or AI-generated results.'}</figcaption>
 </figure>;
}
