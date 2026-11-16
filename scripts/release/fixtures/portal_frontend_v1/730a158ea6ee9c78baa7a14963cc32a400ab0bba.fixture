'use client';
import {useEffect, useRef, useState} from 'react';
import type {Locale} from '@/config/copy';
import catalog from '@/config/nvidia-reference-assets.json';
import type {ReferenceState, ReferenceViewer} from './nvidia-reference-viewer';
import styles from './nvidia-reference-library.module.css';
const germanNames = ['Förderband', 'Transportwagen', 'Lagerregal'];

export function NvidiaReferenceLibrary({locale}: {locale: Locale}) {
  const de = locale === 'de';
  const section = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ReferenceViewer | null>(null);
  const [visible, setVisible] = useState(false), [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0), [angle, setAngle] = useState(0);
  const [state, setState] = useState<ReferenceState>('loading');
  const asset = catalog.assets[index], name = de ? germanNames[index] : asset.name;
  useEffect(() => {
    if (!section.current) return;
    if (!('IntersectionObserver' in window)) {setVisible(true); return;}
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {setVisible(true); observer.disconnect();}
    }, {rootMargin: '160px'});
    observer.observe(section.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !host.current) return;
    const target = host.current;
    let cancelled = false;
    void import('./nvidia-reference-viewer').then(({createReferenceViewer}) => {
      if (!cancelled) viewer.current = createReferenceViewer({host: target, ...asset.glb, onState: value => {if (!cancelled) setState(value);}});
    }).catch(() => {if (!cancelled) setState('failed');});
    return () => {cancelled = true; viewer.current?.dispose(); viewer.current = null;};
  }, [asset, attempt, visible]);
  const reset = () => {setAngle(0); viewer.current?.rotate(0); viewer.current?.fit();};
  const message = state === 'ready'
    ? (de ? '3D-Ansicht bereit. Ziehen zum Drehen, Scrollen zum Zoomen.' : '3D view ready. Drag to orbit, scroll to zoom.')
    : state === 'loading'
      ? (de ? '3D-Modell wird automatisch geladen. Die Vorschau bleibt sichtbar.' : 'The 3D model loads automatically. Its preview stays visible while loading.')
      : state === 'unavailable'
        ? (de ? '3D ist in diesem Browser nicht verfügbar. Die Modellvorschau bleibt sichtbar.' : '3D is unavailable in this browser. The model preview remains available.')
        : (de ? 'Das 3D-Modell konnte nicht angezeigt werden. Die Vorschau bleibt verfügbar.' : 'The 3D model could not be displayed. Its preview remains available.');
  return <section ref={section} id="nvidia-environments" className={styles.library} aria-labelledby="nvidia-environments-title" data-state={state}>
    <div className={styles.heading}><p className="eyebrow">{de ? 'SIMULATIONSUMGEBUNGEN' : 'SIMULATION ENVIRONMENTS'}</p><h2 id="nvidia-environments-title">{de ? 'Eine Umgebung, die Sie erkunden können.' : 'An environment you can explore.'}</h2><p>{de ? 'NVIDIA-Referenzmodelle für digitale Zwillinge und die Planung von Robotik- und Drohnenszenarien. Wählen Sie ein Objekt und erkunden Sie seine Form.' : 'NVIDIA reference models for digital twins and for planning robot and drone scenarios. Select an object and explore its shape.'}</p></div>
    <div className={styles.layout}>
      <div className={styles.choices} role="group" aria-label={de ? 'Referenzmodell auswählen' : 'Choose a reference model'}>{catalog.assets.map((item, itemIndex) => <button type="button" key={item.id} aria-pressed={index === itemIndex} onClick={() => {if (index !== itemIndex) {setIndex(itemIndex); setAngle(0); setState('loading');}}}>
        <img src={`/models/nvidia/${item.thumbnail.path}`} width="640" height="480" alt="" loading="lazy" decoding="async"/>
        <span>{de ? germanNames[itemIndex] : item.name}<small>{(item.glb.byteLength / 1000000).toFixed(1)} MB · NVIDIA</small></span>
      </button>)}</div>
      <figure className={styles.figure}>
        <div className={styles.stage} role="img" aria-label={`${name} — ${de ? 'Modellansicht' : 'model view'}`}>
          <img className={state === 'ready' ? styles.hiddenPreview : styles.preview} src={`/models/nvidia/${asset.thumbnail.path}`} alt={de ? `Gerenderte Vorschau: ${name} von NVIDIA` : `Rendered preview of NVIDIA ${name.toLowerCase()}`} width="640" height="480" decoding="async"/>
          <div ref={host} className={`${styles.canvas} ${state === 'ready' ? styles.ready : ''}`}/>
          <span className={styles.badge}>{de ? 'VISUELLE REFERENZ' : 'VISUAL REFERENCE'}</span>
        </div>
        <div className={styles.feedback}><p role="status" aria-live="polite">{message}</p>{(state === 'failed' || state === 'unavailable') && <button type="button" onClick={() => {setState('loading'); setAngle(0); setAttempt(value => value + 1);}}>{de ? 'Erneut versuchen' : 'Retry 3D view'}</button>}</div>
        <div className={styles.controls}><label>{de ? 'Ansicht drehen' : 'Rotate model'}<input type="range" min="-180" max="180" value={angle} disabled={state !== 'ready'} onChange={event => {const value = Number(event.target.value); setAngle(value); viewer.current?.rotate(value);}}/></label><button type="button" disabled={state !== 'ready'} onClick={reset}>{de ? 'Ansicht zurücksetzen' : 'Fit view'}</button></div>
        <figcaption><a href={asset.sourceUrl} target="_blank" rel="noopener noreferrer">NVIDIA SimReady</a> · <a href={`/models/nvidia/${asset.licenseFile.path}`}>CC BY 4.0</a> · {de ? 'Von Onesa UG für die Browserdarstellung angepasst.' : 'Adapted for browser viewing by Onesa UG.'}<details><summary>{de ? 'Herkunft und Einsatzbereich' : 'Source and intended use'}</summary><p>{de ? 'Vereinfachte Geometrie und angepasste Materialien. Diese Ansicht validiert weder Physik noch Sensoren oder Hardwaresteuerung. NVIDIA wird als Urheber genannt; daraus folgt keine Unterstützung von Onesa.' : 'Simplified geometry and adapted materials. This view does not validate physics, sensors or hardware control. NVIDIA is credited as the source; no endorsement of Onesa is implied.'}</p><a href={`/models/nvidia/${asset.sourceFile.path}`}>{de ? 'Herkunftsnachweis ansehen' : 'View source record'}</a> · <a href="/licenses/three.txt">{de ? 'Renderer-Lizenz' : 'Renderer license'}</a></details></figcaption>
      </figure>
    </div>
  </section>;
}
