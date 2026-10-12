/** Configure both URLs to separate public pages and administration by hostname. */
export function stagingOrigin():string|null{
 if(process.env.VERCEL_ENV!=='preview'||process.env.VERCEL_GIT_COMMIT_REF!=='staging')return null;
 const host=process.env.VERCEL_URL;
 if(!host||!/^[a-z0-9][a-z0-9-]*\.vercel\.app$/.test(host))return null;
 return `https://${host}`;
}
export function surface(origin:string):'company'|'portal'|'combined'|'unknown'{
 if(origin===stagingOrigin())return 'combined';
 const company=process.env.SITE_URL,portal=process.env.PORTAL_URL;
 if(!portal)return 'combined';
 if(!company)throw new Error('PORTAL_URL requires SITE_URL');
 for(const value of [company,portal]){const url=new URL(value);if(url.origin!==value||(process.env.NODE_ENV==='production'&&url.protocol!=='https:'))throw new Error('Site URLs must be exact HTTPS origins in production');}
 if(company===portal||process.env.PUBLIC_ORIGIN!==portal)throw new Error('Portal and company origins must be distinct; PUBLIC_ORIGIN must match PORTAL_URL');
 if(origin===company)return 'company';
 if(origin===portal)return 'portal';
 return 'unknown';
}
export function routeDestination(origin:string,path:string):string|null{
 const current=surface(origin),admin=path==='/admin'||path.startsWith('/admin/');
 if(current==='portal'&&(path.startsWith('/brand/')||path.startsWith('/social/')))return null;
 if(current==='company'&&admin)return `${process.env.PORTAL_URL}${path}`;
 if(current==='portal'&&(path==='/'||admin))return path==='/'?`${process.env.PORTAL_URL}/admin`:null;
 if(current==='portal')return `${process.env.SITE_URL}${path}`;
 return null;
}
/** Match Host against configured authorities; never trust a supplied forwarded host. */
export function applicationOrigin(host:string|null,fallback:string):string|null{
 const staging=stagingOrigin();
 if(staging&&new URL(staging).host===host?.toLowerCase())return staging;
 const company=process.env.SITE_URL,portal=process.env.PORTAL_URL;
 if(!portal)return fallback;
 surface(portal); // Validate all configured boundaries before using either hostname.
 for(const origin of [company!,portal])if(new URL(origin).host===host?.toLowerCase())return origin;
 return null;
}
