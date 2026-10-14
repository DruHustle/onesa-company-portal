/* Text-only Markdown subset: CMS text is never executed or inserted as HTML. */
export function ContentProse({body}:{body:string}) {
  return <div className="prose">{body.split(/\n\s*\n/).map((block,index)=>{
    if(block.startsWith('### '))return <h3 key={index}>{block.slice(4)}</h3>;
    if(block.startsWith('## '))return <h2 key={index}>{block.slice(3)}</h2>;
    if(block.startsWith('```'))return <pre key={index}><code>{block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')}</code></pre>;
    const lines=block.split('\n');
    if(lines.every(line=>/^[-*] /.test(line)))return <ul key={index}>{lines.map((line,i)=><li key={i}>{line.slice(2)}</li>)}</ul>;
    return <p key={index}>{block}</p>;
  })}</div>;
}
