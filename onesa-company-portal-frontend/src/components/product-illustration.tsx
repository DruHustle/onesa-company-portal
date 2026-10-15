/* Original generated Onesa concept visuals; no operator, device or user data.
 * Source provenance and responsive asset hashes: public/brand/sources.json. */
function AIEngineIllustration({locale}:{locale:string}){
 const de=locale==='de';
 return <figure className="product-illustration ai-engine-illustration">
  <div className="ai-engine-art">
   <picture>
    <source media="(max-width: 640px)" srcSet="/images/ai-platform-concept-640.webp"/>
    <img src="/images/ai-platform-concept-1280.webp" width="1280" height="853" loading="lazy" decoding="async"
     alt={de?'Eine Roboterhand interagiert mit einer blauen KI-Oberfläche.':'A robotic hand interacting with a blue AI interface.'}/>
   </picture>
  </div>
  <figcaption>{de?'Intelligenz für das, was kommt.':'Intelligence for what’s next.'}</figcaption>
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
   <div className="robot-concept-message"><p>ONESA AI ROBOT</p><strong>{de?'Intelligenz trifft Interaktion.':'Intelligence meets interaction.'}</strong></div>
  </div>
  <figcaption><span>{de?'Robotik · Physische KI · Mensch-Maschine-Interaktion':'Robotics · Physical AI · Human–machine interaction'}</span><p>{de?'Eine Vision für intelligente Maschinen. Konzeptillustration.':'A vision for intelligent machines. Concept artwork.'}</p></figcaption>
 </figure>;
}

export function ProductIllustration({product,locale}:{product:'ai'|'robot';locale:string}){
 return product==='ai'?<AIEngineIllustration locale={locale}/>:<RobotConceptIllustration locale={locale}/>;
}
