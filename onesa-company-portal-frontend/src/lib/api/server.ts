import 'server-only';
import {makeClient} from './client';
export const serverApi=()=>makeClient(process.env.BACKEND_URL||'http://127.0.0.1:8300');

/** Bound public rendering reads without changing administration or upload deadlines. */
export function publicServerApi() {
  const client = serverApi();
  client.use({onRequest({request}) {
    return new Request(request, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(1500)]),
    });
  }});
  return client;
}
