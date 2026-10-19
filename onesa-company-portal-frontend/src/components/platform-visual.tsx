import type {Locale} from '@/config/copy';
import styles from './platform-visual.module.css';

/** An original static illustration of implemented workspace capabilities, not user data. */
export function PlatformVisual({locale}:{locale:Locale}) {
  const de=locale==='de';
  return <figure className={styles.figure} aria-label={de?'Illustration der Plattform-Funktionen':'Illustration of platform capabilities'}>
    <div className={styles.workspace} aria-hidden="true">
      <div className={styles.bar}><strong>onesa<span>AI Platform</span></strong><span className={styles.dot}/></div>
      <div className={styles.body}>
        <div className={styles.sidebar}><span className={styles.selected}>Chat</span><span>Knowledge</span><span>Agents</span><span>Travel</span></div>
        <div className={styles.conversation}>
          <p className={styles.context}>{de?'MIT IHREM WISSEN ARBEITEN':'WORK WITH YOUR KNOWLEDGE'}</p>
          <div className={styles.question}>{de?'Was sind die nächsten Schritte?':'What are the next steps?'}</div>
          <div className={styles.answer}><span className={styles.mark}>o</span><div><strong>{de?'Vom Wissen zum nächsten Schritt.':'From knowledge to a next step.'}</strong><div className={styles.lines}><i/><i/><i/></div><span className={styles.source}>{de?'Projektübersicht':'Project brief'}<span>01</span></span></div></div>
          <div className={styles.composer}>{de?'Eine Frage stellen…':'Ask a question…'}<span>↑</span></div>
        </div>
      </div>
    </div>
    <figcaption>{de?'Arbeitsbereich illustriert · Beispielinhalte':'Workspace illustration · Example content'}</figcaption>
  </figure>;
}
