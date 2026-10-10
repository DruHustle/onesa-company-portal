import type {Metadata} from 'next';
import '@/styles/globals.css';
import {copy} from '@/config/copy';
import {socialImage} from '@/lib/metadata';
export const dynamic = "force-dynamic";
export const metadata:Metadata={metadataBase:new URL(process.env.SITE_URL||'http://localhost:3300'),title:{default:'Onesa UG — Intelligent software',template:'%s | Onesa UG'},description:copy.en.intro,icons:{icon:{url:'/brand/onesa-orbit.png',type:'image/png'}},openGraph:{type:'website',siteName:'Onesa UG',title:'Onesa UG — Intelligent software',description:copy.en.intro,images:[socialImage]},twitter:{card:'summary_large_image',title:'Onesa UG — Intelligent software',description:copy.en.intro,images:[socialImage]},robots:process.env.PUBLIC_RELEASE_ENABLED==='true'?{index:true,follow:true}:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return children;}
