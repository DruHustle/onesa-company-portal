/** Fail before constructing a client or writing when ordinary tests inherit cloud storage. */
export function assertTestStorageScope(config:{NODE_ENV:string;S3_BUCKET?:string;S3_ENDPOINT?:string},inherited:NodeJS.ProcessEnv={}){
 const credentials=['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_SHARED_CREDENTIALS_FILE'].some(key=>!!inherited[key]);
 if(config.NODE_ENV!=='test'||!config.S3_BUCKET&&!config.S3_ENDPOINT&&!credentials)return;
 let endpoint:URL;try{endpoint=new URL(config.S3_ENDPOINT??'');}catch{throw new Error('Test storage target refused: cloud storage requires separately qualified isolated acceptance.');}
 if(!['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||config.S3_BUCKET&&!/^[a-z0-9][a-z0-9.-]*-test$/.test(config.S3_BUCKET))throw new Error('Test storage target refused: use local files or an explicit loopback test bucket.');
}
