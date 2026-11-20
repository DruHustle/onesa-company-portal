/** Import only into the independently verified Portal targets or an isolated local test DB. */
export function governanceTarget(raw:string,expectedHost:string,expectedDatabase:string){
 let url:URL;
 try{url=new URL(raw);}catch{throw new Error('Privacy import database identity mismatch');}
 const local=['127.0.0.1','localhost'].includes(url.hostname);
 const hosts=['ep-dark-boat-b91lg22g','ep-morning-shadow-b9jkzgsz'].flatMap(endpoint=>[endpoint+'.c-7.eu-central-1.aws.neon.tech',endpoint+'-pooler.c-7.eu-central-1.aws.neon.tech']);
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==expectedHost||decodeURIComponent(url.pathname.slice(1))!==expectedDatabase||url.hash||!url.username||!url.password)throw new Error('Privacy import database identity mismatch');
 if(local){if(!/^onesa_portal[a-z0-9_]*_test$/.test(expectedDatabase))throw new Error('Privacy import requires an isolated local test target');}
 else if(!hosts.includes(url.hostname)||expectedDatabase!=='neondb'||url.port&&!['5432'].includes(url.port)||url.searchParams.getAll('sslmode').length!==1||url.searchParams.get('sslmode')!=='verify-full'||url.searchParams.getAll('channel_binding').length!==1||url.searchParams.get('channel_binding')!=='require'||url.username!=='onesa_portal_app')throw new Error('Privacy import requires the verified restricted Portal target and TLS');
 return url;
}
