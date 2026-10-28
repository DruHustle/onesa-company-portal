'use client';
import {useState} from 'react';
import type {Locale} from '@/config/copy';
import styles from './drone-product.module.css';
/** Original illustrative vector geometry; no flight model or external assets. */
export function DroneVisual({locale}:{locale:Locale}) {
 const [angle,setAngle]=useState(25); const de=locale==='de';
 return <figure className={styles.visual}>
  <div className={styles.airspace}><span>ONESA / SIMULATION CONCEPT</span><svg viewBox="0 0 600 360" role="img" aria-label={de?'Illustratives Lieferdrohnen-Konzept':'Illustrative delivery drone concept'} style={{transform:`perspective(800px) rotateX(20deg) rotateZ(${angle}deg)`}}>
   <g fill="none" stroke="currentColor" strokeWidth="12"><path d="m190 100 220 160m-220 0 220-160"/>{[190,410].flatMap(x=>[100,260].map(y=><ellipse key={`${x}-${y}`} cx={x} cy={y} rx="85" ry="38" strokeWidth="3"/>))}</g>
   <g fill="currentColor"><ellipse cx="300" cy="180" rx="55" ry="73"/><rect x="273" y="235" width="54" height="37" rx="4" opacity=".65"/></g><path d="m280 170 20-25 20 25m-40 20h40" fill="none" stroke="var(--paper)" strokeWidth="5"/>
  </svg><div className={styles.ground}/></div>
  <label className={styles.angle}>{de?'Ansicht drehen':'Rotate concept view'}<input type="range" min="-45" max="45" value={angle} onChange={event=>setAngle(Number(event.target.value))}/></label>
  <figcaption>{de?'Illustratives Konzept. Keine zertifizierten Flugleistungen oder validierte Flugphysik.':'Illustrative concept. No certified performance or validated flight physics.'}</figcaption>
 </figure>;
}
