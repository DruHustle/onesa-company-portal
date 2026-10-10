const origin=process.env.SITE_URL||'http://localhost:3300';
if(process.env.PUBLIC_RELEASE_ENABLED==='true'&&!origin.startsWith('https://'))throw new Error('Public release requires an HTTPS SITE_URL');
export default {htmlLimitedBots: /.*/,output:'standalone',poweredByHeader:false,async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},{key:'X-Frame-Options',value:'DENY'},{key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'}]}]}};
