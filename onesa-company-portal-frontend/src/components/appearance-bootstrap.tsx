import {headers} from 'next/headers';
import {appearanceBoot} from '@/lib/appearance-boot';
export async function AppearanceBootstrap() {
 const nonce=(await headers()).get('x-nonce')||undefined;
 return <script nonce={nonce} dangerouslySetInnerHTML={{__html:appearanceBoot}}/>;
}
