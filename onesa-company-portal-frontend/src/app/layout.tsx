import type {Metadata} from 'next';
import '@/styles/globals.css';
export const metadata:Metadata={title:{default:'Onesa UG — Intelligent software',template:'%s | Onesa UG'},robots:process.env.PUBLIC_RELEASE_ENABLED==='true'?{index:true,follow:true}:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return children;}
