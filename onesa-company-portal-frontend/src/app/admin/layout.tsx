import type {Metadata} from 'next';
import {portalSocialImage as socialImage} from '@/lib/metadata';
export const metadata:Metadata={metadataBase:new URL(process.env.PORTAL_URL||process.env.SITE_URL||'http://localhost:3300'),title:'Administration | Onesa Company Portal',openGraph:{type:'website',title:'Administration | Onesa Company Portal',images:[socialImage]},twitter:{card:'summary_large_image',title:'Administration | Onesa Company Portal',images:[socialImage]},robots:{index:false,follow:false}};
export default function Layout({children}:{children:React.ReactNode}){return <html data-onesa-product="company" lang="en"><head><meta name="color-scheme" content="light dark"/></head><body>{children}</body></html>;}
