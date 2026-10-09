import 'server-only';
import {makeClient} from './client';
export const serverApi=()=>makeClient(process.env.BACKEND_URL||'http://127.0.0.1:8300');
