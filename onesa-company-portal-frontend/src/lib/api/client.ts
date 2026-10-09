import createClient,{type Middleware} from 'openapi-fetch';
import type {paths} from './generated/schema';
let csrf:string|undefined;
export function setCsrf(value:string|undefined){csrf=value;}
export class ApiError extends Error{constructor(message:string,public status:number,public requestId?:string){super(message);}}
export function makeClient(baseUrl:string){const client=createClient<paths>({baseUrl,credentials:'same-origin',fetch:async(input)=>{const request=input as Request;const timeout=AbortSignal.timeout(12000);const signal=AbortSignal.any([request.signal,timeout]);return fetch(new Request(request,{signal,cache:'no-store'}));}});const middleware:Middleware={onRequest({request}){if(csrf&&!['GET','HEAD'].includes(request.method))request.headers.set('X-CSRF-Token',csrf);return request;},async onResponse({response}){if(!response.ok){const body=await response.clone().json().catch(()=>null);throw new ApiError(body?.error?.message||'Service unavailable. Please try again.',response.status,body?.error?.requestId||response.headers.get('x-request-id')||undefined);}return response;}};client.use(middleware);return client;}
export const api=makeClient('');
