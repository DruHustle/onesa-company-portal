// Loopback-only TLS SMTP fixture. It accepts one named synthetic recipient and
// stable job UUID, never customer mail. Acceptance is not inbox delivery.
import net from 'node:net';
import tls from 'node:tls';
import {createHash} from 'node:crypto';

export async function startSink({cert,key,recipient,jobId}){
 if(!/^[a-f0-9-]{36}@example\.invalid$/.test(recipient)||!/^[a-f0-9-]{36}$/.test(jobId))throw Error('SMTP_FIXTURE_SCOPE');
 const context=tls.createSecureContext({cert,key}),accepted=[],sockets=new Set();
 let commands=0;
 const attach=(socket,encrypted=false)=>{
  sockets.add(socket);socket.setTimeout(15000,()=>socket.destroy());
  let buffer='',data=false,body='',sender=false,target=false,hello=false;
  const write=value=>{if(!socket.destroyed)socket.write(value+'\r\n');};
  const close=()=>socket.destroy();
  socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  const receive=chunk=>{
   buffer+=chunk.toString('utf8');
   if(buffer.length>262144||++commands>200){close();return;}
   while(buffer.includes('\r\n')){
    const index=buffer.indexOf('\r\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+2);
    if(data){
     if(line==='.'){
      data=false;
      const ids=[...body.matchAll(/^Message-ID:\s*(.+)$/gim)].map(x=>x[1].trim());
      if(ids.length!==1||ids[0]!==`<${jobId}@onesa-portal.invalid>`||accepted.length){write('550 Fixture identity or duplicate refused');}
      else{accepted.push({job_id:jobId,body_sha256:createHash('sha256').update(body).digest('hex'),tls:true});write('250 2.0.0 Synthetic fixture accepted');}
      body='';sender=false;target=false;
     }else{
      body+=(line.startsWith('..')?line.slice(1):line)+'\r\n';
      if(body.length>131072){close();return;}
     }
     continue;
    }
    const verb=line.split(' ',1)[0].toUpperCase();
    if(verb==='EHLO'||verb==='HELO'){
     hello=true;socket.write(encrypted?'250-localhost\r\n250 SIZE 131072\r\n':'250-localhost\r\n250-STARTTLS\r\n250 SIZE 131072\r\n');
    }else if(verb==='STARTTLS'&&!encrypted&&hello){
     if(buffer){close();return;}
     socket.removeListener('data',receive);write('220 2.0.0 Ready for TLS');
     const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:context});
     secure.on('error',()=>{});attach(secure,true);return;
    }else if(verb==='QUIT'){write('221 Closing');socket.end();}
    else if(verb==='NOOP'){write('250 OK');}
    else if(verb==='RSET'){sender=false;target=false;body='';write('250 OK');}
    else if(!encrypted||!hello){write('530 TLS and EHLO required');}
    else if(verb==='MAIL'){
     sender=/^MAIL FROM:<[A-Za-z0-9_.+-]+@example\.invalid>(?: SIZE=\d+)?$/i.test(line);target=false;write(sender?'250 OK':'550 Synthetic sender required');
    }else if(verb==='RCPT'){
     target=sender&&line.toLowerCase()===`rcpt to:<${recipient}>`;write(target?'250 OK':'550 Synthetic recipient required');
    }else if(verb==='DATA'&&sender&&target){data=true;body='';write('354 End with dot');}
    else{write('550 Fixture command refused');}
   }
  };
  socket.on('data',receive);
  if(!encrypted)write('220 localhost Onesa isolated SMTP fixture');
 };
 const server=net.createServer(socket=>attach(socket));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {port:server.address().port,accepted,async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
