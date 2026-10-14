/** Complete public JSON reads share a deadline covering both headers and body. */
export async function publicFetch(request:Request):Promise<Response> {
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
        const response=await fetch(new Request(request, {
          signal:AbortSignal.any([request.signal,controller.signal]),cache:'no-store',
        }));
        const body=await response.arrayBuffer();
        return new Response([204,205,304].includes(response.status)?null:body,{status:response.status,statusText:response.statusText,headers:response.headers});
      })();
    return await Promise.race([content,expired]);
  } finally {
    clearTimeout(deadline);
  }
}
