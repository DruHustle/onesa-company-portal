'use client';
import {Fragment} from 'react';

export function evidenceHref(value:string){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&![...u.searchParams.keys()].some(k=>/secret|token|password|api.?key|bypass|signature|credential|access.?key|authorization|(^|_)sig($|_)|(^|_)code($|_)/i.test(k))?u.href:null;}catch{return null;}
}
export function EvidenceLink({value}:{value:string}){const href=evidenceHref(value);return href?<a href={href} target="_blank" rel="noopener noreferrer">{value}</a>:<span>{value}</span>;}
function Inline({text}:{text:string}){
 const parts=text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^\s)]+\)|https:\/\/[^\s<>]+)/g);
 return <>{parts.map((s,i)=>{if(s.startsWith('**'))return <strong key={i}>{s.slice(2,-2)}</strong>;if(s.startsWith('`'))return <code key={i}>{s.slice(1,-1)}</code>;const link=s.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/);if(link){const href=evidenceHref(link[2]);return href?<a key={i} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a>:<span key={i}>{link[1]}</span>;}if(s.startsWith('https://'))return <EvidenceLink key={i} value={s}/>;return <Fragment key={i}>{s}</Fragment>;})}</>;
}
/** Bounded flowchart TD renderer. React escapes labels; no HTML/eval/remote renderer. */
export function WorkflowDiagram({code,title='Workflow'}:{code:string;title?:string}){
 const nodes=new Map<string,{label:string;decision:boolean}>(),edges:{from:string;to:string;label:string}[]=[];
 if(code.length<=20000&&/^\s*(flowchart|graph)\s+TD\b/.test(code)){
  for(const match of code.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[([^\]]+)\]|\{([^}]+)\})/g))nodes.set(match[1],{label:match[2]||match[3],decision:!!match[3]});
  for(const line of code.split('\n')){const match=line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)(?:\[[^\]]+\]|\{[^}]+\})?\s*-->\s*(?:\|([^|]+)\|\s*)?([A-Za-z][A-Za-z0-9_]*)/);if(match)edges.push({from:match[1],to:match[3],label:match[2]||''});}
 }
 if(!nodes.size||nodes.size>30||edges.length>50||edges.some(e=>!nodes.has(e.from)||!nodes.has(e.to)))return <pre className="governance-code"><code>{code}</code></pre>;
 const entries=[...nodes.entries()],position=new Map(entries.map(([id],i)=>[id,40+i*130])),height=entries.length*130+30;
 return <figure className="governance-workflow" tabIndex={0} aria-label={`${title}, scrollable diagram`}><figcaption>{title}</figcaption><svg viewBox={`0 0 640 ${height}`} role="img" aria-label={`${title}: ${entries.length} steps`}>
  <title>{title}</title><desc>{edges.map(e=>`${nodes.get(e.from)!.label} → ${e.label?e.label+': ':''}${nodes.get(e.to)!.label}`).join('. ')}</desc>
  {edges.map((e,i)=>{const from=position.get(e.from)!+80,to=position.get(e.to)!,direct=to-from===50,x=550+(i%4)*15;return <g key={i}><path d={direct?`M320 ${from} L320 ${to-8}`:`M510 ${from-40} L${x} ${from-40} L${x} ${to+40} L518 ${to+40}`} fill="none" stroke="var(--blue)" strokeWidth="2"/><path d={direct?`M314 ${to-10} L320 ${to} L326 ${to-10}`:`M520 ${to+34} L510 ${to+40} L520 ${to+46}`} fill="none" stroke="var(--blue)" strokeWidth="2"/>{e.label&&<text x={direct?333:x-6} y={direct?from+25:(from+to)/2} textAnchor={direct?'start':'end'} fill="var(--ink)" fontSize="13">{e.label}</text>}</g>;})}
  {entries.map(([id,node])=>{const y=position.get(id)!,words=node.label.split(/\s+/),lines:string[]=[];for(const word of words){if(!lines.length||(lines[lines.length-1]+' '+word).length>42)lines.push(word);else lines[lines.length-1]+=' '+word;}return <g key={id}><rect x="90" y={y} width="420" height="80" rx={node.decision?30:6} fill="var(--paper)" stroke="var(--line)" strokeWidth="2"/><text x="320" y={y+40-Math.min(lines.length-1,3)*8} textAnchor="middle" fill="var(--ink)" fontSize="15">{lines.slice(0,4).map((line,i)=><tspan key={i} x="320" dy={i?17:0}>{line}</tspan>)}</text></g>;})}
 </svg></figure>;
}
export function GovernanceDocument({markdown}:{markdown:string}){
 // Front matter is already represented in the protected metadata panel.
 const lines=markdown.replace(/^---\n[\s\S]*?\n---\n/,'').split('\n'),blocks:React.ReactNode[]=[];
 for(let n=0;n<lines.length;n++){
  const line=lines[n];if(!line.trim())continue;
  if(line.startsWith('```')){const language=line.slice(3).trim(),body:string[]=[];while(++n<lines.length&&!lines[n].startsWith('```'))body.push(lines[n]);blocks.push(language==='mermaid'?<WorkflowDiagram key={n} code={body.join('\n')}/>:<pre key={n} className="governance-code"><code>{body.join('\n')}</code></pre>);continue;}
  if(line.trim().startsWith('|')){const rows:string[][]=[];while(n<lines.length&&lines[n].trim().startsWith('|')){const cells=lines[n].trim().replace(/^\||\|$/g,'').split('|').map(s=>s.trim());if(!cells.every(s=>/^[-: ]+$/.test(s)))rows.push(cells);n++;}n--;blocks.push(<div key={n} className="table-wrap" tabIndex={0} aria-label="Document table"><table><thead><tr>{rows[0]?.map((cell,i)=><th scope="col" key={i}><Inline text={cell}/></th>)}</tr></thead><tbody>{rows.slice(1).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}><Inline text={cell}/></td>)}</tr>)}</tbody></table></div>);continue;}
  const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){const content=<Inline text={heading[2]}/>;blocks.push(heading[1].length<=2?<h3 key={n}>{content}</h3>:<h4 key={n}>{content}</h4>);continue;}
  if(/^(- |\d+\. )/.test(line)){const list:string[]=[];const ordered=/^\d+\. /.test(line);while(n<lines.length&&(ordered?/^\d+\. /:/^- /).test(lines[n])){list.push(lines[n].replace(/^(- |\d+\. )/,''));n++;}n--;blocks.push(ordered?<ol key={n}>{list.map((item,i)=><li key={i}><Inline text={item}/></li>)}</ol>:<ul key={n}>{list.map((item,i)=><li key={i}><Inline text={item}/></li>)}</ul>);continue;}
  blocks.push(<p key={n}><Inline text={line}/></p>);
 }
 return <article className="governance-prose">{blocks}</article>;
}
