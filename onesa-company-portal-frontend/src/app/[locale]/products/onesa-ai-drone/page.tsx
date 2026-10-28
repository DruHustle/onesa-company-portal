import {notFound} from 'next/navigation';
import {DroneProduct} from '@/components/drone-product';
import {companyMetadata} from '@/lib/metadata';
import type {Locale} from '@/config/copy';
export async function generateMetadata({params}:{params:Promise<{locale:Locale}>}){const {locale}=await params;if(locale!=='en'&&locale!=='de')notFound();return companyMetadata({locale,path:'/products/onesa-ai-drone',title:'Onesa AI Drone',description:locale==='de'?'Intelligente Luftlogistik in Entwicklung. Ausschließlich Missionssimulation, Flottenintelligenz und Lieferkoordination.':'Intelligent Delivery Beyond Roads. Aerial logistics under development: mission simulation, fleet intelligence and delivery orchestration.'});}
export default async function Page({params}:{params:Promise<{locale:Locale}>}){const {locale}=await params;if(locale!=='en'&&locale!=='de')notFound();return <DroneProduct locale={locale}/>;}
