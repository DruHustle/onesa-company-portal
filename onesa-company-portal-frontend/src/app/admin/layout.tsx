import type {Metadata} from 'next';
export const metadata:Metadata={title:'Onesa administration',robots:{index:false,follow:false}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
