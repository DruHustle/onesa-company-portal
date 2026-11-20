'use client';
import {useEffect,useState} from 'react';
import {api} from '@/lib/api/client';
import type {operations} from '@/lib/api/generated/schema';
type Document=operations['uploadDocument']['responses'][201]['content']['application/json'];
/** Observe only the selected authorized file; this never exposes an unscoped picker. */
export function ApplicationCv({fileId,busy,onDownload}:{fileId:string;busy:boolean;onDownload:(filename:string)=>void}){
 const [observed,setObserved]=useState<Document|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{const controller=new AbortController();setError('');setObserved(null);void api.GET('/api/v1/admin/files/{id}',{params:{path:{id:fileId}},signal:controller.signal}).then(response=>{if(controller.signal.aborted)return;if(response.data?.id!==fileId)throw new Error('File identity could not be verified');setObserved(response.data);}).catch(()=>{if(!controller.signal.aborted)setError('CV security status could not be verified. Retry before downloading.');});return()=>controller.abort();},[fileId,attempt]);
 const current=observed?.id===fileId&&!error?observed:null,clean=current?.scan_status==='clean';
 return <section aria-label="CV security and download"><p role="status">{error||(!current?'Checking CV security status…':clean?'CV security scan: clean. Authorized download is available.':current.scan_status==='rejected'?'CV security scan: rejected. Download is unavailable.':'CV is awaiting a clean security scan. Download remains unavailable.')}</p>{error&&<button type="button" disabled={busy} onClick={()=>setAttempt(value=>value+1)}>Retry CV status</button>}<button type="button" disabled={busy||!clean} onClick={()=>{if(current&&clean)onDownload(current.filename);}}>Download private CV</button></section>;
}
