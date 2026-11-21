import {notFound,permanentRedirect} from 'next/navigation';
import type {Locale} from '@/config/copy';
export default async function LegacyDrone({params}:{params:Promise<{locale:Locale}>}){const {locale}=await params;if(locale!=='en'&&locale!=='de')notFound();permanentRedirect(`/${locale}/products/onesa-drone`);}
