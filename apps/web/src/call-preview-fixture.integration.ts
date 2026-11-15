// Served only by the mounted integration fixture; never imported by the application.
export const previewFixture = `
import { createElement as h, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CallProvider, useCall } from '/src/CallProvider.tsx';
import { VerifiedVoiceSessions } from '/src/voice-session.ts';
import { VoiceController } from '/src/voice-controller.ts';
import { WebScreenCapture } from '/src/screen-capture.ts';
import { ScreenPreviewOwner } from '/src/screen-preview.ts';
const injected=true, factoryFailure=false;
const deferred=()=>{let resolve,reject;const promise=new Promise((r,e)=>{resolve=r;reject=e});return {promise,resolve,reject}};
const f=window.fixture={active:0,created:0,captures:[],enumerations:[],joins:[],logouts:[],errors:[],previews:[],previewErrors:[],calls:[],now:1000};
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
const listeners=new Set(),devices=navigator.mediaDevices;
devices.addEventListener=(name,listener)=>{if(name==='devicechange'){listeners.add(listener);f.active=listeners.size;f.created++}};
devices.removeEventListener=(name,listener)=>{listeners.delete(listener);f.active=listeners.size};
devices.getUserMedia=()=>{throw new Error('Physical microphone forbidden')};
devices.getDisplayMedia=()=>{throw new Error('Physical display forbidden')};
devices.enumerateDevices=()=>{throw new Error('Physical enumeration forbidden')};
f.finishCapture=()=>{};
f.respond=(d,value)=>d.resolve(value);
f.observe=(promise,key)=>{void promise.then(()=>f[key]='resolved',e=>f[key]=e.message)};
const request=async(path,method,body)=>{f.calls.push({path,method,body});if(path==='/voice/join'){const d=deferred();f.joins.push(d);return d.promise}return {ok:true}};
const sessions=new VerifiedVoiceSessions();
const state=(csrf)=>({user:{id:'account',username:'fixture',displayName:'Fixture',status:'approved',isOwner:false},csrfToken:csrf,expiresAt:new Date(Date.now()+600000).toISOString(),remember:false});
let session=sessions.acceptVerified(state('a'),request);
const dependency={onError:error=>f.previewErrors.push(error.message),create:own=>{
 const raw=deferred(),prepare=deferred(),handle={epoch:{},deadline:f.now+1000,dispose(){this.disposed=true}},invalidations=new Set();
 const track=new EventTarget();Object.assign(track,{kind:'video',enabled:true,readyState:'live',stop(){this.readyState='ended'},getSettings(){return {displaySurface:'browser'}}});
 const stream=new EventTarget();Object.assign(stream,{getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]});
 const item={raw,prepare,handle,track,stream,starts:0,invalidations,cleaned:0};f.previews.push(item);
 const capture=new WebScreenCapture({getDisplayMedia:()=>{item.starts++;return raw.promise}});
 own(()=>{capture.dispose();item.cleaned++});
 const owner=item.owner=new ScreenPreviewOwner({capture,authorization:{prepare:()=>prepare.promise,inspect:()=>handle,onInvalidated:listener=>{invalidations.add(listener);return ()=>invalidations.delete(listener)}},now:()=>f.now,onError:error=>f.previewErrors.push(error.message)});
 own(()=>owner.dispose());
 if(factoryFailure)throw new Error('Synthetic optional factory failure');
 return owner;
}};
const originalLeave=VoiceController.prototype.leave;
const originalSubscribe=VoiceController.prototype.onLeaseInvalidated;
f.leaseListeners=new Set();
VoiceController.prototype.onLeaseInvalidated=function(listener){f.leaseListeners.add(listener);const unsubscribe=originalSubscribe.call(this,listener);return ()=>{f.leaseListeners.delete(listener);unsubscribe()}};
VoiceController.prototype.leave=function(){f.controller=this;return originalLeave.call(this)};
const originalJoin=VoiceController.prototype.join;
VoiceController.prototype.join=function(id){f.controller=this;return originalJoin.call(this,id)};
const originalDispose=VoiceController.prototype.dispose;
VoiceController.prototype.dispose=function(){originalDispose.call(this);if(f.failVoiceDispose)throw new Error('Synthetic voice cleanup failure')};
function View(){const call=useCall(),[shown,setShown]=useState(true);f.call=call;f.toggle=()=>setShown(v=>!v);return shown?h('p',null,'Audio view'):null}
function Root(){const [owned,setOwned]=useState(session),[revision,setRevision]=useState(0);f.replace=()=>{session=sessions.acceptVerified(state('b'),request);setOwned(session)};f.logout=()=>{sessions.invalidate();setOwned(null)};f.refresh=()=>{session=sessions.acceptVerified(state('a'),request);setOwned(session)};f.rerender=()=>setRevision(v=>v+1);return h(CallProvider,{session:owned,preview:injected?{...dependency,revision}:undefined},h(View))}
f.ready=async(item=f.previews.at(-1))=>{const result=item.owner.prepare({sound:'none'});item.prepare.resolve(item.handle);await result};
f.play=async(item=f.previews.at(-1))=>{await f.ready(item);const result=item.owner.start();item.raw.resolve(item.stream);await result};
f.join=async()=>{await f.call.controls.selectInput('synthetic-mic');await f.call.controls.selectOutput('synthetic-output');f.observe(f.call.controls.join('room'),'joinResult')};
f.drainPreview=()=>{sessions.invalidate();for(const item of f.previews){item.prepare.resolve(item.handle);item.raw.resolve(item.stream);item.owner.dispose();item.handle.dispose();item.track.stop()}};
f.root=createRoot(document.getElementById('root'));f.root.render(h(StrictMode,null,h(Root)));
`;
