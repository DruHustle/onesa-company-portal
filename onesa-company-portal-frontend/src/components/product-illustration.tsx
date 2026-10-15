/* Original Onesa capability visuals; no device or user data.
 * Concept artwork provenance and unchanged asset hashes: public/brand/sources.json. */
type Domain = 'apps'|'robotics'|'physical'|'vehicles';

function DomainIcon({domain,x,y}:{domain:Domain;x:number;y:number}){
 return <g transform={`translate(${x} ${y})`} fill="none" stroke="var(--engine-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {domain==='apps'&&<><rect x="3" y="4" width="54" height="40" rx="6"/><path d="M3 15h54M12 9h1m5 0h1m5 0h1M13 25h20m-20 8h13M40 30l6 6 12-13"/></>}
  {domain==='robotics'&&<><path d="M9 49h43M21 49V35l13-12 15 6M34 23l-8-12M49 29l5 9"/><circle cx="21" cy="35" r="5"/><circle cx="34" cy="23" r="5"/><circle cx="26" cy="11" r="4"/><path d="M5 9h7m-3-3v6M52 8h6m-3-3v6"/></>}
  {domain==='physical'&&<><path d="M21 7h18l7 10v16l-8 7H23l-9-7V17Z M23 40v10m15-10v10M14 23H4m42 0h11M7 45l6-6m38 6-6-6"/><path d="M23 23h1m12 0h1M25 31h10"/><circle cx="7" cy="23" r="3"/><circle cx="54" cy="23" r="3"/></>}
  {domain==='vehicles'&&<><path d="M5 43v-9l7-3 6-10h20l8 10 9 3v9M12 31h34M17 21l4 10m14-10 4 10"/><circle cx="16" cy="43" r="5"/><circle cx="44" cy="43" r="5"/><path d="M27 4h9m-5-4v10M17 7l9-3m10 0 9 3M16 4v6m30-6v6"/></>}
 </g>;
}

function DomainCard({domain,x,y,width,de,compact=false}:{domain:Domain;x:number;y:number;width:number;de:boolean;compact?:boolean}){
 const content={
  apps:{title:de?'Apps & Anwendungen':'Apps & experiences',lines:['Chat · Knowledge','Agents · Travel'],note:de?'APP-BEISPIELE':'APPLICATION EXAMPLES'},
  robotics:{title:de?'Robotik':'Robotics',lines:de?['Wahrnehmung','Interaktion + Bewegung']:['Perception','Interaction + motion'],note:de?'INTEGRATIONSVISION':'INTEGRATION VISION'},
  physical:{title:de?'Physische KI':'Physical AI',lines:de?['Verkörperte Intelligenz','Digital + physisch']:['Embodied intelligence','Digital + physical'],note:de?'INTEGRATIONSVISION':'INTEGRATION VISION'},
  vehicles:{title:de?'Autonome Systeme':'Autonomous systems',lines:de?['Boden- & Luftfahrzeuge','Umgebung + Navigation']:['Ground & aerial vehicles','Environment + navigation'],note:de?'INTEGRATIONSVISION':'INTEGRATION VISION'},
 }[domain];
 return <g transform={`translate(${x} ${y})`}>
  <rect width={width} height="144" rx="16" fill="var(--onesa-canvas)" stroke="var(--onesa-divider)" strokeWidth="2"/>
  <path d="M22 0h42" stroke="var(--engine-accent)" strokeWidth="3"/>
  <g transform="translate(22 16) scale(.6)"><DomainIcon domain={domain} x={0} y={0}/></g>
  <text x="70" y="40" fontSize={compact?26:22} fontWeight="600" fill="var(--onesa-text)">{content.title}</text>
  {content.lines.map((line,index)=><text key={line} x="22" y={80+index*26} fontSize={compact?22:20} fill="var(--onesa-muted)">{line}</text>)}
  <text x="22" y="130" fontSize="18" letterSpacing="1" fill="var(--engine-accent)">{content.note}</text>
 </g>;
}

function EngineCore({x,y,de}:{x:number;y:number;de:boolean}){
 return <g transform={`translate(${x} ${y})`}>
  <path d="M22 0h212l22 22v160l-22 22H22L0 182V22Z" fill="var(--engine-wash)" stroke="var(--engine-accent)" strokeWidth="2.5"/>
  <text x="128" y="28" textAnchor="middle" fontSize="18" letterSpacing="1" fontWeight="600" fill="var(--engine-accent)">{de?'INTELLIGENZ-EBENE':'INTELLIGENCE LAYER'}</text>
  <g transform="translate(78 44)" fill="none" stroke="var(--engine-accent)" strokeWidth="2.2" aria-hidden="true">
   <path d="M14 15 50 5 86 15 74 45 50 59 26 45Z M14 15l36 20 36-20M50 5v30l24 10M26 45l24-10v24"/>
   {[[14,15],[50,5],[86,15],[26,45],[50,35],[74,45],[50,59]].map(([cx,cy],index)=><circle key={index} cx={cx} cy={cy} r={index===4?6:4} fill="var(--onesa-canvas)"/>)}
  </g>
  <text x="128" y="142" textAnchor="middle" fontSize="32" fontWeight="700" letterSpacing="-1" fill="var(--onesa-text)">AI ENGINE</text>
  <text x="128" y="171" textAnchor="middle" fontSize="18" fill="var(--onesa-muted)">{de?'Wahrnehmen · denken':'Perceive · reason'}</text>
  <text x="128" y="191" textAnchor="middle" fontSize="18" fill="var(--engine-accent)">{de?'Erzeugen · Wissen · Tools':'Generate · knowledge · tools'}</text>
 </g>;
}

function ResearchDirection({x,y,width,de}:{x:number;y:number;width:number;de:boolean}){
 return <g transform={`translate(${x} ${y})`}>
  <rect width={width} height="66" rx="12" fill="var(--onesa-canvas)" stroke="var(--engine-accent)" strokeWidth="2" strokeDasharray="5 5"/>
  <text x={width/2} y="28" textAnchor="middle" fontSize="23" fontWeight="600" fill="var(--onesa-text)">{de?'AGI · FORSCHUNG':'AGI · RESEARCH'}</text>
  <text x={width/2} y="51" textAnchor="middle" fontSize="19" fill="var(--onesa-muted)">{de?'Langfristige Forschungsrichtung':'Long-term research direction'}</text>
 </g>;
}

function AIEngineIllustration({locale}:{locale:string}){
 const de=locale==='de';
 const label=de?'Onesa AI Engine: Anwendungen, Robotik, autonome Boden- und Luftfahrzeuge sowie physische KI als Integrationsvision; AGI als langfristige Forschungsrichtung.':'Onesa AI Engine: applications, robotics, autonomous ground and aerial vehicles, and physical AI as an integration vision; AGI as a long-term research direction.';
 const heading=de?'Eine Engine. Neue Möglichkeiten.':'One engine. New possibilities.';
 const caption=de?'Die Vision einer KI-Engine für Apps, Robotik, autonome Boden- und Luftfahrzeuge sowie physische KI. AGI ist eine Forschungsrichtung.':'An AI engine vision connecting apps, robotics, autonomous ground and aerial systems, and physical AI. AGI is a research direction.';
 return <figure className="product-illustration ai-engine-illustration">
  <svg className="ai-engine-wide" viewBox="0 0 900 760" role="img" aria-label={label} width="900" height="760" fontFamily="var(--onesa-font-body)">
   <rect x="1" y="1" width="898" height="758" rx="24" fill="var(--onesa-surface)" stroke="var(--onesa-divider)"/>
   <text x="40" y="42" fontSize="18" letterSpacing="1.6" fill="var(--engine-accent)">ONESA AI PLATFORM</text>
   <text x="40" y="82" fontSize="32" fontWeight="600" letterSpacing="-1" fill="var(--onesa-text)">{heading}</text>
   <g fill="none" stroke="var(--engine-accent)" strokeWidth="1.4" opacity=".2" aria-hidden="true"><ellipse cx="450" cy="367" rx="307" ry="194"/><ellipse cx="450" cy="367" rx="247" ry="247" transform="rotate(-27 450 367)"/></g>
   <g fill="none" stroke="var(--engine-accent)" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M540 244c-44 0-28 78-90 78"/>
    <path d="M290 224c30 0 6 98 32 98M290 560c44 0 5-116 32-116M540 560c-39 0-8-116-90-116M450 470v204" strokeDasharray="5 7"/>
   </g>
   <DomainCard domain="apps" x={540} y={126} width={320} de={de}/>
   <DomainCard domain="robotics" x={40} y={126} width={250} de={de}/>
   <DomainCard domain="physical" x={40} y={500} width={250} de={de}/>
   <DomainCard domain="vehicles" x={540} y={500} width={320} de={de}/>
   <EngineCore x={322} y={268} de={de}/>
   <ResearchDirection x={276} y={674} width={348} de={de}/>
  </svg>
  <svg className="ai-engine-compact" viewBox="0 0 480 1210" role="img" aria-label={label} width="480" height="1210" fontFamily="var(--onesa-font-body)">
   <rect x="1" y="1" width="478" height="1208" rx="22" fill="var(--onesa-surface)" stroke="var(--onesa-divider)"/>
   <text x="24" y="38" fontSize="18" letterSpacing="1.4" fill="var(--engine-accent)">ONESA AI PLATFORM</text>
   <text x="24" y="78" fontSize="30" fontWeight="600" letterSpacing="-1" fill="var(--onesa-text)">{heading}</text>
   <path d="M240 254v74" fill="none" stroke="var(--engine-accent)" strokeWidth="2.5" aria-hidden="true"/>
   <g fill="none" stroke="var(--engine-accent)" strokeWidth="2.5" strokeDasharray="5 7" aria-hidden="true"><path d="M112 430H12v590h12M12 660h12M12 840h12M240 532v566"/></g>
   <DomainCard domain="apps" x={24} y={112} width={432} de={de} compact/>
   <EngineCore x={112} y={328} de={de}/>
   <DomainCard domain="robotics" x={24} y={580} width={432} de={de} compact/>
   <DomainCard domain="physical" x={24} y={760} width={432} de={de} compact/>
   <DomainCard domain="vehicles" x={24} y={940} width={432} de={de} compact/>
   <ResearchDirection x={58} y={1122} width={364} de={de}/>
  </svg>
  <figcaption>{caption}</figcaption>
 </figure>;
}

function RobotConceptIllustration({locale}:{locale:string}) {
 const de=locale==='de';
 return <figure className="product-illustration robot-concept-illustration">
  <div className="robot-concept-art">
   <picture>
    <source media="(max-width: 640px)" srcSet="/images/robot-concept-640.webp"/>
    <img src="/images/robot-concept-1280.webp" width="1280" height="853" loading="lazy" decoding="async"
     alt={de?'Konzeptillustration eines futuristischen humanoiden Roboters mit einer leuchtenden Kugel in einer offenen Stadtlandschaft.':'Concept artwork of a futuristic humanoid robot holding a luminous sphere in an open city landscape.'}/>
   </picture>
   <span className="robot-concept-status">{de?'In Entwicklung':'Under development'}</span>
   <div className="robot-concept-message"><p>ONESA AI ROBOT</p><strong>{de?'Intelligenz trifft Interaktion.':'Intelligence meets interaction.'}</strong></div>
  </div>
  <figcaption><span>{de?'Robotik · Physische KI · Mensch-Maschine-Interaktion':'Robotics · Physical AI · Human–machine interaction'}</span><p>{de?'Eine Vision für intelligente Maschinen. Konzeptillustration.':'A vision for intelligent machines. Concept artwork.'}</p></figcaption>
 </figure>;
}

export function ProductIllustration({product,locale}:{product:'ai'|'robot';locale:string}){
 return product==='ai'?<AIEngineIllustration locale={locale}/>:<RobotConceptIllustration locale={locale}/>;
}
