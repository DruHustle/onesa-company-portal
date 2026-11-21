"use client";
import {useEffect,useState} from 'react';
import {publicDocument} from '@/lib/api/transfers';
export function PublicDocumentImage({id,alt}:{id:string;alt:string}){
 const [url,setUrl]=useState<string|null>(null);const [failed,setFailed]=useState(false);
 useEffect(()=>{const controller=new AbortController();let objectUrl:string|undefined;
 setUrl(null);setFailed(false);
 void publicDocument(id,controller.signal).then(blob=>{if(controller.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
 return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[id]);
 return <div className="article-media">{failed?<p role="status">Image temporarily unavailable.</p>:url?<img src={url} alt={alt} className="article-image"/>:<span role="status" aria-label="Loading image"/>}</div>;
}
