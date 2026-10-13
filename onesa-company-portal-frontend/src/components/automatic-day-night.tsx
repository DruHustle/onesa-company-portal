import {headers} from 'next/headers';
import {dayNightBoot} from '@/lib/day-night-boot';
export async function AutomaticDayNight(){const nonce=(await headers()).get('x-nonce')||undefined;return <script nonce={nonce} dangerouslySetInnerHTML={{__html:dayNightBoot}}/>;}
