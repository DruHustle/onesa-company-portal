import type {Metadata} from 'next';
import {portalSocialImage as socialImage} from '@/lib/metadata';
export const metadata:Metadata={metadataBase:new URL(process.env.PORTAL_URL||process.env.SITE_URL||'http://localhost:3300'),title:'Onesa Portal',openGraph:{type:'website',title:'Onesa Portal',images:[socialImage]},twitter:{card:'summary_large_image',title:'Onesa Portal',images:[socialImage]},robots:{index:false,follow:false}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
