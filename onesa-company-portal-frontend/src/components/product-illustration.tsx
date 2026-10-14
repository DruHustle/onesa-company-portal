/* Original Onesa capability illustration. Synthetic diagram; no device or user data.
 * Rights: maintained with this source by Onesa UG; not a screenshot or hardware claim. */
export function ProductIllustration({product,locale}:{product:'ai'|'robot';locale:string}){
 const robot=product==='robot',de=locale==='de';
 const title=robot?'Onesa AI Robot':'Onesa AI Platform';
 const labels=robot?['Operator',de?'Cloud-Simulation':'Cloud simulation',de?'Simulierter Zustand':'Simulated state']:['Chat','Knowledge',de?'Antwort mit Quellen':'Answer with sources'];
 return <figure className="product-illustration"><svg viewBox="0 0 900 390" role="img" aria-label={`${title}: ${labels.join(' → ')}`} width="900" height="390">
 <rect x="1" y="1" width="898" height="388" rx="12" fill="var(--onesa-surface)" stroke="var(--onesa-border)"/>
 <text x="45" y="70" fill="var(--onesa-text)" fontSize="30" fontFamily="Arial,Helvetica,sans-serif">{title}</text>
 {labels.map((label,i)=><g key={label}><rect x={45+i*285} y="125" width="245" height="115" rx="8" fill="var(--onesa-canvas)" stroke="var(--onesa-border)"/><text x={167+i*285} y="190" textAnchor="middle" fill="var(--onesa-text)" fontSize="20" fontFamily="Arial,Helvetica,sans-serif">{label}</text>{i<2&&<path d={`M${300+i*285} 182h18m-8-8 8 8-8 8`} fill="none" stroke="var(--onesa-accent)" strokeWidth="3"/>}</g>)}
 <text x="45" y="315" fill="var(--onesa-muted)" fontSize="18" fontFamily="Arial,Helvetica,sans-serif">{robot?(de?'SIMULATION · Keine physische Bewegung':'SIMULATION · No physical actuation'):'CHAT · KNOWLEDGE · AGENTS · TRAVEL'}</text>
 </svg><figcaption>{de?'Schematische Darstellung: ':'Capability illustration: '}{labels.join(' → ')}. {de?'Keine Live-Daten.':'No live data.'}</figcaption></figure>;
}
