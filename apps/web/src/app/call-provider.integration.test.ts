import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { launch } from '../../../api/src/voice/browser-harness';
import { previewFixture } from './call-preview-fixture.integration';

it('does not restore a session from verification completed after successful logout', async () => {
  await mountedFixture(async (browser) => {
    await browser.wait('!!window.fixture?.call && fixture.active===1');
    await browser.js("fixture.observe(fixture.auth.logout(),'logoutResult')");
    await browser.wait('fixture.logouts.length===1');
    await browser.js('fixture.holdMe=true;void fixture.auth.refresh()');
    await browser.wait('!!fixture.me');
    await browser.js('fixture.server=null;fixture.respond(fixture.logouts[0],{ok:true})');
    await browser.wait("!!document.querySelector('[name=password]')");
    await browser.js('fixture.respond(fixture.me,fixture.state())');
    await browser.js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    expect(
      await browser.js(
        "({signedOut:!!document.querySelector('[name=password]'),active:fixture.active,calls:fixture.calls.map(c=>c.path)})",
      ),
    ).toMatchObject({ signedOut: true, active: 0 });
    expect(await browser.js('fixture.errors')).toEqual([]);
  });
});

const runtimeFixture = previewFixture
  .replace(
    'const injected=true, factoryFailure=false;',
    `
import { ScreenRuntime } from '/src/features/screen-sharing/screen-runtime.ts';
import { ScreenBindingOwner } from '/src/features/screen-sharing/screen-binding.ts';
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
import { AuthRoot, useAuth } from '/src/app/Auth.tsx';
import { useCall } from '/src/app/CallProvider.tsx';
import { VoicePanel } from '/src/features/voice/VoicePanel.tsx';
const deferred=()=>{let resolve,reject; const promise=new Promise((r,e)=>{resolve=r;reject=e});return {promise,resolve,reject}};
const f=window.fixture={active:0, created:0, captureCalls:0, captures:[], enumerateCalls:0, enumerations:[], deviceList:[], stopped:0, calls:[], joins:[], logouts:[], errors:[], channelId:'90d27181-8af8-4ea4-b3a9-e32805758484',leaseId:'c7e52d31-a9ee-4b6b-a088-521243578fb3'};
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
 if(path==='/api/account/sessions') return response({sessions:[]});
 if(path==='/api/admin/accounts') return response({users:[]});
 if(path==='/api/admin/history') return response({history:[]});
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
    root: fileURLToPath(new URL('../..', import.meta.url)),
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
              '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/__call-fixture.js"></script>',
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
          f.settingsRequests?.forEach(d=>f.respond(d,{sessions:[]}));
          f.accountSaves?.forEach(d=>f.respond(d,{error:'Fixture closed'},503));
          f.logins?.forEach(d=>f.respond(d,{error:'Fixture closed'},503));
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
  await browser.js("fixture.auth.openSettings('voice')");
  await browser.wait('!!document.querySelector(\'[aria-label="Voice microphone"]\')');
}

it('persists microphone processing per account without idle capture and distinguishes requested from applied settings', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call');
      await audioControls(browser);
      expect(await browser.js('fixture.captureCalls')).toBe(0);
      await browser.click('Raw microphone');
      await browser.wait(
        "[...document.querySelectorAll('.voice-processing input[type=checkbox]')].every(input=>!input.checked)",
      );
      expect(
        await browser.js(
          "JSON.parse(localStorage.getItem('rajcord.voice.processing.account')).echoCancellation",
        ),
      ).toBe(false);
      expect(await browser.js('fixture.captureCalls')).toBe(0);
      await browser.js(
        "fixture.previousCall=fixture.call;fixture.server=fixture.state('processing-replacement');fixture.auth.refresh()",
      );
      await browser.wait(
        "fixture.auth.state.csrfToken==='processing-replacement' && fixture.call && fixture.call!==fixture.previousCall",
      );
      await browser.wait(
        "document.querySelectorAll('.voice-processing input[type=checkbox]').length===3 && [...document.querySelectorAll('.voice-processing input[type=checkbox]')].every(input=>!input.checked)",
      );
      expect(await browser.js('fixture.captureCalls')).toBe(0);
      await browser.click('Standard');
      await browser.wait(
        "[...document.querySelectorAll('.voice-processing input[type=checkbox]')].every(input=>input.checked)",
      );
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.wait('!!fixture.channelController');
      await browser.js(
        'fixture.channelController.update({processingApplied:{echoCancellation:false,noiseSuppression:true}})',
      );
      await browser.wait(
        "document.querySelector('.voice-processing').textContent.includes('did not apply or report')",
      );
      expect(
        await browser.js(
          "document.querySelector('.voice-processing').textContent.includes('Applied: Not reported')",
        ),
      ).toBe(true);
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.js(
        "document.querySelector('.voice-processing').scrollIntoView({block:'center'})",
      );
      expect(
        await browser.js(
          "getComputedStyle(document.querySelector('.voice-processing-option')).display",
        ),
      ).toBe('grid');
      const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
      await mkdir('artifacts', { recursive: true });
      await writeFile(
        'artifacts/microphone-processing.png',
        Buffer.from(shot.data as string, 'base64'),
      );
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    channelFixture,
  );
});

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
    await browser.js(
      "(async()=>{await fixture.call.controls.selectInput('mic');await fixture.call.controls.selectOutput('speaker');fixture.deviceList=[];navigator.mediaDevices.dispatchEvent(new Event('devicechange'))})()",
    );
    await browser.wait('fixture.call.voice.inputMissing && fixture.call.voice.outputMissing');
    await browser.js(
      "fixture.deviceList=[{kind:'audioinput',deviceId:'mic',label:'Synthetic mic'},{kind:'audiooutput',deviceId:'speaker',label:'Synthetic speakers'}];navigator.mediaDevices.dispatchEvent(new Event('devicechange'))",
    );
    await browser.wait("fixture.call.voice.devicesStatus==='ready'");
    expect(
      await browser.js(
        "[...document.querySelectorAll('.voice-preferences select')].slice(0,2).map(select=>select.value)",
      ),
    ).toEqual(['', '']);
    expect(
      await browser.js('fixture.call.voice.inputMissing && fixture.call.voice.outputMissing'),
    ).toBe(true);
    await browser.js(
      "for(const [label,id] of [['Voice microphone','mic'],['Voice speakers','speaker']]){const select=document.querySelector('[aria-label=\"'+label+'\"]');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}))}",
    );
    await browser.wait('!fixture.call.voice.inputMissing && !fixture.call.voice.outputMissing');
    expect(await browser.js('fixture.captureCalls')).toBe(1);
    expect(await browser.js('fixture.joins.length')).toBe(0);
    expect(
      await browser.js("fixture.call.voice.input==='mic' && fixture.call.voice.output==='speaker'"),
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
        "(async()=>{fixture.saved=fixture.call.controls;fixture.staleReset=[...fixture.resets][0];await fixture.call.controls.selectInput('owned-mic');await fixture.call.controls.selectOutput('owned-output');fixture.observe(fixture.call.controls.join(fixture.channelId),'oldJoin');const field=document.createElement('textarea');field.id='reset-draft';field.value='Keep this draft';document.body.append(field);field.focus();fixture.staleReset()})()",
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
        "fixture.respond(fixture.joins[0],{id:fixture.leaseId,channelId:fixture.channelId,credential:'synthetic'})",
      );
      await browser.wait(
        "fixture.calls.some(call=>call.path==='/api/voice/leave'&&JSON.parse(call.body).leaseId===fixture.leaseId)",
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
        "[...document.querySelectorAll('.voice-preferences select')].slice(0,2).map(s=>s.value)",
      ),
    ).toEqual(['owned-mic', 'owned-output']);
    expect(
      await browser.js(
        "[...document.querySelectorAll('.voice-preferences select')].slice(0,2).map(s=>s.selectedOptions[0].textContent)",
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
    await browser.js(
      "fixture.observe(fixture.call.controls.join(fixture.channelId),'catalogJoin')",
    );
    await browser.wait("fixture.call.voice.status==='joining'");
    await browser.js('document.querySelector(\'[aria-label="Leave voice"]\').click()');
    await browser.wait("fixture.call.voice.status==='idle'");
    expect(
      await browser.js(
        "fixture.call.devices===fixture.catalog && fixture.call.voice.input==='owned-mic' && fixture.call.voice.output==='owned-output'",
      ),
    ).toBe(true);
    await browser.js(
      "fixture.respond(fixture.joins[0],{id:fixture.leaseId,channelId:fixture.channelId,credential:'synthetic'})",
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
      "fixture.observe(fixture.call.controls.join(fixture.channelId),'replacementJoin');fixture.holdMe=true;fixture.refreshing=fixture.auth.refresh();void 0",
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
    await browser.js('fixture.server=null;fixture.respond(fixture.logouts[0],{ok:true})');
    await browser.wait(
      "fixture.firstLogout==='resolved' && !!document.querySelector('[name=password]')",
    );
    expect(await browser.js('fixture.logouts.length')).toBe(1);
    await browser.js("window.dispatchEvent(new Event('focus'));fixture.auth.refresh()");
    await browser.wait(
      "fixture.firstLogout==='resolved' && !!document.querySelector('[name=password]')",
    );
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
    await browser.js('fixture.server=null;fixture.respond(fixture.logouts[1],{ok:true})');
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
      await browser.js('fixture.server=null;fixture.respond(fixture.logouts[0],{ok:true})');
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
      'deafen,devices,join,joinChannel,leave,mute,refreshDevices,resumeAudio,selectInput,selectOutput,setOutputVolume,setProcessing,volume',
    );
    expect(
      await browser.js(
        'Object.isFrozen(fixture.call.voice) && Object.isFrozen(fixture.call.voice.participants)',
      ),
    ).toBe(true);

    await browser.js(
      "fixture.call.controls.selectInput('synthetic-mic');fixture.call.controls.selectOutput('synthetic-output');fixture.observe(fixture.call.controls.join(fixture.channelId),'joinResult')",
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
      "fixture.oldAuthState.csrfToken='mutated-fixture';fixture.respond(fixture.me,fixture.state('a'));fixture.respond(fixture.joins[0],{id:fixture.leaseId,channelId:fixture.channelId,credential:'synthetic'});",
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
      "fixture.observe(fixture.call.controls.join(fixture.channelId),'disposedJoin');fixture.root.unmount()",
    );
    await browser.wait(
      "fixture.active===0 && fixture.disposedJoin==='Voice session ended.' && fixture.joins.length===2",
    );
    await browser.js('fixture.mount()');
    await browser.wait('fixture.active===1 && !!fixture.call');
    await browser.js(
      "fixture.respond(fixture.joins[1],{id:fixture.leaseId,channelId:fixture.channelId,credential:'synthetic'});",
    );
    await browser.wait(
      "fixture.calls.some(c=>c.path==='/api/voice/leave' && JSON.parse(c.body).leaseId===fixture.leaseId)",
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

const channelFixture =
  fixture
    .replace('import { createElement', "import '/src/app/styles.ts';\nimport { createElement")
    .replace(
      'return panel?h(VoicePanel)',
      "return panel?h('aside',{className:'sidebar',style:{width:340,height:'100vh'}},h(VoicePanel))",
    )
    .replace(
      'import { VoicePanel }',
      "import { VoiceController } from '/src/features/voice/voice-controller.ts';\nimport { VoicePanel }",
    )
    .replace(
      'channels:[]',
      "channels:[{id:'lounge',name:'The lounge',participants:[]},{id:'games',name:'Games',participants:[]}]",
    ) +
  `
f.channelJoins=[];
VoiceController.prototype.join=async function(id){ f.channelJoins.push(id);f.channelController=this;this.update({status:'connected',channelId:id,muted:true,participants:[{id:'account',name:'Fixture',muted:true,speaking:false,volume:1},{id:'friend',name:'Friend',muted:false,speaking:true,volume:1}]}); };
VoiceController.prototype.volume=function(id,volume){ this.update({participants:this.state.participants.map(p=>p.id===id?{...p,volume}:p)}); };
`;

const sidebarFixture = channelFixture
  .replace(
    'import { VoicePanel }',
    "import { ActivityButton } from '/src/app/StreamActivity.tsx';\nimport { CommunitySidebar } from '/src/app/CommunitySidebar.tsx';\nimport { ApplicationSounds } from '/src/features/sounds/index.ts';\nimport { VoicePanel }",
  )
  .replace(
    'h(AuthRoot,null,h(View))',
    "h(AuthRoot,{screenApplication:application},h(ApplicationSounds,{userId:'account'},h(View)))",
  )
  .replace(
    "return panel?h('aside',{className:'sidebar',style:{width:340,height:'100vh'}},h(VoicePanel)):h('p',null,'View changed')",
    `const [dock,setDock]=useState(null),[count,setCount]=useState(1),[callOpen,setCallOpen]=useState(false);
    f.moreChannels=()=>setCount(40);f.setCallOpen=setCallOpen;
    const conversations=Array.from({length:count},(_,i)=>({id:'channel-'+i,name:'general '+i,kind:'channel',category:null,unreadCount:0,mentionCount:0,archived:false,members:[]}));
    return h('div',{className:'shell live-shell mobile-open'+(callOpen?' screen-call-open':'')},h(CommunitySidebar,{membersOpen:false,mobileOpen:false,onCloseNavigation:()=>{},categories:[],conversations,selected:'channel-0',choose:()=>{},openDialog:()=>{},invites:[],busy:false,action:async work=>work(),connected:true,onlineIds:[],voiceSession:dock,onInviteAccepted:()=>{},setVoiceChannels:()=>{},setVoiceSession:setDock,voiceNavigation:null}),h('main',{className:'chat'},h(ActivityButton,{trigger:null,expanded:false,onClick:()=>{}})))`,
  )
  .replace(
    'f.mount();',
    `f.screenState={phase:'ready',open:false,prepared:false,viewers:0,shares:[{id:'demo-share'}]};
    const screenListeners=new Set();
    const setScreenOpen=open=>{f.screenState={...f.screenState,open};f.setCallOpen(open);for(const listener of screenListeners)listener()};
    f.screens={inspect:()=>f.screenState,subscribe:listener=>{screenListeners.add(listener);return ()=>screenListeners.delete(listener)},connect:async()=>{},open:async()=>setScreenOpen(true),close:()=>setScreenOpen(false),stopSource:()=>{},stopWatching:()=>{}};
    const application={runtime:{attachCall:()=>({connectVoice:()=>{},stop:()=>{},release:()=>{}})},createCall:()=>({controls:()=>f.screens,observeVoice:()=>{},stopSource:()=>{},stopWatching:()=>{},dispose:()=>{}})};
    f.mount();`,
  );

it('keeps sidebar geometry and every dock control stable when opening and closing the call view', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait(
        '!!window.fixture?.call?.screens && !!document.querySelector(".sidebar-dock")',
      );
      expect(await browser.js("document.querySelector('.members-action').textContent")).toBe('');
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.wait('!!document.querySelector(".voice-dock")');
      await browser.wait("document.querySelector('.members-action').textContent==='1 live'");
      expect(
        await browser.js("document.querySelector('.members-action').getAttribute('aria-expanded')"),
      ).toBe('false');
      const geometry = () =>
        browser.js(`(()=>{
          const sidebar=document.querySelector('.sidebar'),dock=document.querySelector('.sidebar-dock'),s=sidebar.getBoundingClientRect();
          const buttons=[...dock.querySelectorAll('button')].filter(button=>getComputedStyle(button).display!=='none');
          const actions=[...dock.querySelectorAll('.voice-dock-actions button')].filter(button=>getComputedStyle(button).display!=='none').map(button=>button.getBoundingClientRect());
          return {left:s.left,width:s.width,visible:buttons.length,inside:buttons.every(button=>{const r=button.getBoundingClientRect();return r.width>0 && r.left>=s.left && r.right<=s.right}),mediaActions:actions.length===2 && actions.every(r=>r.width>=32 && r.top===actions[0].top),overflow:sidebar.scrollWidth>sidebar.clientWidth};
        })()`);
      for (const width of [1440, 1200, 1000, 390]) {
        await browser.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 1060,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const before = await geometry();
        expect(before).toMatchObject({ inside: true, mediaActions: true, overflow: false });
        await browser.js(
          'document.querySelector(\'[aria-label="Browse shared screens"]\').click()',
        );
        await browser.wait(
          "document.querySelector('.shell').classList.contains('screen-call-open')",
        );
        expect(await geometry()).toEqual(before);
        if (width === 1000) {
          const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
          await mkdir('artifacts', { recursive: true });
          await writeFile(
            'artifacts/sidebar-call-open.png',
            Buffer.from(shot.data as string, 'base64'),
          );
        }
        await browser.js('fixture.screens.close()');
        await browser.wait(
          "!document.querySelector('.shell').classList.contains('screen-call-open')",
        );
        expect(await geometry()).toEqual(before);
      }
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    sidebarFixture,
  );
});

it('offers separate touch targets for muting, deafening, sharing and leaving from phone chat', async () => {
  const phoneFixture = sidebarFixture
    .replace(
      'import { CommunitySidebar }',
      "import { MobileVoiceControls } from '/src/app/VoiceDock.tsx';\nimport { CommunitySidebar }",
    )
    .replace(
      "h('main',{className:'chat'},h(ActivityButton",
      "h('main',{className:'chat'},h(MobileVoiceControls,{voiceSession:dock,callOpen}),h(ActivityButton",
    )
    .replace('open:async()=>setScreenOpen(true)', 'open:async setup=>{f.openedSetup=setup}')
    .replace(
      'VoiceController.prototype.volume=',
      'VoiceController.prototype.deafen=async function(){this.update({deafened:!this.state.deafened})};VoiceController.prototype.volume=',
    );
  await mountedFixture(
    async (browser) => {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.wait('!!window.fixture?.call?.screens');
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.wait("!!document.querySelector('.mobile-call-controls')");
      await browser.js("document.querySelector('.shell').classList.remove('mobile-open')");
      expect(
        await browser.js(`(() => {
      const buttons = [...document.querySelectorAll('.mobile-call-controls button')];
      const boxes = buttons.map(button=>button.getBoundingClientRect());
      return buttons.map(button=>button.getAttribute('aria-label')).join(',')==='Open call view,Unmute microphone,Deafen,Share screen,Leave voice' &&
        buttons.at(-1).innerText.trim()==='Leave voice' && boxes.every(box=>box.width>=32 && box.height>=36 &&
          box.left>=0 && box.right<=innerWidth && Math.abs(box.top-boxes[0].top)<1);
    })()`),
      ).toBe(true);
      await browser.js(
        `document.querySelector('.mobile-call-controls [aria-label="Deafen"]').click()`,
      );
      await browser.wait(
        `!!document.querySelector('.mobile-call-controls [aria-label="Enable audio"][aria-pressed=true]')`,
      );
      await browser.js(
        `document.querySelector('.mobile-call-controls [aria-label="Share screen"]').click()`,
      );
      await browser.wait('fixture.openedSetup===true');
      await browser.js(
        `document.querySelector('.mobile-call-controls [aria-label="Open call view"]').click()`,
      );
      await browser.wait('fixture.openedSetup===false');
      await browser.js(
        `document.querySelector('.mobile-call-controls [aria-label="Leave voice"]').click()`,
      );
      await browser.wait(
        "fixture.call.voice.status==='idle' && !document.querySelector('.mobile-call-controls')",
      );
    },
    'approved',
    phoneFixture,
  );
});

it('dismisses participant volume before closing mobile navigation with Escape', async () => {
  const mobileFixture = sidebarFixture
    .replace(
      '[callOpen,setCallOpen]=useState(false)',
      '$&,[mobileOpen,setMobileOpen]=useState(true)',
    )
    .replace("mobile-open'+(callOpen", "'+(mobileOpen?'mobile-open':'')+(callOpen")
    .replace(
      'mobileOpen:false,onCloseNavigation:()=>{}',
      'mobileOpen,onCloseNavigation:()=>setMobileOpen(false)',
    );
  await mountedFixture(
    async (browser) => {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.wait('!!window.fixture?.call?.screens');
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.wait("!!document.querySelector('.voice-member:not(:disabled)')");
      await browser.js(`fixture.volumeTrigger = document.querySelector('.voice-member:not(:disabled)');
        fixture.volumeTrigger.focus();
        fixture.volumeTrigger.click();`);
      await browser.wait("document.activeElement.matches('.voice-participant-popup input')");
      const escape = {
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      };
      await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', ...escape });
      await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', ...escape });
      await browser.wait("!document.querySelector('.voice-participant-popup')");
      expect(
        await browser.js(`document.querySelector('.sidebar').getAttribute('aria-modal') === 'true' &&
          document.activeElement === fixture.volumeTrigger`),
      ).toBe(true);
      await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', ...escape });
      await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', ...escape });
      await browser.wait("!document.querySelector('.sidebar').hasAttribute('aria-modal')");
    },
    'approved',
    mobileFixture,
  );
});

it('anchors the profile and voice dock to the sidebar bottom without narrow-layout overflow', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!document.querySelector(".sidebar-dock") && !!fixture.call');
      const geometry = () =>
        browser.js(`(()=>{
          const sidebar=document.querySelector('.sidebar'),dock=document.querySelector('.sidebar-dock'),profile=document.querySelector('.profile'),status=document.querySelector('.profile-identity small');
          const s=sidebar.getBoundingClientRect(),d=dock.getBoundingClientRect(),p=profile.getBoundingClientRect();
          return {bottom:Math.abs(s.bottom-d.bottom)<2,inside:p.left>=s.left && p.right<=s.right,overflow:sidebar.scrollWidth>sidebar.clientWidth,statusHeight:status.getBoundingClientRect().height};
        })()`) as Promise<{
          bottom: boolean;
          inside: boolean;
          overflow: boolean;
          statusHeight: number;
        }>;
      for (const [width, height] of [
        [1440, 1060],
        [1000, 800],
        [390, 844],
      ]) {
        await browser.call('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        expect(await geometry()).toMatchObject({ bottom: true, inside: true, overflow: false });
      }
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.wait('!!document.querySelector(".voice-dock")');
      for (const width of [1440, 1000, 390]) {
        await browser.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 1060,
          deviceScaleFactor: 1,
          mobile: false,
        });
        expect(await geometry()).toMatchObject({ bottom: true, inside: true, overflow: false });
        expect((await geometry()).statusHeight).toBeLessThan(18);
      }
      const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
      await mkdir('artifacts', { recursive: true });
      await writeFile('artifacts/sidebar-bottom.png', Buffer.from(shot.data as string, 'base64'));
      await browser.js('fixture.moreChannels()');
      await browser.wait('document.querySelectorAll(".channel-category button").length===40');
      expect(await geometry()).toMatchObject({ bottom: true, inside: true, overflow: false });
      await browser.js("document.querySelector('.sidebar').scrollTop=10000");
      expect(await geometry()).toMatchObject({ bottom: true, inside: true, overflow: false });
      await browser.js(
        "document.querySelector('button[aria-controls=navigation-channels]').click()",
      );
      await browser.wait("document.querySelector('#navigation-channels').hidden");
      expect(
        await browser.js("document.querySelector('#navigation-direct').checkVisibility()"),
      ).toBe(true);
      expect(
        await browser.js("document.querySelector('#navigation-voice').checkVisibility()"),
      ).toBe(true);
      expect(await geometry()).toMatchObject({ bottom: true, inside: true, overflow: false });
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    sidebarFixture,
  );
});

it('joins and switches with channel clicks, keeps device settings separate and exposes participant volume on click/right-click', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait("!!document.querySelector('[data-voice-channel-id=lounge]')");
      expect(
        await browser.js('!!document.querySelector(\'[aria-label="Voice microphone"]\')'),
      ).toBe(false);
      await browser.js(
        "fixture.deviceList=[{kind:'audioinput',deviceId:'mic',label:'Microphone',groupId:'m'},{kind:'audioinput',deviceId:'default',groupId:'m',label:'Synthetic device'},{kind:'audiooutput',deviceId:'speaker',label:'Speakers',groupId:'s'},{kind:'audiooutput',deviceId:'default',groupId:'s',label:'Synthetic device'}];document.querySelector('[data-voice-channel-id=lounge]').click()",
      );
      await browser.wait('fixture.captureCalls===1');
      await browser.js('fixture.finishCapture()');
      await browser.wait("fixture.call.voice.channelId==='lounge'");
      expect(
        await browser.js(
          "fixture.call.voice.muted && fixture.call.voice.input==='mic' && fixture.call.voice.output==='speaker'",
        ),
      ).toBe(true);
      expect(await browser.js("!!document.querySelector('.voice-controls')")).toBe(false);
      await browser.js("document.querySelector('.voice-member:not([disabled])').click()");
      await browser.wait("!!document.querySelector('.voice-participant-popup input')");
      await browser.js(
        "(()=>{const s=document.querySelector('.voice-participant-popup input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'0.25');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}))})()",
      );
      await browser.wait("fixture.call.voice.participants.find(p=>p.id==='friend').volume===.25");
      await browser.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
      });
      await browser.wait("!document.querySelector('.voice-participant-popup')");
      await browser.js(
        "document.querySelector('.voice-member:not([disabled])').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))",
      );
      await browser.wait("!!document.querySelector('.voice-participant-popup input')");
      const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
      await mkdir('artifacts', { recursive: true });
      await writeFile('artifacts/voice-sidebar.png', Buffer.from(shot.data as string, 'base64'));
      await browser.js(
        "document.querySelector('[aria-label=\"Close user volume\"]').click();document.querySelector('[data-voice-channel-id=games]').click()",
      );
      await browser.wait('fixture.captureCalls===2');
      await browser.js('fixture.finishCapture()');
      await browser.wait("fixture.call.voice.channelId==='games'");
      expect(await browser.js('fixture.channelJoins')).toEqual(['lounge', 'games']);
      await browser.js("fixture.auth.openSettings('voice')");
      await browser.wait("!!document.querySelector('.voice-preferences select')");
      expect(
        await browser.js('document.querySelector(\'[aria-label="Voice microphone"]\').value'),
      ).toBe('mic');
      await browser.js(
        "document.querySelector('[aria-label=\"Close settings\"]').click();fixture.deviceList=fixture.deviceList.filter(d=>d.deviceId!=='mic');document.querySelector('[data-voice-channel-id=lounge]').click()",
      );
      await browser.wait('fixture.captureCalls===3');
      await browser.js('fixture.finishCapture()');
      await browser.wait("document.body.textContent.includes('unavailable')");
      expect(await browser.js('fixture.channelJoins')).toEqual(['lounge', 'games']);
      expect(await browser.js('fixture.call.voice.channelId')).toBe('games');
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    channelFixture,
  );
});
it('leaving during discovery cancels the channel switch before it can rejoin', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call');
      await browser.js(
        "fixture.deviceList=[{kind:'audioinput',deviceId:'mic',label:'Synthetic device',groupId:'m'},{kind:'audiooutput',deviceId:'speaker',label:'Synthetic device',groupId:'s'}];fixture.observe(fixture.call.controls.joinChannel('lounge'),'attempt')",
      );
      await browser.wait('fixture.captureCalls===1');
      await browser.js('fixture.call.controls.leave();fixture.finishCapture()');
      await browser.wait("fixture.attempt==='Voice channel change cancelled.'");
      expect(await browser.js('fixture.channelJoins')).toEqual([]);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    channelFixture,
  );
});

const screenUiFixture = channelFixture
  .replace(
    'import { VoicePanel }',
    "import { ScreenPanel } from '/src/features/screen-sharing/ScreenPanel.tsx';\nimport { VoicePanel }",
  )
  .replace(
    "h('aside',{className:'sidebar',style:{width:340,height:'100vh'}},h(VoicePanel))",
    "h('div',{className:'fixture-shell live-shell screen-call-open'},h('aside',{className:'sidebar'},h(VoicePanel)),h('main',{className:'chat'},h(ScreenPanel,{voiceChannels:[{id:'lounge',name:'The lounge'}]})))",
  )
  .replace('h(AuthRoot,null,h(View))', 'h(AuthRoot,{screenApplication:application},h(View))')
  .replace(
    'f.mount();',
    `
const style=document.createElement('style');style.textContent='.fixture-shell.live-shell{display:grid;height:100vh;grid-template-columns:260px minmax(0,1fr)}.fixture-shell .chat{position:relative;min-height:0}@media(max-width:750px){.fixture-shell.live-shell{grid-template-columns:minmax(0,1fr)}.fixture-shell>.sidebar{display:none}}';document.head.append(style);
const shares=[{id:'first',publisherId:'friend',resolution:1080,frameRate:60,sound:'none'},{id:'second',publisherId:'other',resolution:720,frameRate:30,sound:'none'}];
let screenState={phase:'ready',error:'',shares,watching:'first',watchingShareIds:['first'],selectingShareId:null,layout:'focus',playback:'Playing',playbackMuted:false,playbackVolume:1,hidden:false,label:'',viewers:0,open:true,prepared:false,ownShareId:null};
const screenListeners=new Set();let screenHost;
const poster=(name,color)=>{const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');const gradient=ctx.createLinearGradient(0,0,1280,720);gradient.addColorStop(0,color);gradient.addColorStop(1,'#101116');ctx.fillStyle=gradient;ctx.fillRect(0,0,1280,720);ctx.fillStyle='#ffffff';ctx.font='40px sans-serif';ctx.fillText(name,70,350);return canvas.toDataURL()};
const renderScreens=()=>{if(!screenHost)return;screenHost.replaceChildren();screenHost.dataset.layout=screenState.layout;for(const id of screenState.watchingShareIds){const tile=document.createElement('div');tile.className='screen-incoming-tile';tile.dataset.screenShareId=id;tile.dataset.focused=String(screenState.watching===id);tile.tabIndex=0;tile.setAttribute('role','button');const video=document.createElement('video');video.poster=poster(id==='first'?'SYNTHETIC DESIGN PREVIEW':'SECOND SYNTHETIC STREAM',id==='first'?'#385b63':'#654865');const label=document.createElement('span');label.className='screen-incoming-label';label.textContent=id==='first'?"Friend's screen":"Participant's screen";tile.append(video,label);screenHost.append(tile)}};
f.screenSet=patch=>{screenState={...screenState,...patch};renderScreens();for(const fn of screenListeners)fn()};
f.screenActions=[];
f.screens={inspect:()=>screenState,subscribe:fn=>{screenListeners.add(fn);return ()=>screenListeners.delete(fn)},connect:async()=>{},open:async(setupRequested=false)=>f.screenSet({open:true,setupRequested}),close:()=>{f.screens.stopWatching();f.screenSet({open:false})},preview:()=>()=>{},incoming:host=>{screenHost=host;renderScreens();return ()=>{if(screenHost===host)screenHost=undefined}},
watch:async(id)=>{f.screenActions.push(['replace',id]);f.screenSet({watching:id,watchingShareIds:[id],layout:'focus'})},
watchMultiple:async(id)=>{f.screenActions.push(['add',id]);f.screenSet({watching:id,watchingShareIds:[...new Set([...screenState.watchingShareIds,id])],layout:'focus'})},
focusWatch:id=>{f.screenActions.push(['focus',id]);f.screenSet({watching:id,layout:'focus'})},zoomOutWatch:()=>f.screenSet({layout:'grid'}),
stopWatchingShare:id=>f.screenSet({watchingShareIds:screenState.watchingShareIds.filter(item=>item!==id),watching:screenState.watchingShareIds.find(item=>item!==id)??null}),stopWatching:()=>f.screenSet({watching:null,watchingShareIds:[]}),stopSource:()=>{},prepare:async()=>{},choose:async()=>{},publish:async()=>{},play:async()=>{},mute:value=>f.screenSet({playbackMuted:value}),volume:value=>f.screenSet({playbackVolume:value})};
const application={runtime:{attachCall:()=>({connectVoice:()=>{},stop:()=>{},release:()=>{}})},createCall:()=>({controls:()=>f.screens,observeVoice:()=>{},stopSource:()=>{},stopWatching:()=>{},dispose:()=>{}})};
f.mount();`,
  );

it('returns focus to the mobile dock action that opened the call view', async () => {
  const mobileFixture = screenUiFixture
    .replace('StrictMode, useState }', 'StrictMode, useState, useSyncExternalStore }')
    .replace(
      'import { ScreenPanel }',
      "import { MobileVoiceControls } from '/src/app/VoiceDock.tsx';\nimport { ScreenPanel }",
    )
    .replace('open:true,prepared:false', 'open:false,prepared:false')
    .replace(
      "return panel?h('div'",
      "const callOpen=useSyncExternalStore(f.screens.subscribe,()=>f.screens.inspect().open);return panel?h('div'",
    )
    .replace(
      "h('main',{className:'chat'},h(ScreenPanel",
      "h('main',{className:'chat'},h(MobileVoiceControls,{voiceSession:{status:'connected',channelName:'The lounge'},callOpen}),h(ScreenPanel",
    );
  await mountedFixture(
    async (browser) => {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.wait("!!document.querySelector('.mobile-call-room')");
      const room = '.mobile-call-room';
      const share = '.mobile-call-share';
      for (const step of [
        { action: room, expected: room },
        { action: share, expected: share },
        { action: share, expected: room, connecting: true },
      ]) {
        await browser.wait(`document.querySelector('${step.action}:enabled')?.checkVisibility()`);
        await browser.js(`fixture.openAction = document.querySelector('${step.action}');
          fixture.openAction.focus();
          fixture.openAction.click();`);
        expect(
          await browser.js(`({
            open: fixture.screens.inspect().open,
            phase: fixture.screens.inspect().phase,
            disabled: fixture.openAction.disabled
          })`),
          JSON.stringify(step),
        ).toMatchObject({ open: true });
        const initialFocus = step.action === share ? '.screen-settings-close' : '.screen-close';
        await browser.wait(`document.activeElement.matches('${initialFocus}')`);
        expect(await browser.js('!fixture.openAction.checkVisibility()')).toBe(true);
        if (step.connecting) await browser.js("fixture.screenSet({phase:'connecting'})");
        await browser.js("document.querySelector('.screen-close').click()");
        await browser.wait("!document.querySelector('.screen-panel')");
        expect(await browser.js(`document.activeElement.matches('${step.expected}')`)).toBe(true);
      }
    },
    'approved',
    mobileFixture,
  );
});

const workspaceScreenFixture = screenUiFixture
  .replace(
    'import { ScreenPanel }',
    "import { App } from '/src/app/App.tsx';\nimport { ScreenPanel }",
  )
  .replace('open:true,prepared:false', 'open:false,prepared:false')
  .replace(
    "shares,watching:'first',watchingShareIds:['first']",
    'shares,watching:null,watchingShareIds:[]',
  )
  .replace(
    'h(AuthRoot,{screenApplication:application},h(View))',
    'h(App,{screenApplication:application})',
  )
  .replace(
    "if(path==='/api/account/sessions')",
    `if(path==='/api/conversations') return response({conversations:[]});
 if(path==='/api/invitations') return response({invitations:[]});
 if(path==='/api/members') return response({users:[]});
 if(path==='/api/channel-categories') return response({categories:[],nextAfter:null});
 if(path==='/api/account/sessions')`,
  )
  .replace(
    'const style=document.createElement',
    "localStorage.setItem('tricord-notification-prompt:account','seen');\nconst style=document.createElement",
  );

it('returns focus to Activity after closing a call opened from its mobile drawer', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.wait("document.querySelector('.mobile-menu')?.checkVisibility()");
      await browser.js("document.querySelector('.mobile-menu').click()");
      await browser.wait("!!document.querySelector('.mobile-open [data-voice-channel-id=lounge]')");
      await browser.js(`fixture.deviceList=[
        {kind:'audioinput',deviceId:'mic',label:'Microphone',groupId:'m'},
        {kind:'audioinput',deviceId:'default',label:'Synthetic device',groupId:'m'},
        {kind:'audiooutput',deviceId:'speaker',label:'Speakers',groupId:'s'},
        {kind:'audiooutput',deviceId:'default',label:'Synthetic device',groupId:'s'}
      ];
        document.querySelector('[data-voice-channel-id=lounge]').click()`);
      await browser.wait('fixture.captureCalls===1');
      await browser.js('fixture.finishCapture()');
      await browser.wait("!!document.querySelector('.voice-dock[data-voice-status=connected]')");
      await browser.wait("document.activeElement.matches('.screen-close')");
      await browser.js("document.querySelector('.screen-close').click()");
      await browser.wait(
        "!document.querySelector('#screen-panel') && !document.querySelector('.mobile-open')",
      );

      const enter = async () => {
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
        await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
        await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      };
      await browser.js("document.querySelector('.members-action').focus()");
      await enter();
      await browser.wait(
        "document.querySelector('.stream-activity button')?.textContent.trim()==='Browse call'",
      );
      await browser.js("document.querySelector('.stream-activity button').focus()");
      await enter();
      await browser.wait("document.activeElement.matches('.screen-close')");
      expect(await browser.js("!!document.querySelector('#workspace-activity')")).toBe(false);
      await enter();
      await browser.wait("!document.querySelector('#screen-panel')");
      await browser.js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      expect(await browser.js('document.activeElement.className')).toContain('members-action');
      expect(
        await browser.js("!!document.querySelector('.voice-dock[data-voice-status=connected]')"),
      ).toBe(true);
      expect(
        await browser.js("document.querySelector('.members-action').getAttribute('aria-expanded')"),
      ).toBe('false');
    },
    'approved',
    workspaceScreenFixture.replace('shares,watching:null', 'shares:[],watching:null'),
  );
});

it('keeps focus in account settings opened from Activity and restores it on close', async () => {
  await mountedFixture(
    async (browser) => {
      const press = async (
        key: 'Enter' | 'Escape',
        windowsVirtualKeyCode: number,
        text?: string,
      ) => {
        await browser.call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code: key,
          windowsVirtualKeyCode,
          text,
        });
        await browser.call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code: key,
          windowsVirtualKeyCode,
        });
      };
      for (const width of [390, 1440]) {
        await browser.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: width === 390,
        });
        await browser.wait(
          'innerWidth===' + width + " && !!document.querySelector('.members-action')",
        );
        await browser.js("document.querySelector('.members-action').focus()");
        await press('Enter', 13, '\r');
        await browser.wait("!!document.querySelector('.activity-footer button')");
        await browser.js("document.querySelector('.activity-footer button').focus()");
        await press('Enter', 13, '\r');
        await browser.wait("!!document.querySelector('.account-panel')");
        await browser.js(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
        );
        expect(await browser.js("document.activeElement.getAttribute('aria-label')")).toBe(
          'Close settings',
        );
        expect(await browser.js("!!document.querySelector('#workspace-activity')")).toBe(false);
        await press('Escape', 27);
        await browser.wait("!document.querySelector('.account-panel')");
        expect(await browser.js("document.activeElement.matches('.members-action')")).toBe(true);
      }
    },
    'approved',
    workspaceScreenFixture,
  );
});

it('keeps call controls visible and clickable at compact workspace widths', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait("!!document.querySelector('[data-voice-channel-id=lounge]')");
      await browser.js(`fixture.deviceList=[
        {kind:'audioinput',deviceId:'mic',label:'Microphone',groupId:'m'},
        {kind:'audioinput',deviceId:'default',label:'Synthetic device',groupId:'m'},
        {kind:'audiooutput',deviceId:'speaker',label:'Speakers',groupId:'s'},
        {kind:'audiooutput',deviceId:'default',label:'Synthetic device',groupId:'s'}
      ];
      document.querySelector('[data-voice-channel-id=lounge]').click()`);
      await browser.wait('fixture.captureCalls===1');
      await browser.js('fixture.finishCapture()');
      await browser.wait(
        "!!document.querySelector('.voice-dock[data-voice-status=connected]') && !!document.querySelector('#screen-panel')",
      );
      await browser.js("fixture.screens.watch('first')");
      for (const width of [768, 320]) {
        await browser.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: width === 320,
        });
        await browser.wait('innerWidth===' + width);
        for (const phase of ['ready', 'sharing']) {
          await browser.js(`fixture.screenSet({phase:'${phase}'})`);
          await browser.js(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
          );
          const unreachable = await browser.js(`(() => {
            const panel = document.querySelector('#screen-panel');
            const bounds = panel.getBoundingClientRect();
            return [...panel.querySelectorAll('.screen-call-header button, .screen-call-toolbar button')]
              .filter(button => {
                const {left,right,top,bottom,width,height} = button.getBoundingClientRect();
                const hit = document.elementFromPoint(left + width/2, top + height/2);
                return left < bounds.left || right > bounds.right || !button.contains(hit);
              })
              .map(button => button.getAttribute('aria-label') ?? button.textContent.trim());
          })()`);
          expect(unreachable, `width ${width}, phase ${phase}`).toEqual([]);
        }
      }
    },
    'approved',
    workspaceScreenFixture,
  );
});

it('shows the whole call in a balanced grid, switches streams, adds multi-view, and opens participant volume from call tiles', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.wait(
        '!!window.fixture?.call?.screens && !!document.querySelector(".screen-incoming-tile")',
      );
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.js(
        "fixture.channelController.update({participants:[...fixture.call.voice.participants,{id:'other',name:'Other',muted:false,speaking:false,volume:1}]})",
      );
      await browser.wait("document.querySelectorAll('.screen-participant-tile').length===3");
      await browser.js("document.querySelector('.screen-incoming-tile').click()");
      await browser.wait(
        "document.querySelector('.screen-panel').dataset.layout==='grid' && document.querySelector('.screen-participant-strip').hidden",
      );
      await browser.wait(
        "[...document.querySelectorAll('.screen-media .screen-participant-tile')].every(e=>e.getBoundingClientRect().width>200)",
      );
      const geometry = await browser.js(
        `(()=>{const host=document.querySelector('.screen-media').getBoundingClientRect();const tiles=[...document.querySelectorAll('.screen-media .screen-incoming-tile,.screen-media .screen-stream-tile,.screen-media .screen-participant-tile')].map(e=>e.getBoundingClientRect());return {count:tiles.length,lastCentered:Math.abs((tiles.at(-1).left+tiles.at(-1).right)/2-(host.left+host.right)/2)<2,inside:tiles.every(r=>r.left>=host.left-1&&r.right<=host.right+1&&r.top>=host.top-1&&r.bottom<=host.bottom+1),overlap:tiles.some((a,i)=>tiles.slice(i+1).some(b=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1))}})()`,
      );
      await saveCallScreenshot(browser, 'grid-geometry');
      expect(geometry).toEqual({ count: 5, lastCentered: true, inside: true, overlap: false });
      await browser.js(
        "document.querySelector('.screen-media [data-share-id=second] .screen-stream-multi').click()",
      );
      await browser.wait(
        "fixture.screens.inspect().watchingShareIds.length===2 && document.querySelector('.screen-panel').dataset.layout==='grid'",
      );
      expect(await browser.js('fixture.screenActions')).toContainEqual(['add', 'second']);
      await browser.js(
        "document.querySelector('.screen-incoming-tile[data-screen-share-id=first]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
      );
      await browser.wait("document.querySelector('.screen-panel').dataset.layout==='focus'");
      expect(await browser.js('fixture.screens.inspect().watchingShareIds.length')).toBe(2);
      await browser.js(
        "document.querySelector('.screen-participant-tile:not([disabled])').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))",
      );
      await browser.wait("!!document.querySelector('.voice-participant-popup input')");
      expect(
        await browser.js(
          "document.activeElement===document.querySelector('.voice-participant-popup input')",
        ),
      ).toBe(true);
      await browser.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
      });
      await browser.wait("!document.querySelector('.voice-participant-popup')");
      expect(
        await browser.js(
          "[...document.querySelectorAll('.screen-stream-thumbnail')].every(video=>video.muted)",
        ),
      ).toBe(true);
      await saveCallScreenshot(browser, 'focused');
      await browser.js('fixture.screens.zoomOutWatch()');
      await browser.wait("document.querySelector('.screen-panel').dataset.layout==='grid'");
      await saveCallScreenshot(browser, 'grid');
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.wait(
        "document.querySelector('.screen-media').getBoundingClientRect().width<400",
      );
      await browser.wait(
        "[...document.querySelectorAll('.screen-media .screen-participant-tile')].every(e=>e.getBoundingClientRect().right<=390)",
      );
      expect(await browser.js('document.documentElement.scrollWidth<=390')).toBe(true);
      await saveCallScreenshot(browser, 'mobile');
      expect(await browser.js('fixture.captureCalls')).toBe(0);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    screenUiFixture,
  );
});

const portraitUiFixture = screenUiFixture
  .replace(
    'import { ScreenPanel }',
    "import { ChatComposer } from '/src/features/chat/ChatComposer.tsx';\nimport { ScreenPanel }",
  )
  .replace('function View(){', "function View(){const [draft,setDraft]=useState('');")
  .replace(
    "h(ScreenPanel,{voiceChannels:[{id:'lounge',name:'The lounge'}]})",
    "h(ScreenPanel,{voiceChannels:[{id:'lounge',name:'The lounge'}],chatName:'general',onChatVisibleChange:visible=>f.callChatReadable=visible}),h('div',{className:'chat-workspace'},h(ChatComposer,{body:draft,onChange:setDraft,onSend:e=>e.preventDefault(),reply:null,replyLoading:false,onCancelReply:()=>{},disabled:false,sending:false,retrying:false,members:[],userId:'account'}))",
  );

it('keeps typing in a wider portrait call when the on-screen keyboard shortens the viewport', async () => {
  await mountedFixture(
    async (browser) => {
      const resize = (height: number, portrait: boolean) =>
        browser.call('Emulation.setDeviceMetricsOverride', {
          width: 540,
          height,
          screenWidth: portrait ? 540 : 900,
          screenHeight: portrait ? 900 : 540,
          deviceScaleFactor: 1,
          mobile: true,
          screenOrientation: {
            type: portrait ? 'portraitPrimary' : 'landscapePrimary',
            angle: portrait ? 0 : 90,
          },
        });
      await browser.call('Emulation.setTouchEmulationEnabled', { enabled: true });
      await resize(900, true);
      await browser.wait("document.querySelector('#screen-panel')?.dataset.discussion==='true'");
      await browser.js(
        "fixture.composer=document.querySelector('.chat-workspace textarea');fixture.composer.focus()",
      );
      await browser.call('Input.insertText', { text: 'Draft during stream' });
      await resize(470, true);
      await browser.wait('innerHeight===470 && matchMedia("(orientation: landscape)").matches');
      await browser.call('Input.insertText', { text: '!' });
      expect(
        await browser.js(`(() => {
          const chat = document.querySelector('.chat-workspace');
          const composer = chat.querySelector('textarea');
          return document.querySelector('#screen-panel').dataset.discussion==='true' &&
            !chat.inert && document.activeElement===fixture.composer &&
            composer===fixture.composer && composer.value==='Draft during stream!' &&
            composer.getBoundingClientRect().bottom<=innerHeight &&
            getComputedStyle(chat.parentElement).display==='grid';
        })()`),
      ).toBe(true);

      await resize(470, false);
      await browser.wait(
        "document.querySelector('#screen-panel').dataset.discussion==='false' && document.querySelector('.chat-workspace').inert",
      );
      expect(await browser.js('fixture.composer.value')).toBe('Draft during stream!');
    },
    'approved',
    portraitUiFixture,
  );
});

it('moves focus into stream settings and keeps covered portrait chat out of the tab order', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 650,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.wait("document.querySelector('#screen-panel')?.dataset.discussion==='true'");
      const key = async (name: 'Enter' | 'Tab' | 'Escape', windowsVirtualKeyCode: number) => {
        for (const type of ['keyDown', 'keyUp'])
          await browser.call('Input.dispatchKeyEvent', {
            type,
            key: name,
            code: name,
            windowsVirtualKeyCode,
            ...(type === 'keyDown' && name === 'Enter' ? { text: '\r' } : {}),
          });
      };
      await browser.js(`fixture.composer=document.querySelector('.chat-workspace textarea');
        fixture.composer.focus()`);
      await browser.call('Input.insertText', { text: 'Draft while watching' });

      for (const selector of [
        '[aria-label="Open stream settings"]',
        '.screen-call-toolbar [aria-label="Share Your Screen"]',
      ]) {
        await browser.js(`fixture.settingsTrigger=document.querySelector(${JSON.stringify(selector)});
          fixture.settingsTrigger.focus()`);
        await key('Enter', 13);
        await browser.wait("document.activeElement?.matches('.screen-settings-close')");
        expect(
          await browser.js(
            `document.querySelector('.chat-workspace').inert && !fixture.callChatReadable`,
          ),
        ).toBe(true);
        await browser.js('fixture.composer.focus()');
        expect(await browser.js("document.activeElement?.matches('.screen-settings-close')")).toBe(
          true,
        );
        await key('Tab', 9);
        expect(await browser.js("!!document.activeElement?.closest('#screen-settings')")).toBe(
          true,
        );
        await key('Escape', 27);
        await browser.wait('document.activeElement===fixture.settingsTrigger');
        expect(
          await browser.js(`document.querySelector('#screen-settings').hidden &&
            !document.querySelector('.chat-workspace').inert && fixture.callChatReadable &&
            fixture.composer.value==='Draft while watching' && fixture.screens.inspect().watching==='first'`),
        ).toBe(true);
      }
    },
    'approved',
    portraitUiFixture,
  );
});

it('keeps the rendered stream settings heading and subtitle readable in both palettes', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.screens && !!document.querySelector("#screen-panel")');
      await browser.js('document.querySelector(\'[aria-label="Open stream settings"]\').click()');
      await browser.wait("!document.querySelector('#screen-settings').hidden");
      for (const theme of ['original', 'retro']) {
        const ratios = (await browser.js(`(() => {
          document.documentElement.dataset.appearance=${JSON.stringify(theme)};
          const settings = document.querySelector('#screen-settings');
          const header = settings.querySelector('.screen-settings-header');
          const context = document.createElement('canvas').getContext('2d');
          function luminance(color) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const [r,g,b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
              .map(channel => channel / 255)
              .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return r * 0.2126 + g * 0.7152 + b * 0.0722;
          }
          const headerBackground = getComputedStyle(header).backgroundColor;
          const background = luminance(headerBackground === 'rgba(0, 0, 0, 0)'
            ? getComputedStyle(settings).backgroundColor : headerBackground);
          return ['.screen-settings-header strong', '.screen-settings-header > div > span'].map(selector => {
            const foreground = luminance(getComputedStyle(settings.querySelector(selector)).color);
            return (Math.max(background, foreground) + 0.05) /
              (Math.min(background, foreground) + 0.05);
          });
        })()`)) as number[];
        expect(ratios).toHaveLength(2);
        for (const ratio of ratios) expect(ratio, theme).toBeGreaterThanOrEqual(4.5);
      }
    },
    'approved',
    screenUiFixture,
  );
});

it('keeps portrait video at the top, people below it, and sharing, watching and leaving independent', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.wait(
        '!!window.fixture?.call?.screens && !!document.querySelector(".screen-incoming-tile")',
      );
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.wait(
        "document.querySelector('#screen-panel').dataset.discussion==='true' && !document.querySelector('.chat-workspace').inert",
      );
      await browser.js(`document.querySelector('[aria-label="People in this call"]').click()`);
      await browser.wait(
        "document.querySelectorAll('.screen-participant-strip .screen-participant-tile').length===2",
      );
      await browser.js(`const initialTile=document.querySelector('.screen-incoming-tile');
        const lateTrack=initialTile.cloneNode(true);
        lateTrack.querySelector('.screen-incoming-label').textContent='Shared screen';
        initialTile.replaceWith(lateTrack);`);
      await browser.wait(
        "document.querySelector('.screen-incoming .screen-incoming-label').textContent==='Friend’s screen'",
      );
      const compactHeader = `(() => {
        const status=document.querySelector('.screen-status');
        return status.scrollWidth<=status.clientWidth && [...document.querySelectorAll('.screen-call-header button')].every(
          button=>getComputedStyle(button).whiteSpace==='nowrap' && button.getBoundingClientRect().height<=40
        );
      })()`;
      expect(await browser.js(compactHeader)).toBe(true);
      const geometry = await browser.js(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const stage = rect('.screen-call-body'), header = rect('.screen-call-header');
      const people = rect('.screen-participant-strip'), toolbar = rect('.screen-call-toolbar');
      const actions = [...document.querySelectorAll('.screen-call-header button,.screen-call-toolbar button')];
      return {fit:getComputedStyle(document.querySelector('.screen-incoming video')).objectFit,
        top:Math.abs(stage.top-header.bottom)<2, height:Math.abs(stage.height-stage.width*9/16)<2,
        peopleBelow:people.top>=stage.bottom && people.height>=80,
        docked:Math.abs(toolbar.bottom-innerHeight)<2,
        inside:actions.every(button=>button.getBoundingClientRect().right<=innerWidth)};
    })()`);
      expect(geometry).toEqual({
        fit: 'contain',
        top: true,
        height: true,
        peopleBelow: true,
        docked: true,
        inside: true,
      });
      await browser.js(`fixture.player = document.querySelector('.screen-incoming video');
        fixture.composer = document.querySelector('.chat-workspace textarea');
        document.querySelector('[aria-label="Chat in this call"]').click()`);
      await browser.wait(
        "document.querySelector('.screen-panel').dataset.discussion==='true' && !document.querySelector('.chat-workspace').inert",
      );
      const chatPosition = await browser.js(`(() => {
        const r = element => element.getBoundingClientRect();
        const box = r(document.querySelector('.chat-workspace'));
        const views = r(document.querySelector('.screen-mobile-views'));
        const toolbar = r(document.querySelector('.screen-call-toolbar'));
        return { usable:box.height>=120 && box.top>=views.bottom-2 && box.bottom<=toolbar.top+2,
          acceptsInput:document.elementFromPoint(r(fixture.composer).left+10,r(fixture.composer).top+10)===fixture.composer };
      })()`);
      expect(chatPosition).toEqual({ usable: true, acceptsInput: true });
      expect(await browser.js('fixture.callChatReadable')).toBe(true);
      await browser.js(`document.querySelector('[aria-label="Open stream settings"]').click()`);
      await browser.wait('fixture.callChatReadable===false');
      await browser.js(`document.querySelector('[aria-label="Close screen settings"]').click()`);
      await browser.wait('fixture.callChatReadable===true');
      await browser.js('fixture.composer.focus()');
      await browser.call('Input.insertText', { text: 'Ready for the next lap' });
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 365,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.call('Input.insertText', { text: '!' });
      await browser.wait(`document.activeElement===fixture.composer && fixture.composer.value.endsWith('!') &&
        document.querySelector('#screen-panel').dataset.discussion==='true' && fixture.player===document.querySelector('.screen-incoming video') &&
        fixture.composer.getBoundingClientRect().bottom<=innerHeight`);
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.js(`document.querySelector('[aria-label="People in this call"]').click()`);
      await browser.wait(
        "document.querySelector('.chat-workspace').inert && !document.querySelector('.screen-participant-strip').hidden",
      );
      await browser.js(`document.querySelector('[aria-label="Chat in this call"]').click()`);
      await browser.wait("!document.querySelector('.chat-workspace').inert");
      expect(
        await browser.js(`fixture.composer===document.querySelector('textarea') && fixture.composer.value==='Ready for the next lap!' &&
        fixture.screens.inspect().watching==='first' && fixture.player===document.querySelector('.screen-incoming video')`),
      ).toBe(true);
      await browser.js(`document.querySelector('[aria-label="People in this call"]').click();
        document.querySelector('[aria-label="Stop & return to channel"]').click()`);
      await browser.wait(
        "!fixture.screens.inspect().open && !fixture.screens.inspect().watching && fixture.call.voice.status==='connected'",
      );
      await browser.js("fixture.screens.open();fixture.screens.watch('first')");
      await browser.wait(
        "document.querySelector('#screen-panel')?.dataset.discussion==='false' && !document.querySelector('#screen-participants').hidden",
      );
      await browser.js(`fixture.screens.stopSource=()=>fixture.screenSet({prepared:false,phase:'ready',ownShareId:null});
      fixture.screenSet({phase:'sharing',prepared:true,label:'raw-capture-token',ownShareId:'own',
        shares:[...fixture.screens.inspect().shares,{...fixture.screens.inspect().shares[0],id:'own',publisherId:'account'}]})`);
      await browser.wait(`!!document.querySelector('[aria-label="Stop screen sharing"]')`);
      expect(
        await browser.js(
          `document.querySelectorAll('#screen-panel [aria-label="Stop screen sharing"]').length`,
        ),
      ).toBe(1);
      expect(await browser.js("document.body.innerText.includes('raw-capture-token')")).toBe(false);
      await browser.js(`document.querySelector('.screen-stop[title="Stop watching"]').click()`);
      await browser.wait(
        "!fixture.screens.inspect().watching && fixture.screens.inspect().phase==='sharing'",
      );
      await browser.wait(
        "document.querySelector('.screen-media > .screen-incoming-label')?.textContent==='Your screen'",
      );
      expect(await browser.js(compactHeader)).toBe(true);
      await browser.js(`document.querySelector('[aria-label="Stop screen sharing"]').click()`);
      await browser.wait(
        "fixture.screens.inspect().phase==='ready' && fixture.call.voice.status==='connected'",
      );
      expect(
        await browser.js(
          `document.querySelector('#screen-panel [aria-label="Leave voice"]').innerText`,
        ),
      ).toBe('Leave voice');
      await browser.js(`document.querySelector('[aria-label="Back to channel"]').click()`);
      await browser.wait(
        "!fixture.screens.inspect().open && fixture.call.voice.status==='connected'",
      );
    },
    'approved',
    portraitUiFixture,
  );
});

it('replaces a watched stream on Watch Stream and shows an ended state when the publisher disappears', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait(
        '!!window.fixture?.call?.screens && !!document.querySelector(".screen-stream-tile[data-share-id=second]")',
      );
      await browser.js(
        "fixture.call.controls.join('lounge');document.querySelector('[data-share-id=second] .screen-stream-watch').click()",
      );
      await browser.wait("fixture.screens.inspect().watching==='second'");
      expect(await browser.js('fixture.screens.inspect().watchingShareIds')).toEqual(['second']);
      expect(await browser.js('fixture.screenActions')).toContainEqual(['replace', 'second']);
      await browser.js(
        "fixture.screenSet({shares:fixture.screens.inspect().shares.filter(s=>s.id!=='second'),watching:null,watchingShareIds:[]})",
      );
      await browser.wait("document.body.textContent.includes('This stream has ended.')");
      expect(
        await browser.js("document.querySelector('.screen-stage-ended').textContent"),
      ).toContain('Participant');
      await browser.click('Back to channel');
      await browser.wait("!document.querySelector('#screen-panel')");
      await browser.js('fixture.screens.open()');
      await browser.wait("document.querySelector('.screen-panel')?.dataset.layout==='grid'");
      expect(await browser.js("!!document.querySelector('.screen-stage-ended')")).toBe(false);

      await browser.js("fixture.screens.watch('first')");
      await browser.wait("!!document.querySelector('[data-screen-share-id=first]')");
      // The server can deliver the link close and the directory removal in separate updates.
      await browser.js('fixture.screenSet({watching:null,watchingShareIds:[]})');
      await browser.wait("document.querySelector('.screen-panel')?.dataset.layout==='grid'");
      await browser.js('fixture.screenSet({shares:[]})');
      await browser.wait("document.body.textContent.includes('This stream has ended.')");
      await browser.click('Close Stream');
      await browser.wait("document.querySelector('.screen-panel').dataset.layout==='grid'");
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    screenUiFixture,
  );
});

it('clears the previous stream when the viewer stops watching before the publisher stops', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait("!!document.querySelector('[data-screen-share-id=first]')");
      await browser.click('Stop watching');
      await browser.wait("document.querySelector('.screen-panel')?.dataset.layout==='grid'");
      await browser.js(
        "fixture.screenSet({shares:fixture.screens.inspect().shares.filter(s=>s.id!=='first')})",
      );
      await browser.wait("!document.querySelector('.screen-stream-tile[data-share-id=first]')");
      expect(await browser.js("!!document.querySelector('.screen-stage-ended')")).toBe(false);
    },
    'approved',
    screenUiFixture,
  );
});

it('resets fullscreen controls when the call closes and reopens', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.screens && !!document.querySelector(".screen-panel")');
      await browser.js(`fixture.fullscreen=document.querySelector('.screen-panel');
      Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>fixture.fullscreen});
      document.dispatchEvent(new Event('fullscreenchange'))`);
      await browser.wait('!!document.querySelector(\'[aria-label="Exit full screen"]\')');
      await browser.js('fixture.screens.close()');
      await browser.wait('!document.querySelector(".screen-panel")');
      await browser.js(
        "fixture.fullscreen=null;document.dispatchEvent(new Event('fullscreenchange'));fixture.screens.open()",
      );
      await browser.wait('!!document.querySelector(\'[aria-label="Enter full screen"]\')');
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    screenUiFixture,
  );
});

async function saveCallScreenshot(browser: Awaited<ReturnType<typeof launch>>, name: string) {
  await browser.js(
    '(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))})()',
  );
  const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/screen-call-' + name + '.png',
    Buffer.from(shot.data as string, 'base64'),
  );
}

it.each([
  { open: false, entry: 'sidebar' },
  { open: true, entry: 'sidebar' },
  { open: true, entry: 'toolbar' },
])(
  'automatically follows the selected Windows source audio from $entry with the call view open=$open',
  async ({ open, entry }) => {
    await mountedFixture(
      async (browser) => {
        await browser.wait('!!window.fixture?.call?.screens');
        await browser.js(`fixture.call.controls.join('lounge');
        window.tricordDesktop={platform:'win32'};
        fixture.preparations=[];fixture.choices=0;
        fixture.screens.prepare=async options=>{fixture.preparations.push(options);fixture.screenSet({prepared:true})};
        fixture.screens.choose=async()=>{fixture.choices++};
        fixture.screenSet({open:${open},watching:null,watchingShareIds:[],prepared:false,setupRequested:false});`);
        await browser.wait(
          '!!document.querySelector(".sidebar .screen-launcher button:not(:disabled)")',
        );
        const shareSelector =
          entry === 'sidebar'
            ? '.sidebar .screen-launcher > button'
            : '.screen-call-toolbar [aria-label="Share Your Screen"]';
        const clickShare = () =>
          browser.js(`document.querySelector(${JSON.stringify(shareSelector)}).click()`);
        await clickShare();
        await browser.wait('document.querySelector("#screen-settings")?.hidden===false');
        expect(await browser.js('fixture.preparations.length===0 && fixture.choices===0')).toBe(
          true,
        );
        expect(
          await browser.js('!document.querySelector(\'[aria-label="Screen source sound"]\')'),
        ).toBe(true);
        expect(
          await browser.js(
            "document.querySelector('#screen-settings').textContent.includes('Audio follows your source')",
          ),
        ).toBe(true);
        await browser.js(
          "[...document.querySelectorAll('button')].find(b=>b.textContent==='Prepare source').click()",
        );
        await browser.wait('fixture.preparations.length===1');
        expect(await browser.js('fixture.preparations[0].sound')).toBe('source');
        expect(await browser.js('fixture.choices')).toBe(0);
        if (open)
          await browser.js(
            'document.querySelector(\'[aria-label="Close stream settings"]\').click()',
          );
        await browser.js(`fixture.screenSet({open:${open},setupRequested:false})`);
        await browser.wait(
          open
            ? 'document.querySelector("#screen-settings")?.hidden===true'
            : '!document.querySelector("#screen-settings")',
        );
        await clickShare();
        await browser.wait('document.querySelector("#screen-settings")?.hidden===false');
        expect(await browser.js('fixture.preparations.length===1 && fixture.choices===0')).toBe(
          true,
        );
        await browser.wait(
          "!![...document.querySelectorAll('button')].find(b=>b.textContent==='Choose source')",
        );
        await browser.js(
          "[...document.querySelectorAll('button')].find(b=>b.textContent==='Choose source').click()",
        );
        await browser.wait('fixture.choices===1');
        expect(await browser.js('fixture.errors')).toEqual([]);
      },
      'approved',
      screenUiFixture
        .replace('import { ScreenPanel }', 'import { ScreenPanel, ScreenLauncher }')
        .replace(
          "h('aside',{className:'sidebar'},h(VoicePanel))",
          "h('aside',{className:'sidebar'},h(VoicePanel),h(ScreenLauncher))",
        ),
    );
  },
);

it('opens the call grid on a voice-channel click and opens source setup only on Share Your Screen', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call?.screens');
      await browser.js(
        "fixture.screenSet({open:false,watching:null,watchingShareIds:[]});fixture.deviceList=[{kind:'audioinput',deviceId:'mic',label:'Synthetic device',groupId:'m'},{kind:'audiooutput',deviceId:'speaker',label:'Synthetic device',groupId:'s'}];document.querySelector('[data-voice-channel-id=lounge]').click()",
      );
      await browser.wait('fixture.captureCalls===1');
      await browser.js('fixture.finishCapture()');
      await browser.wait("document.querySelector('#screen-panel')?.dataset.layout==='grid'");
      expect(await browser.js("document.querySelector('#screen-settings').hidden")).toBe(true);
      await browser.js(
        'document.querySelector(\'.screen-call-toolbar [aria-label="Share Your Screen"]\').click()',
      );
      await browser.wait("!document.querySelector('#screen-settings').hidden");
      await browser.js(
        "document.querySelector('[aria-label=\"Back to channel\"]').click();document.querySelector('[data-voice-channel-id=lounge]').click()",
      );
      await browser.wait("document.querySelector('#screen-settings')?.hidden===true");
      expect(await browser.js('fixture.captureCalls')).toBe(1);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    screenUiFixture,
  );
});

it('keeps chat visible after a failed voice join and returns to chat on leave', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call?.screens');
      await browser.js(
        "fixture.screenSet({open:false,watching:null,watchingShareIds:[]});fixture.deviceList=[{kind:'audioinput',deviceId:'mic',label:'Synthetic device'},{kind:'audiooutput',deviceId:'speaker',label:'Synthetic device'}];fixture.channelController=undefined;document.querySelector('[data-voice-channel-id=lounge]').click()",
      );
      await browser.wait('fixture.captureCalls===1');
      await browser.js('fixture.finishCapture()');
      await browser.wait("document.body.textContent.includes('Synthetic join rejected')");
      expect(await browser.js('fixture.screens.inspect().open')).toBe(false);
      await browser.js(
        "fixture.rejectJoin=false;document.querySelector('[data-voice-channel-id=lounge]').click()",
      );
      await browser.wait('fixture.captureCalls===2');
      await browser.js('fixture.finishCapture()');
      await browser.wait("!!document.querySelector('#screen-panel')");
      await browser.js(
        `document.querySelector('#screen-panel [aria-label="Leave voice"]').click()`,
      );
      await browser.wait("fixture.call.voice.status==='idle'");
      expect(await browser.js('fixture.screens.inspect().open')).toBe(false);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    screenUiFixture.replace(
      'f.channelJoins.push(id);f.channelController=this;',
      "f.channelJoins.push(id);f.channelController=this;if(f.rejectJoin!==false){this.update({status:'idle',channelId:null,error:'Synthetic join rejected'});return;}",
    ),
  );
});

it('does not reopen a participant volume popup after the participant or call view returns', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call?.screens');
      await browser.js("fixture.call.controls.join('lounge')");
      await browser.wait("!!document.querySelector('.screen-participant-tile:not([disabled])')");
      await browser.js(
        "document.querySelector('.screen-participant-tile:not([disabled])').click()",
      );
      await browser.wait("!!document.querySelector('.voice-participant-popup')");
      await browser.js(
        'fixture.people=fixture.call.voice.participants;fixture.channelController.update({participants:[]})',
      );
      await browser.wait("!document.querySelector('.voice-participant-popup')");
      await browser.js('fixture.channelController.update({participants:fixture.people})');
      await browser.wait("!!document.querySelector('.screen-participant-tile:not([disabled])')");
      expect(await browser.js("!!document.querySelector('.voice-participant-popup')")).toBe(false);
      await browser.js(
        "document.querySelector('.screen-participant-tile:not([disabled])').click()",
      );
      await browser.wait("!!document.querySelector('.voice-participant-popup')");
      await browser.js('fixture.screens.close()');
      await browser.wait("!document.querySelector('#screen-panel')");
      await browser.js('fixture.screens.open()');
      await browser.wait("!!document.querySelector('#screen-panel')");
      expect(await browser.js("!!document.querySelector('.voice-participant-popup')")).toBe(false);
    },
    'approved',
    screenUiFixture,
  );
});

it('reflects saved stream playback mute and volume after reopening the call view', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.call?.screens');
      await browser.js(
        'fixture.screenSet({playbackMuted:true,playbackVolume:0.35});fixture.screens.close()',
      );
      await browser.wait("!document.querySelector('#screen-panel')");
      await browser.js('fixture.screens.open(true)');
      await browser.wait("!!document.querySelector('.screen-watch-controls')");
      expect(await browser.js("document.querySelector('.screen-mute-control input').checked")).toBe(
        true,
      );
      expect(await browser.js(`document.querySelector('[aria-label="Screen volume"]').value`)).toBe(
        '0.35',
      );
    },
    'approved',
    screenUiFixture,
  );
});

it('shows recoverable account verification failures without pretending the session is signed out', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait("!!document.body?.textContent.includes('Could not open Rajcord')");
      expect(await browser.js("!!document.querySelector('[name=password]')")).toBe(false);
      await browser.js('fixture.failMe=false');
      await browser.click('Retry');
      await browser.wait('!!fixture.call');
      await browser.js(
        'fixture.currentControls=fixture.call.controls;fixture.failMe=true;fixture.auth.refresh()',
      );
      await browser.wait("!!document.querySelector('.auth-toast')");
      expect(await browser.js('fixture.call.controls===fixture.currentControls')).toBe(true);
      await browser.js('fixture.failMe=false;fixture.auth.refresh()');
      await browser.wait("!document.querySelector('.auth-toast')");
      await browser.js('fixture.server=null;fixture.auth.refresh()');
      await browser.wait("!!document.querySelector('[name=password]')");
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    fixture.replace(
      "if(path==='/api/auth/me') {",
      "if(path==='/api/auth/me') { if(f.failMe!==false)return response({error:'Synthetic unavailable'},503);",
    ),
  );
});

const settingsFixture = channelFixture.replace(
  "if(path==='/api/account/sessions') return response({sessions:[]});",
  "if(path==='/api/account/sessions'){const d=deferred();(f.settingsRequests??=[]).push(d);return d.promise;}",
);
it('shows settings loading and retry states, refreshes once and keeps the last link keyboard accessible', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.auth');
      await browser.js("fixture.auth.openSettings('people')");
      await browser.wait(
        "fixture.settingsRequests?.length>0 && document.body.textContent.includes('Loading account details')",
      );
      expect(await browser.js("document.body.textContent.includes('all caught up')")).toBe(false);
      await browser.js(
        "fixture.settingsRequests.forEach(d=>fixture.respond(d,{error:'Synthetic account failure'},503))",
      );
      await browser.wait(
        "document.body.textContent.includes('Account details could not be loaded')",
      );
      expect(await browser.js("document.body.textContent.includes('all caught up')")).toBe(false);
      await browser.js('fixture.settingsCount=fixture.settingsRequests.length');
      await browser.click('Retry');
      await browser.wait('fixture.settingsRequests.length===fixture.settingsCount+1');
      await browser.js('fixture.respond(fixture.settingsRequests.at(-1),{sessions:[]})');
      await browser.wait("document.body.textContent.includes('all caught up')");
      await browser.js(
        "fixture.settingsCount=fixture.settingsRequests.length;fixture.auth.openSettings('account')",
      );
      await browser.click('Refresh');
      await browser.wait('fixture.settingsRequests.length===fixture.settingsCount+1');
      await browser.js('fixture.respond(fixture.settingsRequests.at(-1),{sessions:[]})');
      await browser.wait("!document.body.textContent.includes('Loading account details')");
      expect(await browser.js('fixture.settingsRequests.length')).toBe(
        ((await browser.js('fixture.settingsCount')) as number) + 1,
      );
      await browser.js("document.querySelector('.font-credits a').focus()");
      await browser.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      expect(await browser.js("document.activeElement.getAttribute('aria-label')")).toBe(
        'Close settings',
      );
      await browser.js('document.querySelector(\'[aria-label="Close settings"]\').focus()');
      await browser.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
        modifiers: 8,
      });
      expect(
        await browser.js("document.activeElement===document.querySelector('.font-credits a')"),
      ).toBe(true);
      const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
      await writeFile('artifacts/polish-settings.png', Buffer.from(shot.data as string, 'base64'));
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    settingsFixture,
  );
});
it('ignores old settings loads after the verified session is replaced', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.auth');
      await browser.js("fixture.auth.openSettings('account')");
      await browser.wait('fixture.settingsRequests?.length>0');
      await browser.js(
        "fixture.oldSettings=[...fixture.settingsRequests];fixture.server=fixture.state('b');fixture.auth.refresh()",
      );
      await browser.wait(
        "fixture.auth.state.csrfToken==='b' && fixture.settingsRequests.length>fixture.oldSettings.length",
      );
      await browser.js(
        "fixture.settingsRequests.slice(fixture.oldSettings.length).forEach(d=>fixture.respond(d,{sessions:[{id:'fresh',device_label:'Fresh session',created_at:'2026-11-16T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',remember:false,current:false}]}))",
      );
      await browser.wait("document.body.textContent.includes('Fresh session')");
      await browser.js(
        "fixture.oldSettings.forEach(d=>fixture.respond(d,{sessions:[{id:'old',device_label:'Obsolete session',created_at:'2026-11-16T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',remember:false,current:false}]}))",
      );
      await browser.js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      expect(await browser.js("document.body.textContent.includes('Obsolete session')")).toBe(
        false,
      );
      expect(await browser.js("document.body.textContent.includes('Fresh session')")).toBe(true);
    },
    'approved',
    settingsFixture,
  );
});

it('returns to sign in after logout even when the last account check failed', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.auth');
      await browser.js('fixture.failMe=true;fixture.auth.refresh()');
      await browser.wait("!!document.querySelector('.auth-toast')");
      await browser.js('fixture.auth.logout();void 0');
      await browser.wait('fixture.logouts.length===1');
      await browser.js('fixture.server=null;fixture.respond(fixture.logouts[0],{ok:true})');
      await browser.wait("!!document.querySelector('[name=password]')");
      await browser.js('fixture.auth.refresh()');
      expect(await browser.js("!!document.querySelector('[name=password]')")).toBe(true);
      expect(await browser.js("document.body.textContent.includes('Could not open Rajcord')")).toBe(
        false,
      );
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    fixture.replace(
      "if(path==='/api/auth/me') {",
      "if(path==='/api/auth/me') { if(f.failMe)return response({error:'Synthetic unavailable'},503);",
    ),
  );
});

it('submits sign in once while pending and permits a retry after rejection', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait("!!document.querySelector('[name=password]')");
      await browser.js('fixture.signIn();fixture.signIn()');
      await browser.wait('fixture.logins?.length===1');
      expect(await browser.js("document.querySelector('.auth-switch button').disabled")).toBe(true);
      await browser.js(
        "fixture.respond(fixture.logins[0],{error:'Synthetic sign-in rejected'},503)",
      );
      await browser.wait("document.body.textContent.includes('Synthetic sign-in rejected')");
      expect(await browser.js("document.querySelector('[name=username]').value")).toBe('fixture');
      await browser.js("fixture.signIn();fixture.respond(fixture.logins[1],fixture.state('b'))");
      await browser.wait("fixture.auth?.state.csrfToken==='b'");
      expect(await browser.js('fixture.logins.length')).toBe(2);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    fixture
      .replace('f.server=f.state();', 'f.server=null;')
      .replace(
        "if(path==='/api/auth/login') return response(f.server);",
        "if(path==='/api/auth/login'){const d=deferred();(f.logins??=[]).push(d);return d.promise;}",
      ),
  );
});

it('ignores a sign-in response after account verification replaces the sign-in view', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait("!!document.querySelector('[name=password]')");
      await browser.js(
        "fixture.signIn();fixture.server=fixture.state('b');window.dispatchEvent(new Event('focus'))",
      );
      await browser.wait("fixture.auth?.state.csrfToken==='b'");
      await browser.js("fixture.respond(fixture.logins[0],fixture.state('a'))");
      await browser.js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      expect(await browser.js('fixture.auth.state.csrfToken')).toBe('b');
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    fixture
      .replace('f.server=f.state();', 'f.server=null;')
      .replace(
        "if(path==='/api/auth/login') return response(f.server);",
        "if(path==='/api/auth/login'){const d=deferred();(f.logins??=[]).push(d);return d.promise;}",
      ),
  );
});

it('prevents duplicate settings saves, permits retry, and fences late results after session replacement', async () => {
  await mountedFixture(
    async (browser) => {
      await browser.wait('!!window.fixture?.auth');
      await browser.js("fixture.auth.openSettings('account')");
      await browser.wait(
        "!!document.querySelector('.account-content form') && !document.querySelector('.account-content form button').disabled",
      );
      await browser.js(
        "fixture.save=()=>document.querySelector('.account-content form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));fixture.save();fixture.save()",
      );
      await browser.wait('fixture.accountSaves?.length===1');
      await browser.js(
        "fixture.respond(fixture.accountSaves[0],{error:'Synthetic save rejected'},503)",
      );
      await browser.wait(
        "document.querySelector('.account-panel [role=alert]')?.textContent.includes('Synthetic save rejected')",
      );
      await browser.js('fixture.save();fixture.respond(fixture.accountSaves[1],{ok:true})');
      await browser.wait(
        "document.body.textContent.includes('Display name saved.') && !document.querySelector('.account-content form button').disabled",
      );
      await browser.js("fixture.save();fixture.server=fixture.state('b');fixture.auth.refresh()");
      await browser.wait(
        "fixture.auth.state.csrfToken==='b' && !document.querySelector('.account-content form button').disabled",
      );
      await browser.js(
        "fixture.respond(fixture.accountSaves[2],{error:'Obsolete save failure'},503)",
      );
      await browser.js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      expect(await browser.js("document.body.textContent.includes('Obsolete save failure')")).toBe(
        false,
      );
      expect(await browser.js('fixture.accountSaves.length')).toBe(3);
      expect(await browser.js('fixture.errors')).toEqual([]);
    },
    'approved',
    channelFixture.replace(
      "if(path==='/api/account/sessions')",
      "if(path==='/api/account'){const d=deferred();(f.accountSaves??=[]).push(d);return d.promise;} if(path==='/api/account/sessions')",
    ),
  );
});
