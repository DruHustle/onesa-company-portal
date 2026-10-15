/** Sanitize inherited operator configuration before any runtime module is imported. */
export function isolateLocalTestEnvironment(environment:NodeJS.ProcessEnv){
 const database=environment.TEST_DATABASE_URL;
 if(database){
  let parsed:URL;try{parsed=new URL(database);}catch{throw new Error('Local fixtures require a valid isolated loopback test database');}
  if(!['postgres:','postgresql:'].includes(parsed.protocol)||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test'))throw new Error('Local fixtures reject hosted or non-test database bindings');
 }
 for(const key of Object.keys(environment))if(/^(?:S3_|AWS_|CLAMAV_|SMTP_|RESEND_|MAIL_)/.test(key)||['NOTIFY_EMAIL','METRICS_TOKEN','PROXY_SHARED_KEY','RENDER','PUBLICATION_STAGE'].includes(key))delete environment[key];
 environment.NODE_ENV='test';environment.MAIL_PROVIDER='smtp';environment.AWS_EC2_METADATA_DISABLED='true';
 if(database)environment.DATABASE_URL=database;
}
isolateLocalTestEnvironment(process.env);
