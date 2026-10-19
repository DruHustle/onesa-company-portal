import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protectDraftHistory} from '../src/features/admin/draft-history.ts';
function fixture(){
 const surface=new EventTarget() as EventTarget&{history:unknown;location:{href:string}};
 surface.location={href:'https://portal.example.test/admin#privacy/documents'};
 const methods={state:{} as Record<string,unknown>,
  pushState(state:Record<string,unknown>,_unused:string,url:string){this.state=state;surface.location.href=new URL(url,surface.location.href).href;},
  replaceState(state:Record<string,unknown>,_unused:string,url:string){this.state=state;surface.location.href=new URL(url,surface.location.href).href;},
  go(delta:number){assert.equal(delta,1);this.state={__onesaDraftPosition:1};surface.location.href='https://portal.example.test/admin#privacy/documents/record';pop(this.state);}
 };
 surface.history=methods;
 const original=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:surface});
 const pop=(state:Record<string,unknown>)=>{const event=new Event('popstate');Object.defineProperty(event,'state',{value:state});surface.dispatchEvent(event);};
 const hash=(oldURL:string,newURL:string)=>{const event=new Event('hashchange');Object.defineProperties(event,{oldURL:{value:oldURL},newURL:{value:newURL}});surface.dispatchEvent(event);};
 return {surface,methods,pop,hash,restore(){if(original)Object.defineProperty(globalThis,'window',original);else Reflect.deleteProperty(globalThis,'window');}};
}
test('restoration popstate arriving before the original hashchange cannot unmount a protected editor',()=>{
 const f=fixture();let changes=0;
 const cleanup=protectDraftHistory(()=>false);
 try{
  f.methods.pushState({},'', 'https://portal.example.test/admin#privacy/documents/record');
  f.surface.addEventListener('hashchange',()=>{changes++;});
  const from=f.surface.location.href,to='https://portal.example.test/admin#privacy/documents';
  f.surface.location.href=to;f.pop({__onesaDraftPosition:0});
  f.hash(from,to);f.hash(to,from);
  assert.equal(changes,0,'Neither the blocked hash event nor its restoration may reach the editor');
  assert.equal(f.surface.location.href,from);
 }finally{cleanup();f.restore();}
});

test('hashchange dispatched inside a confirmation cannot discard work before the decision returns',()=>{
 const f=fixture();let changes=0;
 const from='https://portal.example.test/admin#privacy/documents/record',to='https://portal.example.test/admin#privacy/documents';
 const cleanup=protectDraftHistory(()=>{f.hash(from,to);return false;});
 try{
  f.methods.pushState({},'',from);f.surface.addEventListener('hashchange',()=>{changes++;});
  f.surface.location.href=to;f.pop({__onesaDraftPosition:0});f.hash(to,from);
  assert.equal(changes,0);assert.equal(f.surface.location.href,from);
 }finally{cleanup();f.restore();}
});
test('confirmed navigation replays one deferred hash event and remains usable afterwards',()=>{
 const f=fixture();let changes=0;
 const from='https://portal.example.test/admin#privacy/documents/record',to='https://portal.example.test/admin#privacy/documents';
 const originalHash=Object.getOwnPropertyDescriptor(globalThis,'HashChangeEvent');
 Object.defineProperty(globalThis,'HashChangeEvent',{configurable:true,value:class extends Event{oldURL:string;newURL:string;constructor(type:string,data:{oldURL:string;newURL:string}){super(type);this.oldURL=data.oldURL;this.newURL=data.newURL;}}});
 const cleanup=protectDraftHistory(()=>{f.hash(from,to);return true;});
 try{
  f.methods.pushState({},'',from);f.surface.addEventListener('hashchange',()=>{changes++;});
  f.surface.location.href=to;f.pop({__onesaDraftPosition:0});
  assert.equal(changes,1);assert.equal(f.surface.location.href,to);
  f.methods.pushState({},'',from);f.hash(to,from);assert.equal(changes,2);
 }finally{cleanup();f.restore();if(originalHash)Object.defineProperty(globalThis,'HashChangeEvent',originalHash);else Reflect.deleteProperty(globalThis,'HashChangeEvent');}
});
