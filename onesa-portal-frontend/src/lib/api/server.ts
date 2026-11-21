import '../server/tls-trust';
import 'server-only';
import {makeClient} from './client';
import {publicFetch} from './public-fetch';
export const serverApi=()=>makeClient(process.env.BACKEND_URL||'http://127.0.0.1:8300');

/** Bound the complete public response, without changing private/upload deadlines. */
export function publicServerApi() {
  return makeClient(process.env.BACKEND_URL||'http://127.0.0.1:8300',publicFetch);
}

/** Optional SEO must not hold the shell; the same bounded read still serves its body. */
export async function optionalMetadata<T>(content: Promise<T>): Promise<T | null> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      content,
      new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 250); }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
