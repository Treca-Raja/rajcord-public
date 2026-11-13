import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { launch } from '../../api/src/voice/browser-harness';
import { previewFixture } from './call-preview-fixture.integration';

const runtimeFixture = previewFixture
  .replace(
    'const injected=true, factoryFailure=false;',
    `
import { ScreenRuntime } from '/src/screen-runtime.ts';
import { ScreenBindingOwner } from '/src/screen-binding.ts';
const injected=false, factoryFailure=false, optionalScreenFailure=false;`,
  )
  .replace(
    'const originalLeave=VoiceController.prototype.leave;',
    `
f.screenWork=[];f.attachments=[];f.screenErrors=[];
const runtime=new ScreenRuntime({onError:error=>f.screenErrors.push(error.message),binding:{
 onError:error=>f.screenErrors.push(error.message),
 create(own){const raw=deferred(),retired=deferred();const retire=()=>retired.promise;own(retire);f.screenWork.push({raw,retired});return {bind:()=>raw.promise,retire}}
}});
const attach=runtime.attach.bind(runtime);
runtime.attach=(session)=>{
 if(optionalScreenFailure)throw Error('Synthetic screen attachment failure');
 const attachment=attach(session),owner=new ScreenBindingOwner(attachment.bindingDependency);let active=true;
 const wrapped={...attachment,connectVoice(voice){attachment.connectVoice({
  // Only the lease delegate is synthetic; AuthRoot/session/provider/runtime are mounted code.
  bindScreens:({signal}={})=>owner.bind({id:'954fc1bb-e5be-4a85-bd86-004cc5553b29',channelId:'90d27181-8af8-4ea4-b3a9-e32805758484'},()=>active&&session.current,signal),
  onLeaseInvalidated:voice.onLeaseInvalidated.bind(voice)
 })},release(){active=false;attachment.release();owner.dispose()}};
 f.attachments.push(wrapped);return wrapped;
};
f.runtime=runtime;f.screenReply={epoch:'94650863-245d-43c4-a927-40384325eb1e',channelId:'90d27181-8af8-4ea4-b3a9-e32805758484',remainingMs:45000};
f.drainScreens=()=>{runtime.dispose();for(const work of f.screenWork){work.raw.resolve(f.screenReply);work.retired.resolve()}};
const originalLeave=VoiceController.prototype.leave;`,
  )
  .replace('session:owned,preview:', 'session:owned,screens:runtime,preview:');

it('retains one document runtime across StrictMode/provider/session replacement and unresolved binding retirement', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait(
        '!!window.fixture?.call && fixture.active===1 && fixture.attachments.length>=2',
      );
      expect(await browser.js('fixture.runtime.inspect().disposed')).toBe(false);
      await browser.js(
        "fixture.oldAttachment=fixture.attachments.at(-1);fixture.observe(fixture.oldAttachment.bind(),'oldScreen')",
      );
      await browser.wait('fixture.screenWork.length===1');
      await browser.js('fixture.replace()');
      await browser.wait("fixture.oldScreen==='Screen attachment stopped.' && fixture.active===1");
      await browser.js("fixture.observe(fixture.attachments.at(-1).bind(),'blockedScreen')");
      await browser.wait(
        "fixture.blockedScreen==='Screen runtime still owns unresolved binding work.'",
      );
      expect(await browser.js('fixture.screenWork.length')).toBe(1);
      await browser.js('fixture.screenWork[0].raw.resolve(fixture.screenReply)');
      await browser.js('(async()=>{for(let i=0;i<24;i++)await Promise.resolve()})()');
      expect(await browser.js('fixture.runtime.inspect().bindingBusy')).toBe(true);
      await browser.js('fixture.screenWork[0].retired.resolve()');
      await browser.wait('!fixture.runtime.inspect().bindingBusy');
      await browser.js(
        'fixture.currentScreen=fixture.attachments.at(-1).bind();fixture.screenWork[1].raw.resolve(fixture.screenReply);fixture.currentScreen.then(value=>fixture.screenHandle=value)',
      );
      await browser.wait('!!fixture.screenHandle?.inspect()');
      await browser.js(
        'fixture.oldAttachment.stop();fixture.oldAttachment.release();fixture.toggle();fixture.rerender()',
      );
      expect(
        await browser.js(
          '!!fixture.screenHandle.inspect() && fixture.active===1 && !fixture.runtime.inspect().disposed',
        ),
      ).toBe(true);
      await browser.js('fixture.logout()');
      expect(await browser.js('fixture.screenHandle.inspect()')).toBeNull();
      await browser.js('fixture.screenWork[1].retired.resolve()');
      await browser.wait('!fixture.runtime.inspect().bindingBusy');
      expect(await browser.js('fixture.errors')).toEqual([]);
      expect(await browser.js('fixture.screenErrors')).toEqual([]);
    },
    'approved',
    runtimeFixture,
  );
});
it('keeps mounted voice available when optional screen ownership fails', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      expect(
        await browser.js(
          "fixture.call.voice.status==='idle' && fixture.screenErrors.every(error=>error==='Synthetic screen attachment failure') && fixture.screenErrors.length>0",
        ),
      ).toBe(true);
      await browser.js(
        "fixture.call.controls.selectInput('synthetic-mic');fixture.call.controls.selectOutput('synthetic-output');fixture.observe(fixture.call.controls.join('room'),'voiceResult')",
      );
      await browser.wait("fixture.joins.length===1 && fixture.call.voice.status==='joining'");
      expect(await browser.js('fixture.screenWork.length')).toBe(0);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    runtimeFixture.replace('optionalScreenFailure=false', 'optionalScreenFailure=true'),
  );
});
it('delivers every voice transition to synchronous subscribers despite React batching and fences stale subscriptions', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await browser.js(`fixture.voiceStates=[];fixture.oldSubscribe=fixture.call.subscribeVoice;
      fixture.unsubscribeVoice=fixture.call.subscribeVoice(voice=>fixture.voiceStates.push(voice));
      fixture.call.controls.selectInput('first-fixture-mic');fixture.call.controls.selectInput('second-fixture-mic')`);
    expect(await browser.js('fixture.voiceStates.map(voice=>voice.input)')).toEqual([
      '',
      'first-fixture-mic',
      'second-fixture-mic',
    ]);
    expect(
      await browser.js(
        'fixture.voiceStates.every(voice=>Object.isFrozen(voice)&&Object.isFrozen(voice.participants))',
      ),
    ).toBe(true);
    await browser.js("fixture.server=fixture.state('b');fixture.auth.refresh()");
    await browser.wait("fixture.auth.state.csrfToken==='b' && !!fixture.call");
    await browser.js(
      "fixture.oldSubscribe(()=>fixture.errors.push('Obsolete subscription'));fixture.call.controls.selectInput('replacement-fixture-mic')",
    );
    expect(await browser.js('fixture.voiceStates.length')).toBe(3);
    expect(await browser.js('fixture.errors')).toEqual([]);
  });
});

it('lease invalidation stops preview immediately while voice recovery stays independent', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await browser.js('fixture.current=fixture.previews.at(-1);fixture.join();fixture.play()');
      await browser.wait(
        "fixture.current.owner.inspect().phase==='preview' && fixture.joins.length===1",
      );
      expect(
        await browser.js(
          "fixture.leaseListeners.forEach(listener=>listener());fixture.current.track.readyState==='ended'",
        ),
      ).toBe(true);
      expect(
        await browser.js(
          "fixture.call.voice.status==='joining' && fixture.joinResult===undefined && !fixture.calls.some(c=>c.path==='/voice/leave')",
        ),
      ).toBe(true);
      expect(await browser.js('fixture.current.owner.inspect().phase')).toBe('idle');
      expect(await browser.js('fixture.current.starts')).toBe(1);
    },
    'approved',
    previewFixture,
  );
});

it('lease-loss subscription follows the call owner and stale notifications cannot stop its replacement', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      expect(await browser.js('fixture.leaseListeners.size')).toBe(1);
      await browser.js(
        'fixture.oldLeaseListener=[...fixture.leaseListeners][0];fixture.old=fixture.previews.at(-1);fixture.toggle();fixture.rerender()',
      );
      expect(await browser.js('fixture.leaseListeners.size')).toBe(1);
      await browser.js('fixture.replace()');
      await browser.wait('!!fixture.call && fixture.previews.at(-1)!==fixture.old');
      await browser.js('fixture.play()');
      await browser.wait("fixture.previews.at(-1).owner.inspect().phase==='preview'");
      expect(
        await browser.js(
          "fixture.oldLeaseListener();fixture.previews.at(-1).track.readyState==='live' && fixture.leaseListeners.size===1",
        ),
      ).toBe(true);
      expect(await browser.js('fixture.logout();fixture.leaseListeners.size')).toBe(0);
      expect(await browser.js('fixture.previews.at(-1).track.readyState')).toBe('ended');
    },
    'approved',
    previewFixture,
  );
});

it('lease loss cancels preparation and its late result cannot authorize a replacement', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await browser.js(
        "fixture.old=fixture.previews.at(-1);fixture.observe(fixture.old.owner.prepare({sound:'none'}),'oldPreparation');fixture.leaseListeners.forEach(listener=>listener())",
      );
      await browser.wait('fixture.oldPreparation!==undefined');
      await browser.js('fixture.replace()');
      await browser.wait('!!fixture.call && fixture.previews.at(-1)!==fixture.old');
      await browser.js('fixture.play();fixture.old.prepare.resolve(fixture.old.handle)');
      await browser.wait(
        "fixture.previews.at(-1).owner.inspect().phase==='preview' && fixture.old.handle.disposed",
      );
      expect(
        await browser.js(
          "fixture.old.starts===0 && fixture.previews.at(-1).track.readyState==='live' && fixture.errors.length===0",
        ),
      ).toBe(true);
    },
    'approved',
    previewFixture,
  );
});

it('default provider path constructs no preview and exposes audio context only', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      expect(await browser.js('fixture.previews.length')).toBe(0);
      expect(await browser.js('Object.keys(fixture.call).sort()')).toEqual([
        'controls',
        'devices',
        'subscribeVoice',
        'voice',
      ]);
      await browser.js('fixture.join()');
      await browser.wait('fixture.joins.length===1');
      expect(await browser.js('fixture.previews.length')).toBe(0);
    },
    'approved',
    previewFixture.replace('injected=true', 'injected=false'),
  );
});

it('one injected preview survives view remount, same-session refresh and dependency rerender', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await browser.js(
        'fixture.original=fixture.previews.at(-1);fixture.count=fixture.previews.length;fixture.controls=fixture.call.controls;fixture.play()',
      );
      await browser.wait("fixture.original.owner.inspect().phase==='preview'");
      await browser.js('fixture.toggle();fixture.refresh();fixture.rerender()');
      expect(
        await browser.js(
          'fixture.previews.length===fixture.count && fixture.previews.at(-1)===fixture.original && fixture.call.controls===fixture.controls && fixture.original.track.readyState==="live"',
        ),
      ).toBe(true);
      expect(
        await browser.js('fixture.previews.filter(p=>p.owner.inspect().phase!=="disposed").length'),
      ).toBe(1);
      expect(
        await browser.js(
          'fixture.previews.slice(0,-1).every(p=>p.cleaned===1 && p.invalidations.size===0)',
        ),
      ).toBe(true);
      expect(await browser.js('Object.keys(fixture.call).sort()')).toEqual([
        'controls',
        'devices',
        'subscribeVoice',
        'voice',
      ]);
    },
    'approved',
    previewFixture,
  );
});

it.each(['stop', 'source-ended', 'expiry', 'failure'] as const)(
  'preview %s preserves an authorized pending voice join',
  async (end) => {
    await mountedFixture(
      async (browser) => {
        await browser.wait('!!window.fixture?.call && fixture.active===1');
        await browser.js('fixture.join();fixture.current=fixture.previews.at(-1);fixture.play()');
        await browser.wait(
          "fixture.joins.length===1 && fixture.current.owner.inspect().phase==='preview'",
        );
        if (end === 'stop') await browser.js('fixture.current.owner.stop()');
        else if (end === 'source-ended')
          await browser.js(
            "fixture.current.track.readyState='ended';fixture.current.track.dispatchEvent(new Event('ended'))",
          );
        else if (end === 'expiry')
          await browser.js(
            'fixture.now=fixture.current.handle.deadline;fixture.current.owner.inspect()',
          );
        else await browser.js('fixture.current.invalidations.forEach(listener=>listener())');
        expect(
          await browser.js(
            "fixture.current.track.readyState==='ended' && fixture.call.voice.status==='joining' && fixture.joinResult===undefined && !fixture.calls.some(c=>c.path==='/voice/leave') && fixture.active===1",
          ),
        ).toBe(true);
      },
      'approved',
      previewFixture,
    );
  },
);

it.each(['manual', 'observed', 'logout', 'replacement', 'unmount'] as const)(
  '%s voice/session end synchronously stops preview and the correct pending join',
  async (end) => {
    await mountedFixture(
      async (browser) => {
        await browser.wait('!!window.fixture?.call && fixture.active===1');
        await browser.js('fixture.old=fixture.previews.at(-1);fixture.join();fixture.play()');
        await browser.wait(
          "fixture.joins.length===1 && fixture.old.owner.inspect().phase==='preview'",
        );
        const action =
          end === 'manual'
            ? 'fixture.call.controls.leave()'
            : end === 'observed'
              ? 'fixture.controller.leave()'
              : end === 'logout'
                ? 'fixture.logout()'
                : end === 'replacement'
                  ? 'fixture.replace()'
                  : 'fixture.root.unmount()';
        expect(await browser.js(`${action};fixture.old.track.readyState==='ended'`)).toBe(true);
        if (end === 'replacement') {
          await browser.wait('!!fixture.call && fixture.previews.at(-1)!==fixture.old');
          await browser.js('fixture.play()');
          await browser.wait("fixture.previews.at(-1).owner.inspect().phase==='preview'");
        }
        await browser.js(
          "fixture.respond(fixture.joins[0],{id:'old-owned-lease',channelId:'room',credential:'synthetic'})",
        );
        await browser.wait(
          "fixture.calls.some(c=>c.path==='/voice/leave' && c.body.leaseId==='old-owned-lease')",
        );
        if (end === 'replacement')
          expect(
            await browser.js(
              "fixture.previews.at(-1).track.readyState==='live' && fixture.call.voice.status==='idle'",
            ),
          ).toBe(true);
        expect(await browser.js('fixture.errors')).toEqual([]);
      },
      'approved',
      previewFixture,
    );
  },
);

it('failed optional factory drains resources and leaves audio controls usable', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      expect(
        await browser.js(
          'fixture.previews.every(p=>p.cleaned===1 && p.invalidations.size===0 && p.owner.inspect().phase==="disposed") && fixture.previewErrors.length===fixture.previews.length',
        ),
      ).toBe(true);
      await browser.js('fixture.join()');
      await browser.wait('fixture.joins.length===1');
      expect(await browser.js('fixture.call.voice.status')).toBe('joining');
    },
    'approved',
    previewFixture.replace('factoryFailure=false', 'factoryFailure=true'),
  );
});

it('capture failure leaves the existing voice join pending', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await browser.js('fixture.current=fixture.previews.at(-1);fixture.join();fixture.ready()');
      await browser.wait(
        "fixture.current.owner.inspect().phase==='ready' && fixture.joins.length===1",
      );
      await browser.js(
        "fixture.observe(fixture.current.owner.start(),'screenFailure');fixture.current.raw.reject(new Error('Synthetic picker failure'))",
      );
      await browser.wait('fixture.screenFailure!==undefined');
      expect(
        await browser.js(
          "fixture.current.owner.inspect().phase==='idle' && fixture.call.voice.status==='joining' && fixture.joinResult===undefined && fixture.active===1",
        ),
      ).toBe(true);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    previewFixture,
  );
});

it('voice disposal failure still disposes preview and cancels pending callers before replacement', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await browser.js('fixture.old=fixture.previews.at(-1);fixture.join();fixture.play()');
      await browser.wait(
        "fixture.old.owner.inspect().phase==='preview' && fixture.joins.length===1",
      );
      expect(
        await browser.js(
          "fixture.failVoiceDispose=true;try{fixture.logout()}catch(error){fixture.voiceError=error.message}fixture.old.track.readyState==='ended' && fixture.active===0",
        ),
      ).toBe(true);
      await browser.wait("fixture.joinResult==='Voice session ended.'");
      expect(await browser.js('fixture.voiceError')).toBe('Synthetic voice cleanup failure');
      await browser.js('fixture.failVoiceDispose=false;fixture.replace()');
      await browser.wait(
        '!!fixture.call && fixture.previews.at(-1)!==fixture.old && fixture.active===1',
      );
      await browser.js(
        "fixture.play();fixture.respond(fixture.joins[0],{id:'failed-cleanup-lease',channelId:'room',credential:'synthetic'})",
      );
      await browser.wait(
        "fixture.previews.at(-1).owner.inspect().phase==='preview' && fixture.calls.some(c=>c.path==='/voice/leave')",
      );
      expect(await browser.js('fixture.previews.at(-1).track.readyState')).toBe('live');
    },
    'approved',
    previewFixture,
  );
});

it.each(['stop', 'dispose'] as const)(
  'preview %s failure still cleans voice work and reports the failure',
  async (mode) => {
    await mountedFixture(
      async (browser) => {
        await browser.wait('!!window.fixture?.call && fixture.active===1');
        await browser.js('fixture.current=fixture.previews.at(-1);fixture.join();fixture.play()');
        await browser.wait(
          "fixture.current.owner.inspect().phase==='preview' && fixture.joins.length===1",
        );
        await browser.js(
          `fixture.original=fixture.current.owner.${mode}.bind(fixture.current.owner);fixture.current.owner.${mode}=()=>{fixture.original();throw new Error('Synthetic preview cleanup failure')}`,
        );
        await browser.js(mode === 'stop' ? 'fixture.call.controls.leave()' : 'fixture.logout()');
        await browser.wait('fixture.previewErrors.length>0');
        expect(
          await browser.js(
            "fixture.current.track.readyState==='ended' && (fixture.call===null || fixture.call.voice.status==='idle')",
          ),
        ).toBe(true);
        await browser.js(
          `fixture.current.owner.${mode}=fixture.original;fixture.respond(fixture.joins[0],{id:'cleanup-lease',channelId:'room',credential:'synthetic'})`,
        );
        await browser.wait("fixture.calls.some(c=>c.path==='/voice/leave')");
      },
      'approved',
      previewFixture,
    );
  },
);

it.each(['prepare-resolve', 'prepare-reject', 'capture-resolve', 'capture-reject'] as const)(
  'replacement fences late %s with the real preview/capture implementation',
  async (late) => {
    await mountedFixture(
      async (browser) => {
        await browser.wait('!!window.fixture?.call && fixture.active===1');
        await browser.js('fixture.old=fixture.previews.at(-1)');
        if (late.startsWith('prepare'))
          await browser.js(
            "fixture.observe(fixture.old.owner.prepare({sound:'none'}),'oldPreview')",
          );
        else {
          await browser.js('fixture.ready()');
          await browser.wait("fixture.old.owner.inspect().phase==='ready'");
          expect(
            await browser.js(
              "fixture.observe(fixture.old.owner.start(),'oldPreview');fixture.old.starts",
            ),
          ).toBe(1);
        }
        await browser.js('fixture.replace()');
        await browser.wait(
          '!!fixture.call && fixture.previews.at(-1)!==fixture.old && fixture.oldPreview!==undefined',
        );
        await browser.js('fixture.play()');
        await browser.wait("fixture.previews.at(-1).owner.inspect().phase==='preview'");
        const target = late.startsWith('prepare') ? 'fixture.old.prepare' : 'fixture.old.raw';
        await browser.js(
          late.endsWith('reject')
            ? `${target}.reject(new Error('Obsolete synthetic failure'))`
            : `${target}.resolve(${late.startsWith('prepare') ? 'fixture.old.handle' : 'fixture.old.stream'})`,
        );
        await browser.js('(async()=>{for(let i=0;i<12;i++)await Promise.resolve()})()');
        expect(
          await browser.js(
            "fixture.previews.at(-1).track.readyState==='live' && fixture.old.owner.inspect().phase==='disposed' && fixture.errors.length===0",
          ),
        ).toBe(true);
        if (late === 'capture-resolve')
          expect(await browser.js('fixture.old.track.readyState')).toBe('ended');
      },
      'approved',
      previewFixture,
    );
  },
);

// Test-only virtual entry: actual AuthRoot/CallProvider/VoicePanel, synthetic HTTP/media boundaries.
const fixture = `
import { createElement as h, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthRoot, useAuth } from '/src/Auth.tsx';
import { useCall } from '/src/CallProvider.tsx';
import { VoicePanel } from '/src/VoicePanel.tsx';
const deferred=()=>{let resolve,reject; const promise=new Promise((r,e)=>{resolve=r;reject=e});return {promise,resolve,reject}};
const f=window.fixture={active:0, created:0, captureCalls:0, captures:[], enumerateCalls:0, enumerations:[], deviceList:[], stopped:0, calls:[], joins:[], logouts:[], errors:[]};
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
const listeners=new Set();
const devices=navigator.mediaDevices;
const add=devices.addEventListener.bind(devices), remove=devices.removeEventListener.bind(devices);
devices.addEventListener=(event,listener,...args)=>{if(event==='devicechange'){listeners.add(listener);f.created++;f.active=listeners.size}return add(event,listener,...args)};
devices.removeEventListener=(event,listener,...args)=>{if(event==='devicechange'){listeners.delete(listener);f.active=listeners.size}return remove(event,listener,...args)};
devices.getUserMedia=()=>{f.expectPermissionEnumeration=true;f.captureCalls++;f.capture=deferred();f.captures.push(f.capture);return f.capture.promise};
devices.enumerateDevices=async()=>{if(f.expectPermissionEnumeration){f.enumerateCalls++;f.expectPermissionEnumeration=false}else{f.passiveEnumerateCalls=(f.passiveEnumerateCalls??0)+1}if(f.holdEnumeration){f.holdEnumeration=false;f.enumeration=deferred();f.enumerations.push(f.enumeration);return f.enumeration.promise}return f.deviceList};
f.finishCapture=(capture=f.capture)=>capture.resolve({getTracks:()=>[{stop:()=>f.stopped++}]});
f.state=(csrf='a',status='approved')=>({user:{id:'account',username:'fixture',displayName:'Fixture',status,isOwner:false},csrfToken:csrf,expiresAt:new Date(Date.now()+600000).toISOString(),remember:false});
f.server=f.state();
const nativeFetch=window.fetch.bind(window);
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(path,options={})=>{
 if(!String(path).startsWith('/api')) return nativeFetch(path,options);
 f.calls.push({path,csrf:options.headers?.['X-CSRF-Token'],body:options.body});
 if(path==='/api/auth/me') { if(f.holdMe){f.holdMe=false;f.me=deferred();return f.me.promise} return response(f.server??{error:'Sign in required.'},f.server?200:401) }
 if(path==='/api/auth/login') return response(f.server);
 if(path==='/api/auth/logout'){const d=deferred();f.logouts.push(d);return d.promise}
 if(path==='/api/voice/join'){const d=deferred();f.joins.push(d);return d.promise}
 if(path==='/api/voice/channels') return response({channels:[]});
 return response({ok:true});
};
f.respond=(d,value,status=200)=>d.resolve(response(value,status));
function View(){const auth=useAuth(),call=useCall();const [panel,setPanel]=useState(true);f.auth=auth;f.call=call;f.toggle=()=>setPanel(v=>!v);return panel?h(VoicePanel):h('p',null,'View changed')}
f.mount=()=>{f.root=createRoot(document.getElementById('root'));f.root.render(h(StrictMode,null,h(AuthRoot,null,h(View))))};
f.signIn=()=>{const form=document.querySelector('form');form.querySelector('[name=username]').value='fixture';form.querySelector('[name=password]').value='synthetic-password';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))};
f.observe=(promise,key)=>{void promise.then(()=>f[key]='resolved',e=>f[key]=e.message)};
f.mount();
`;

async function mountedFixture(
  work: (browser: Awaited<ReturnType<typeof launch>>) => Promise<void>,
  initialStatus: 'approved' | 'pending' | 'rejected' = 'approved',
  source = fixture,
) {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'owned-call-fixture',
        resolveId: (id) => (id === '/__call-fixture.js' ? '\0call-fixture' : undefined),
        load: (id) =>
          id === '\0call-fixture'
            ? source.replace('f.server=f.state();', `f.server=f.state('a','${initialStatus}');`)
            : undefined,
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(
              '<div id="root"></div><script type="module" src="/__call-fixture.js"></script>',
            );
          });
        },
      },
    ],
  });
  let browser: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await server.listen();
    browser = await launch();
    await browser.call('Page.navigate', { url: server.resolvedUrls!.local[0] });
    await work(browser);
  } finally {
    try {
      if (browser) {
        await browser
          .js(
            `(async()=>{const f=window.fixture;if(!f)return;f.root.unmount();
          if(f.me)f.respond(f.me,{error:'Fixture closed'},401);
          f.joins.forEach(d=>f.respond(d,{error:'Fixture closed'},503));
          f.logouts.forEach(d=>f.respond(d,{error:'Fixture closed'},503));
          f.captures.forEach(capture=>f.finishCapture(capture));
          f.enumerations.forEach(enumeration=>enumeration.resolve([]));
          f.drainPreview?.();
          f.drainScreens?.();
          for(let i=0;i<8;i++)await Promise.resolve();})()`,
          )
          .catch(() => {});
        await browser.close();
      }
    } finally {
      await server.close();
    }
  }
}

async function audioControls(browser: Awaited<ReturnType<typeof launch>>) {
  await browser.wait("!!document.querySelector('.voice-settings-toggle')");
  await browser.js(
    "if(!document.querySelector('[aria-label=\"Voice microphone\"]'))document.querySelector('.voice-settings-toggle').click()",
  );
  await browser.wait('!!document.querySelector(\'[aria-label="Voice microphone"]\')');
}

async function discoverAudio(browser: Awaited<ReturnType<typeof launch>>) {
  await browser.js(
    "fixture.deviceList=[{kind:'audioinput',deviceId:'owned-mic',label:'Owned synthetic microphone',groupId:'private-group'},{kind:'audiooutput',deviceId:'owned-output',label:'Owned synthetic speakers',groupId:'private-group'}];fixture.observe(fixture.call.controls.devices(),'explicitDiscovery')",
  );
  await browser.wait('!!fixture.capture');
  await browser.js('fixture.finishCapture()');
  await browser.wait(
    'document.querySelector(\'[aria-label="Voice microphone"]\').options.length===2',
  );
}

it('opens audio inventory without capture and routes the master level through the shared call', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await audioControls(browser);
    await browser.wait("fixture.call.voice.devicesStatus==='permission-needed'");
    expect(await browser.js('fixture.captureCalls')).toBe(0);
    expect(await browser.js('fixture.passiveEnumerateCalls')).toBe(1);
    await browser.js(
      "fixture.deviceList=[{kind:'audioinput',deviceId:'mic',label:'Synthetic mic'},{kind:'audiooutput',deviceId:'speaker',label:'Synthetic speakers'}];[...document.querySelectorAll('button')].find(button=>button.textContent==='Allow microphone access').click();fixture.finishCapture()",
    );
    await browser.wait("fixture.call.voice.devicesStatus==='ready'");
    await browser.js(
      "(()=>{const slider=document.querySelector('[aria-label=\"Voice output volume\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'2');slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
    await browser.wait('fixture.call.voice.outputVolume===2');
    expect(await browser.js('fixture.captureCalls')).toBe(1);
    expect(await browser.js('fixture.joins.length')).toBe(0);
    expect(
      await browser.js("fixture.call.voice.input==='' && fixture.call.voice.output===''"),
    ).toBe(true);
    expect(await browser.js('fixture.errors')).toEqual([]);
  });
});

it('native microphone reset replaces only the call owner and fences old pending work and callbacks', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await audioControls(browser);
      await discoverAudio(browser);
      await browser.js(
        "(async()=>{fixture.saved=fixture.call.controls;fixture.staleReset=[...fixture.resets][0];await fixture.call.controls.selectInput('owned-mic');await fixture.call.controls.selectOutput('owned-output');fixture.observe(fixture.call.controls.join('room'),'oldJoin');const field=document.createElement('textarea');field.id='reset-draft';field.value='Keep this draft';document.body.append(field);field.focus();fixture.staleReset()})()",
      );
      await browser.wait(
        "fixture.oldJoin==='Voice session ended.' && !!fixture.call && fixture.call.controls!==fixture.saved && fixture.active===1",
      );
      expect(
        await browser.js(
          "fixture.call.voice.status==='idle' && fixture.call.voice.input==='' && fixture.call.voice.output==='' && document.activeElement.id==='reset-draft' && document.activeElement.value==='Keep this draft'",
        ),
      ).toBe(true);
      expect(await browser.js('fixture.resets.size')).toBe(1);
      await browser.js('fixture.replacement=fixture.call.controls;fixture.staleReset()');
      expect(await browser.js('fixture.call.controls===fixture.replacement')).toBe(true);
      await browser.js('[...fixture.resets][0]()');
      await browser.wait(
        '!!fixture.call && fixture.call.controls!==fixture.replacement && fixture.active===1',
      );
      await browser.js(
        "fixture.respond(fixture.joins[0],{id:'old-reset-lease',channelId:'room',credential:'synthetic'})",
      );
      await browser.wait(
        "fixture.calls.some(call=>call.path==='/api/voice/leave'&&JSON.parse(call.body).leaseId==='old-reset-lease')",
      );
      expect(await browser.js('fixture.resets.size')).toBe(1);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    fixture.replace(
      'f.mount();',
      `f.resets=new Set();window.tricordDesktop={onMicrophonePermissionReset(listener){f.resets.add(listener);return ()=>f.resets.delete(listener)}};f.mount();`,
    ),
  );
});

it('panel remount preserves the discovered visible selections without opening devices again', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await audioControls(browser);
    await discoverAudio(browser);
    await browser.js(
      "for(const [label,id] of [['Voice microphone','owned-mic'],['Voice speakers','owned-output']]){const select=document.querySelector('[aria-label=\"'+label+'\"]');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));}",
    );
    await browser.wait(
      "fixture.call.voice.input==='owned-mic' && fixture.call.voice.output==='owned-output'",
    );
    await browser.js('fixture.originalControls=fixture.call.controls;fixture.toggle()');
    await browser.wait("!document.querySelector('.voice-panel')");
    await browser.js('fixture.toggle()');
    await audioControls(browser);
    expect(
      await browser.js(
        "[...document.querySelectorAll('.voice-controls select')].slice(0,2).map(s=>s.value)",
      ),
    ).toEqual(['owned-mic', 'owned-output']);
    expect(
      await browser.js(
        "[...document.querySelectorAll('.voice-controls select')].slice(0,2).map(s=>s.selectedOptions[0].textContent)",
      ),
    ).toEqual(['Owned synthetic microphone', 'Owned synthetic speakers']);
    expect(
      await browser.js(
        'fixture.call.controls===fixture.originalControls && fixture.captureCalls===1 && fixture.enumerateCalls===1 && fixture.stopped===1',
      ),
    ).toBe(true);
    await browser.js('fixture.catalog=fixture.call.devices;fixture.auth.refresh()');
    expect(
      await browser.js(
        'fixture.call.devices===fixture.catalog && fixture.call.controls===fixture.originalControls',
      ),
    ).toBe(true);
    await browser.js("fixture.observe(fixture.call.controls.join('room'),'catalogJoin')");
    await browser.wait("fixture.call.voice.status==='joining'");
    await browser.js('document.querySelector(\'[aria-label="Leave voice"]\').click()');
    await browser.wait("fixture.call.voice.status==='idle'");
    expect(
      await browser.js(
        "fixture.call.devices===fixture.catalog && fixture.call.voice.input==='owned-mic' && fixture.call.voice.output==='owned-output'",
      ),
    ).toBe(true);
    await browser.js(
      "fixture.respond(fixture.joins[0],{id:'old-catalog-lease',channelId:'room',credential:'synthetic'})",
    );
    await browser.wait("fixture.catalogJoin==='resolved'");
    expect(await browser.js('fixture.captureCalls===1 && fixture.enumerateCalls===1')).toBe(true);
  });
});

it('the local catalog copies only immutable concrete audio metadata', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await audioControls(browser);
    await browser.js(`fixture.deviceList=[
      Object.create(null,{kind:{value:'audioinput'},deviceId:{value:'owned-mic'},label:{value:'Non-enumerable microphone',writable:true},groupId:{value:'private-group'}}),
      {kind:'audiooutput',deviceId:'owned-output',label:'Owned speakers',groupId:'private-group'},
      {kind:'audioinput',deviceId:'default',label:'Automatic'},
      {kind:'audiooutput',deviceId:'communications',label:'Automatic'},
      {kind:'audioinput',deviceId:'',label:'Empty ID'},
      {kind:'videoinput',deviceId:'camera',label:'Unused camera'}];
      fixture.observe(fixture.call.controls.devices(),'explicitDiscovery');fixture.finishCapture()`);
    await browser.wait('fixture.call.devices.length===2');
    expect(
      await browser.js(
        'Object.isFrozen(fixture.call) && Object.isFrozen(fixture.call.devices) && fixture.call.devices.every(Object.isFrozen)',
      ),
    ).toBe(true);
    expect(await browser.js('fixture.call.devices.map(d=>Object.keys(d).sort())')).toEqual([
      ['deviceId', 'kind', 'label'],
      ['deviceId', 'kind', 'label'],
    ]);
    await browser.js(
      "fixture.deviceList[0].label='Mutated source label';fixture.deviceList.push({kind:'audioinput',deviceId:'late',label:'Late raw device'})",
    );
    expect(await browser.js('fixture.call.devices.map(d=>d.label)')).toEqual([
      'Non-enumerable microphone',
      'Owned speakers',
    ]);
    expect(
      await browser.js(
        "document.querySelector('[aria-label=\"Voice microphone\"]').options.length===2 && !JSON.stringify(fixture.calls).includes('Non-enumerable microphone') && fixture.captureCalls===1 && fixture.enumerateCalls===1",
      ),
    ).toBe(true);
  });
});

it('discovery started by an old panel can finish into the same owned call after remount', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await audioControls(browser);
    await browser.js(
      "fixture.deviceList=[{kind:'audioinput',deviceId:'pending-mic',label:'Pending microphone'}];fixture.observe(fixture.call.controls.devices(),'explicitDiscovery');fixture.toggle()",
    );
    await browser.wait("!document.querySelector('.voice-panel')");
    await browser.js('fixture.toggle()');
    await audioControls(browser);
    expect(await browser.js('fixture.captureCalls===1 && fixture.enumerateCalls===0')).toBe(true);
    await browser.js('fixture.finishCapture()');
    await browser.wait(
      'document.querySelector(\'[aria-label="Voice microphone"]\').options.length===2',
    );
    expect(
      await browser.js(
        "fixture.call.devices[0].deviceId==='pending-mic' && fixture.captureCalls===1 && fixture.enumerateCalls===1 && fixture.stopped===1 && fixture.active===1",
      ),
    ).toBe(true);
  });
});

it.each(['resolve', 'reject'] as const)(
  'late discovery %s cannot populate or report errors into a replacement session',
  async (late) => {
    await mountedFixture(async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await audioControls(browser);
      await discoverAudio(browser);
      await browser.js(
        "fixture.observe(fixture.call.controls.devices(),'oldDiscovery');fixture.oldCapture=fixture.capture;fixture.deviceList=[];fixture.server=fixture.state('b');fixture.auth.refresh()",
      );
      await browser.wait(
        "fixture.auth.state.csrfToken==='b' && fixture.oldDiscovery==='Voice session ended.' && !!fixture.call",
      );
      expect(await browser.js('fixture.call.devices.length')).toBe(0);
      await browser.js(
        "fixture.deviceList=[{kind:'audioinput',deviceId:'new-mic',label:'Replacement microphone'}];fixture.observe(fixture.call.controls.devices(),'newDiscovery');fixture.finishCapture()",
      );
      await browser.wait(
        "fixture.newDiscovery==='resolved' && fixture.call.devices[0]?.deviceId==='new-mic'",
      );
      await browser.js(
        "fixture.deviceList=[{kind:'audioinput',deviceId:'obsolete-mic',label:'Obsolete microphone'}]",
      );
      await browser.js(
        late === 'resolve'
          ? 'fixture.finishCapture(fixture.oldCapture)'
          : "fixture.oldCapture.reject(Error('Obsolete discovery failure'))",
      );
      await browser.wait(late === 'resolve' ? 'fixture.stopped===3' : 'fixture.errors.length===0');
      // Drain the observed old promise callbacks before checking the current view.
      await browser.js('(async()=>{for(let i=0;i<8;i++)await Promise.resolve()})()');
      expect(
        await browser.js(
          "fixture.call.devices.length===1 && fixture.call.devices[0].deviceId==='new-mic' && !document.body.textContent.includes('Obsolete discovery failure') && fixture.active===1 && fixture.captureCalls===3",
        ),
      ).toBe(true);
      expect(await browser.js('fixture.errors')).toEqual([]);
    });
  },
);

it.each(['resolve', 'reject'] as const)(
  'late enumeration %s stays scoped to its disposed owner',
  async (late) => {
    await mountedFixture(async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await browser.js(
        "fixture.holdEnumeration=true;fixture.observe(fixture.call.controls.devices(),'oldEnumeration');fixture.finishCapture()",
      );
      await browser.wait('!!fixture.enumeration && fixture.stopped===1');
      await browser.js("fixture.server=fixture.state('b');fixture.auth.refresh()");
      await browser.wait(
        "fixture.auth.state.csrfToken==='b' && fixture.oldEnumeration==='Voice session ended.' && !!fixture.call",
      );
      await browser.js(
        "fixture.deviceList=[{kind:'audioinput',deviceId:'new-mic',label:'New microphone'}];fixture.observe(fixture.call.controls.devices(),'currentEnumeration');fixture.finishCapture()",
      );
      await browser.wait("fixture.currentEnumeration==='resolved'");
      await browser.js(
        late === 'resolve'
          ? "fixture.enumeration.resolve([{kind:'audioinput',deviceId:'obsolete',label:'Obsolete microphone'}])"
          : "fixture.enumeration.reject(Error('Obsolete enumeration failed'))",
      );
      await browser.js('(async()=>{for(let i=0;i<8;i++)await Promise.resolve()})()');
      expect(
        await browser.js(
          "fixture.call.devices.length===1 && fixture.call.devices[0].deviceId==='new-mic' && fixture.captureCalls===2 && fixture.stopped===2",
        ),
      ).toBe(true);
      expect(await browser.js('fixture.errors')).toEqual([]);
    });
  },
);

it.each(['logout', 'approval', 'unmount', 'recovery'] as const)(
  '%s clears the catalog before a new owner is accepted',
  async (loss) => {
    await mountedFixture(async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await audioControls(browser);
      await discoverAudio(browser);
      await browser.js('fixture.previousControls=fixture.call.controls;fixture.deviceList=[]');
      if (loss === 'unmount') {
        await browser.js('fixture.root.unmount()');
        expect(await browser.js('fixture.active')).toBe(0);
        await browser.js("fixture.server=fixture.state('b');fixture.mount()");
      } else if (loss === 'approval') {
        await browser.js("fixture.server=fixture.state('a','pending');fixture.auth.refresh()");
        await browser.wait(
          "fixture.active===0 && !!document.querySelector('[data-account-status=pending]')",
        );
        await browser.js("fixture.server=fixture.state('b');fixture.auth.refresh()");
      } else {
        expect(
          await browser.js("fixture.observe(fixture.auth.logout(),'logout');fixture.active"),
        ).toBe(0);
        await browser.wait('fixture.logouts.length===1');
        await browser.js(
          loss === 'logout'
            ? 'fixture.server=null;fixture.respond(fixture.logouts[0],{ok:true})'
            : "fixture.respond(fixture.logouts[0],{error:'Synthetic logout failure'},503)",
        );
        if (loss === 'logout') {
          await browser.wait("!!document.querySelector('[name=password]')");
          await browser.js("fixture.server=fixture.state('b');fixture.signIn()");
        }
      }
      await browser.wait(
        'fixture.active===1 && !!fixture.call && fixture.call.controls!==fixture.previousControls',
      );
      await audioControls(browser);
      expect(
        await browser.js(
          "fixture.call.devices.length===0 && fixture.call.voice.input==='' && fixture.call.voice.output==='' && document.querySelector('[aria-label=\"Voice microphone\"]').options.length===1 && fixture.captureCalls===1 && fixture.enumerateCalls===1",
        ),
      ).toBe(true);
    });
  },
);

it.each(['resolve', 'reject'] as const)(
  'overlapping discovery coalesces one consent probe and reports its %s result',
  async (outcome) => {
    await mountedFixture(async (browser) => {
      await browser.wait('!!window.fixture?.call && fixture.active===1');
      await browser.js(
        "fixture.observe(fixture.call.controls.devices(),'oldDiscovery');fixture.observe(fixture.call.controls.devices(),'latestDiscovery');fixture.deviceList=[{kind:'audioinput',deviceId:'latest',label:'Latest microphone'}]",
      );
      expect(await browser.js('fixture.captureCalls')).toBe(1);
      await browser.js(
        outcome === 'resolve'
          ? 'fixture.finishCapture()'
          : "fixture.capture.reject(Error('Synthetic discovery failure'))",
      );
      await browser.wait(
        "fixture.oldDiscovery==='resolved' && fixture.latestDiscovery==='resolved'",
      );
      expect(await browser.js('fixture.captureCalls')).toBe(1);
      if (outcome === 'resolve') {
        expect(await browser.js('fixture.call.devices.map(device=>device.deviceId)')).toEqual([
          'latest',
        ]);
        expect(await browser.js('fixture.stopped')).toBe(1);
      } else {
        expect(await browser.js('fixture.call.devices')).toEqual([]);
        expect(await browser.js('fixture.call.voice.devicesError')).toContain(
          'Synthetic discovery failure',
        );
        expect(await browser.js('fixture.call.voice.devicesStatus')).toBe('error');
      }
      expect(await browser.js('fixture.errors')).toEqual([]);
    });
  },
);

it('failed explicit discovery keeps the previous catalog and reports the current error', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await audioControls(browser);
    await discoverAudio(browser);
    await browser.js(
      "fixture.previousCatalog=fixture.call.devices;fixture.observe(fixture.call.controls.devices(),'explicitDiscovery');fixture.capture.reject(Error('Synthetic current discovery failure'))",
    );
    await browser.wait("document.body.textContent.includes('Synthetic current discovery failure')");
    expect(
      await browser.js(
        'fixture.call.devices===fixture.previousCatalog && fixture.captureCalls===2 && fixture.enumerateCalls===1 && fixture.stopped===1',
      ),
    ).toBe(true);
    expect(await browser.js('fixture.errors')).toEqual([]);
  });
});

it('an old logout intention cannot stop a same-account replacement or invalidate its pending refresh/join', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await browser.js(
      "fixture.oldLogout=fixture.auth.logout;fixture.server=fixture.state('b');fixture.auth.refresh()",
    );
    await browser.wait(
      "fixture.auth.state.csrfToken==='b' && !!fixture.call && fixture.active===1",
    );
    await browser.js(
      "fixture.replacement=fixture.call.controls;fixture.call.controls.selectInput('synthetic-mic');fixture.call.controls.selectOutput('synthetic-output')",
    );
    await browser.js(
      "fixture.observe(fixture.call.controls.join('room'),'replacementJoin');fixture.holdMe=true;fixture.refreshing=fixture.auth.refresh();void 0",
    );
    await browser.wait(
      "fixture.joins.length===1 && fixture.call.voice.status==='joining' && !!fixture.me",
    );
    expect(
      await browser.js("fixture.observe(fixture.oldLogout(),'staleIntent');fixture.active"),
    ).toBe(1);
    await browser.wait("fixture.staleIntent==='resolved'");
    expect(await browser.js('fixture.logouts.length')).toBe(0);
    expect(
      await browser.js(
        "fixture.call.controls===fixture.replacement && fixture.call.voice.status==='joining' && fixture.replacementJoin===undefined",
      ),
    ).toBe(true);
    await browser.js(
      "const next=fixture.state('b');next.user.displayName='Fresh replacement';fixture.respond(fixture.me,next)",
    );
    await browser.wait("fixture.auth.state.user.displayName==='Fresh replacement'");
    expect(
      await browser.js(
        "fixture.call.controls===fixture.replacement && fixture.call.voice.status==='joining' && fixture.captureCalls===0",
      ),
    ).toBe(true);
    // The replacement's current intention must still stop immediately.
    expect(
      await browser.js("fixture.observe(fixture.auth.logout(),'currentIntent');fixture.active"),
    ).toBe(0);
    await browser.wait(
      "fixture.logouts.length===1 && fixture.replacementJoin==='Voice session ended.'",
    );
    expect(await browser.js("fixture.calls.find(c=>c.path==='/api/auth/logout').csrf")).toBe('b');
  });
});

it('keeps a same-session refreshed logout intention current and consumes it only once', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await browser.js(
      "fixture.savedLogout=fixture.auth.logout;fixture.savedControls=fixture.call.controls;fixture.server.user.displayName='Updated fixture';fixture.auth.refresh()",
    );
    await browser.wait("fixture.auth.state.user.displayName==='Updated fixture'");
    expect(await browser.js('fixture.call.controls===fixture.savedControls')).toBe(true);
    expect(
      await browser.js(
        "fixture.observe(fixture.savedLogout(),'firstLogout');fixture.observe(fixture.savedLogout(),'duplicateLogout');fixture.active",
      ),
    ).toBe(0);
    await browser.wait("fixture.logouts.length===1 && fixture.duplicateLogout==='resolved'");
    expect(
      await browser.js("fixture.calls.filter(c=>c.path==='/api/auth/logout').map(c=>c.csrf)"),
    ).toEqual(['a']);
    await browser.js('fixture.respond(fixture.logouts[0],{ok:true})');
    await browser.wait(
      "fixture.firstLogout==='resolved' && !!document.querySelector('[name=password]')",
    );
    expect(await browser.js('fixture.logouts.length')).toBe(1);
  });
});

it('a failed logout ends its intention even when fresh verification returns the same credentials', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    expect(
      await browser.js(
        "fixture.oldLogout=fixture.auth.logout;fixture.observe(fixture.oldLogout(),'failedLogout');fixture.active",
      ),
    ).toBe(0);
    await browser.wait('fixture.logouts.length===1');
    await browser.js("fixture.respond(fixture.logouts[0],{error:'Synthetic logout failure'},503)");
    await browser.wait("fixture.failedLogout==='resolved' && fixture.active===1 && !!fixture.call");
    await browser.js('fixture.recovered=fixture.call.controls');
    await browser.js('fixture.oldLogout()');
    expect(
      await browser.js(
        'fixture.active===1 && fixture.call.controls===fixture.recovered && fixture.logouts.length===1',
      ),
    ).toBe(true);
    expect(await browser.js("fixture.call.voice.status==='idle' && fixture.joins.length===0")).toBe(
      true,
    );
    expect(
      await browser.js("fixture.observe(fixture.auth.logout(),'freshLogout');fixture.active"),
    ).toBe(0);
    await browser.wait('fixture.logouts.length===2');
    await browser.js('fixture.respond(fixture.logouts[1],{ok:true})');
    await browser.wait(
      "fixture.freshLogout==='resolved' && !!document.querySelector('[name=password]')",
    );
  });
});

it('unmounted auth callbacks cannot send logout work or stop a newly mounted owner', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await browser.js('fixture.unmountedLogout=fixture.auth.logout;fixture.root.unmount()');
    expect(await browser.js('fixture.active')).toBe(0);
    await browser.js('fixture.unmountedLogout()');
    expect(await browser.js('fixture.logouts.length')).toBe(0);
    await browser.js('fixture.mount()');
    await browser.wait('fixture.active===1 && !!fixture.call');
    await browser.js('fixture.newControls=fixture.call.controls');
    await browser.js('fixture.unmountedLogout()');
    expect(
      await browser.js(
        'fixture.active===1 && fixture.call.controls===fixture.newControls && fixture.logouts.length===0',
      ),
    ).toBe(true);
  });
});

it('a verified missing-session response ends the old logout lifetime even if the cookie is later restored', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await browser.js(
      'fixture.oldLogout=fixture.auth.logout;fixture.refreshAuth=fixture.auth.refresh;fixture.server=null;fixture.auth.refresh()',
    );
    await browser.wait("fixture.active===0 && !!document.querySelector('[name=password]')");
    await browser.js("fixture.server=fixture.state('a');fixture.refreshAuth()");
    await browser.wait('fixture.active===1 && !!fixture.call');
    await browser.js('fixture.oldLogout()');
    expect(await browser.js('fixture.active===1 && fixture.logouts.length===0')).toBe(true);
  });
});

it.each(['pending', 'rejected'] as const)(
  'current %s accounts can still log out without a voice owner',
  async (status) => {
    await mountedFixture(async (browser) => {
      await browser.wait(`!!document.querySelector('[data-account-status=${status}]')`);
      expect(await browser.js('fixture.active')).toBe(0);
      await browser.js("document.querySelector('button.text-button').click()");
      await browser.wait('fixture.logouts.length===1');
      expect(await browser.js("fixture.calls.find(c=>c.path==='/api/auth/logout').csrf")).toBe('a');
      await browser.js('fixture.respond(fixture.logouts[0],{ok:true})');
      await browser.wait("!!document.querySelector('[name=password]')");
      expect(await browser.js('fixture.active===0 && fixture.captureCalls===0')).toBe(true);
    }, status);
  },
);

it('owns one approved-session call across actual React mounts, logout, replacement, suspension and pending work', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && window.fixture.active===1');
    expect(await browser.js('fixture.captureCalls')).toBe(0);
    await browser.js('fixture.original=fixture.call.controls; fixture.toggle()');
    await browser.wait("document.body.textContent.includes('View changed')");
    expect(await browser.js('fixture.original===fixture.call.controls && fixture.active===1')).toBe(
      true,
    );
    const created = await browser.js('fixture.created');
    await browser.js('fixture.toggle()');
    await browser.wait("!!document.querySelector('.voice-panel')");
    expect(await browser.js('fixture.created')).toBe(created);
    expect(await browser.js('Object.keys(fixture.call.controls).sort().join(",")')).toBe(
      'deafen,devices,join,leave,mute,refreshDevices,resumeAudio,selectInput,selectOutput,setOutputVolume,volume',
    );
    expect(
      await browser.js(
        'Object.isFrozen(fixture.call.voice) && Object.isFrozen(fixture.call.voice.participants)',
      ),
    ).toBe(true);

    await browser.js(
      "fixture.call.controls.selectInput('synthetic-mic');fixture.call.controls.selectOutput('synthetic-output');fixture.observe(fixture.call.controls.join('room'),'joinResult')",
    );
    await browser.wait("fixture.joins.length===1 && fixture.call.voice.status==='joining'");
    await browser.js(
      'fixture.oldAuthState=fixture.auth.state;fixture.holdMe=true;fixture.oldRefresh=fixture.auth.refresh();void 0',
    );
    await browser.wait('!!fixture.me');
    // Logout invalidates synchronously, before its HTTP request settles or React unmounts the view.
    expect(
      await browser.js("fixture.observe(fixture.auth.logout(),'logoutResult');fixture.active"),
    ).toBe(0);
    await browser.wait("fixture.joinResult==='Voice session ended.' && fixture.logouts.length===1");
    expect(
      await browser.js('(()=>{try{fixture.original.mute();return false}catch{return true}})()'),
    ).toBe(true);
    await browser.js(
      "fixture.oldAuthState.csrfToken='mutated-fixture';fixture.respond(fixture.me,fixture.state('a'));fixture.respond(fixture.joins[0],{id:'old-lease',channelId:'room',credential:'synthetic'});",
    );
    await browser.wait("fixture.calls.some(c=>c.path==='/api/voice/leave')");
    expect(await browser.js("fixture.calls.find(c=>c.path==='/api/voice/leave').csrf")).toBe('a');
    expect(await browser.js('fixture.active===0 && fixture.captureCalls===0')).toBe(true);
    // Even a fresh /me while logout is pending must not recreate the old owner.
    await browser.js('fixture.auth.refresh()');
    expect(await browser.js('fixture.active')).toBe(0);

    await browser.js('fixture.server=null;fixture.auth.refresh()');
    await browser.wait("!!document.querySelector('[name=password]')");
    await browser.js("fixture.server=fixture.state('b');fixture.signIn()");
    await browser.wait(
      "fixture.auth.state.csrfToken==='b' && fixture.active===1 && !!fixture.call",
    );
    await browser.js(
      'fixture.replacement=fixture.call.controls;fixture.respond(fixture.logouts[0],{ok:true})',
    );
    await browser.wait("fixture.logoutResult==='resolved'");
    expect(
      await browser.js(
        "fixture.auth.state.csrfToken==='b' && fixture.replacement===fixture.call.controls && fixture.active===1",
      ),
    ).toBe(true);
    await browser.js('fixture.auth.refresh()');
    expect(await browser.js('fixture.replacement===fixture.call.controls')).toBe(true);

    // Same-account /me session replacement must replace ownership even with no view remount.
    await browser.js("fixture.server=fixture.state('c');fixture.auth.refresh()");
    await browser.wait(
      "fixture.auth.state.csrfToken==='c' && fixture.call?.controls!==fixture.replacement && fixture.active===1",
    );
    expect(
      await browser.js(
        "(()=>{try{fixture.replacement.volume('someone',.5);return false}catch{return true}})()",
      ),
    ).toBe(true);
    await browser.js("fixture.observe(fixture.call.controls.devices(),'devicesResult')");
    await browser.wait('fixture.captureCalls===1');
    await browser.js("fixture.server=fixture.state('c','pending');fixture.auth.refresh()");
    await browser.wait(
      "fixture.active===0 && fixture.devicesResult==='Voice session ended.' && !!document.querySelector('[data-account-status=pending]')",
    );
    await browser.js('fixture.finishCapture()');
    await browser.wait('fixture.stopped===1');
    expect(await browser.js('fixture.active')).toBe(0);

    // Restore only on another verified response; owner unmount disposes its own pending join.
    await browser.js("fixture.server=fixture.state('d');fixture.auth.refresh()");
    await browser.wait(
      "fixture.auth.state.csrfToken==='d' && fixture.active===1 && !!fixture.call",
    );
    // Failed logout stays stopped until /me verifies again, with no implicit rejoin.
    expect(
      await browser.js("fixture.observe(fixture.auth.logout(),'failedLogout');fixture.active"),
    ).toBe(0);
    await browser.wait('fixture.logouts.length===2');
    await browser.js("fixture.respond(fixture.logouts[1],{error:'Synthetic logout failure'},503)");
    await browser.wait("fixture.failedLogout==='resolved' && fixture.active===1 && !!fixture.call");
    expect(await browser.js("fixture.call.voice.status==='idle' && fixture.joins.length===1")).toBe(
      true,
    );
    // A late native discovery rejection is observed after logical cancellation.
    await browser.js(
      "fixture.observe(fixture.call.controls.devices(),'failedDevices');fixture.observe(fixture.auth.logout(),'staleLogoutFailure')",
    );
    await browser.wait(
      "fixture.failedDevices==='Voice session ended.' && fixture.logouts.length===3",
    );
    await browser.js(
      "fixture.capture.reject(Error('Synthetic late native failure'));fixture.server=null;fixture.auth.refresh()",
    );
    await browser.wait("!!document.querySelector('[name=password]')");
    await browser.js("fixture.server=fixture.state('e');fixture.signIn()");
    await browser.wait(
      "fixture.auth.state.csrfToken==='e' && fixture.active===1 && !!fixture.call",
    );
    await browser.js("fixture.respond(fixture.logouts[2],{error:'Old logout failed'},503)");
    await browser.wait("fixture.staleLogoutFailure==='resolved'");
    expect(
      await browser.js(
        "fixture.auth.state.csrfToken==='e' && fixture.active===1 && !document.body.textContent.includes('Old logout failed')",
      ),
    ).toBe(true);
    await browser.js(
      "fixture.call.controls.selectInput('synthetic-mic');fixture.call.controls.selectOutput('synthetic-output')",
    );
    await browser.js(
      "fixture.observe(fixture.call.controls.join('room'),'disposedJoin');fixture.root.unmount()",
    );
    await browser.wait(
      "fixture.active===0 && fixture.disposedJoin==='Voice session ended.' && fixture.joins.length===2",
    );
    await browser.js('fixture.mount()');
    await browser.wait('fixture.active===1 && !!fixture.call');
    await browser.js(
      "fixture.respond(fixture.joins[1],{id:'disposed-lease',channelId:'room',credential:'synthetic'});",
    );
    await browser.wait(
      "fixture.calls.some(c=>c.path==='/api/voice/leave' && JSON.parse(c.body).leaseId==='disposed-lease')",
    );
    expect(
      await browser.js(
        "fixture.active===1 && fixture.call.voice.status==='idle' && fixture.captureCalls===2 && fixture.stopped===1",
      ),
    ).toBe(true);
    await browser.js('fixture.root.unmount()');
    expect(await browser.js('fixture.active')).toBe(0);
    expect(await browser.js('fixture.errors')).toEqual([]);
  });
}, 60_000);
