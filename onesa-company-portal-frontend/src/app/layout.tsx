import type {Metadata} from 'next';
import '@/styles/globals.css';
import {copy} from '@/config/copy';
import {socialImage} from '@/lib/metadata';
import {companyOrigin} from '@/lib/site-origin.mjs';
export const dynamic = "force-dynamic";
export const metadata:Metadata={metadataBase:new URL(companyOrigin()),title:{default:'Onesa UG — Intelligent software',template:'%s | Onesa UG'},description:copy.en.intro,icons:{icon:[{url:'/favicon.ico?v=20261010',type:'image/x-icon',sizes:'64x64'},{url:'/brand/onesa-orbit.png',type:'image/png'}],shortcut:'/favicon.ico?v=20261010'},openGraph:{type:'website',siteName:'Onesa UG',title:'Onesa UG — Intelligent software',description:copy.en.intro,images:[socialImage]},twitter:{card:'summary_large_image',title:'Onesa UG — Intelligent software',description:copy.en.intro,images:[socialImage]},robots:process.env.PUBLIC_RELEASE_ENABLED==='true'?{index:true,follow:true}:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return children;}
