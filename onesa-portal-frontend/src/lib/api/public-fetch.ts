/** Complete public JSON reads share a deadline covering both headers and body. */
export async function publicFetch(request:Request):Promise<Response> {
  if(!['GET','HEAD'].includes(request.method))throw new Error('Public server fetch supports reads only');
  const controller=new AbortController();
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try {
    const expired=new Promise<never>((_,reject)=>{
        deadline=setTimeout(()=>{
          controller.abort();
          reject(new Error('Public content response deadline exceeded'));
        },1500);
      });
    const content=(async()=>{
        // Next's Request normalization drops init.signal before its memoizer.
        // URL + explicit options preserve cancellation and bypass that memoizer.
        // React's request-scoped caches still share the required head/body read.
        const response=await fetch(request.url, {
          method:request.method,headers:request.headers,credentials:request.credentials,
          redirect:request.redirect,mode:request.mode,referrer:request.referrer,
          referrerPolicy:request.referrerPolicy,integrity:request.integrity,
          signal:AbortSignal.any([request.signal,controller.signal]),cache:'no-store',
        });
        const body=await response.arrayBuffer();
        return new Response([204,205,304].includes(response.status)?null:body,{status:response.status,statusText:response.statusText,headers:response.headers});
      })();
    return await Promise.race([content,expired]);
  } finally {
    clearTimeout(deadline);
  }
}
