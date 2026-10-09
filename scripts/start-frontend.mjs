import {cp} from 'node:fs/promises';
import {spawn} from 'node:child_process';
await cp('.next/static','.next/standalone/.next/static',{recursive:true});await cp('public','.next/standalone/public',{recursive:true});const child=spawn(process.execPath,['.next/standalone/server.js'],{stdio:'inherit',env:{...process.env,NODE_ENV:'production',PORT:process.env.FRONTEND_PORT||'3300',HOSTNAME:'127.0.0.1'}});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code||0));
