import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, type Browser } from '../../../../api/src/voice/browser-harness';

const source = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthContext, apiContract } from '/src/features/account/context.tsx';
import { AccountPanel } from '/src/features/account/AccountPanel.tsx';
import { SignIn } from '/src/features/account/SignIn.tsx';
import '/src/app/styles.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const owner={id:'f6cbec6b-2154-43cf-b785-d66e0bc73187',username:'fixture_owner',displayName:'Fixture owner',status:'approved',isOwner:true};
const member={id:'7bac9660-787f-4e0c-a394-3454b7e58498',username:'fixture_member',displayName:'Fixture member',status:'approved',isOwner:false};
const f=window.fixture={issues:[],resets:[],errors:[],signedIn:0,code:'A'.repeat(43)};
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
window.addEventListener('error',event=>f.errors.push(event.message));
f.response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(path,options={})=>{
 if(path==='/api/admin/accounts')return f.response({users:[owner,member]});
 if(path==='/api/admin/history')return f.response({history:[]});
 if(path==='/api/account/sessions')return f.response({sessions:[]});
 if(String(path).startsWith('/api/admin/password-recovery/')){const request={...deferred(),body:JSON.parse(options.body)};f.issues.push(request);return request.promise}
 if(path==='/api/auth/password/reset'){const request={...deferred(),body:JSON.parse(options.body)};f.resets.push(request);return request.promise}
 throw Error('Unexpected fixture request '+path);
};
function View(){const [mode,setMode]=useState('owner'),[tab,setTab]=useState('people');f.mode=setMode;
 const value={state:{user:owner,csrfToken:'fixture-csrf',expiresAt:new Date(Date.now()+600000).toISOString(),remember:false},connected:true,socket:null,
 request:(p,m='GET',b,s)=>apiContract(p,m,b,'fixture-csrf',s),requestContract:(p,m='GET',b,s)=>apiContract(p,m,b,'fixture-csrf',s),refresh:async()=>{},logout:async()=>{},openSettings:()=>{},notificationSettingsHost:null,voiceSettingsHost:null};
 return mode==='signin'?h(SignIn,{onSignedIn:()=>f.signedIn++}):h(AuthContext.Provider,{value},h(AccountPanel,{close:()=>setMode('signin'),tab,setTab,notificationHostRef:()=>{},voiceHostRef:()=>{}}));}
f.root=createRoot(document.getElementById('root'));f.root.render(h(View));
f.input=(name,value)=>{const el=document.querySelector('[name="'+name+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};
`;
async function fixture(work: (browser: Browser) => Promise<void>) {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'owned-password-recovery',
        resolveId: (id) => (id === '/__recovery.js' ? '\0recovery' : undefined),
        load: (id) => (id === '\0recovery' ? source : undefined),
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(
              '<html data-appearance="original"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__recovery.js"></script></html>',
            );
          });
        },
      },
    ],
  });
  let browser: Browser | undefined;
  try {
    await server.listen();
    browser = await launch({ fakeMicrophone: false });
    await browser.call('Page.navigate', { url: server.resolvedUrls!.local[0] });
    await browser.wait(
      '!!window.fixture && !![...document.querySelectorAll("button")].find(b=>b.textContent==="Reset password")',
    );
    await work(browser);
    expect(await browser.js('fixture.errors')).toEqual([]);
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

it('issues a code once after owner reauthentication, clears it on close, and ignores a late response', async () => {
  await fixture(async (browser) => {
    await browser.click('Reset password');
    await browser.wait(
      '!!document.querySelector(".password-recovery-issuer input[type=password]")',
    );
    await browser.js(
      "fixture.input('currentPassword','Synthetic-owner-password');document.querySelector('.password-recovery-issuer form').requestSubmit();document.querySelector('.password-recovery-issuer form').requestSubmit()",
    );
    await browser.wait('fixture.issues.length===1');
    expect(await browser.js('fixture.issues[0].body.currentPassword')).toBe(
      'Synthetic-owner-password',
    );
    await browser.js(
      'fixture.issues[0].resolve(fixture.response({code:fixture.code,expiresAt:new Date(Date.now()+900000).toISOString()}))',
    );
    await browser.wait('!!document.querySelector(".password-recovery-issuer input[readonly]")');
    expect(
      await browser.js(
        '!!document.querySelector(".password-recovery-issuer input[type=password]")',
      ),
    ).toBe(false);
    expect(
      await browser.js(
        "document.querySelector('.password-recovery-issuer').textContent.includes('new password')",
      ),
    ).toBe(true);
    await browser.js(
      "document.querySelector('.password-recovery-issuer').scrollIntoView({block:'center'})",
    );
    const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/password-recovery-owner.png',
      Buffer.from(shot.data as string, 'base64'),
    );
    await browser.click('Done');
    await browser.wait('!document.querySelector(".password-recovery-issuer")');
    expect(await browser.js('document.activeElement.textContent')).toBe('Reset password');
    await browser.click('Reset password');
    await browser.js(
      "fixture.input('currentPassword','Synthetic-owner-password');document.querySelector('.password-recovery-issuer form').requestSubmit()",
    );
    await browser.wait('fixture.issues.length===2');
    await browser.click('Cancel recovery');
    await browser.js(
      'fixture.issues[1].resolve(fixture.response({code:fixture.code,expiresAt:new Date(Date.now()+900000).toISOString()}))',
    );
    await browser.js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    expect(await browser.js('!document.querySelector(".password-recovery-issuer")')).toBe(true);
  });
});

it('exposes Forgot password, validates confirmation, permits retry, and returns to sign-in without logging in', async () => {
  await fixture(async (browser) => {
    await browser.js("fixture.mode('signin')");
    await browser.wait(
      '!![...document.querySelectorAll("button")].find(b=>b.textContent==="Forgot password?")',
    );
    await browser.click('Forgot password?');
    await browser.wait('!!document.querySelector("[name=code]")');
    expect(await browser.js('document.activeElement.name')).toBe('username');
    await browser.js(
      "fixture.input('username','fixture_member');fixture.input('code',fixture.code);fixture.input('newPassword','Synthetic-new-password');fixture.input('confirmPassword','Different-new-password');document.querySelector('form').requestSubmit()",
    );
    await browser.wait(
      'document.querySelector("[role=alert]")?.textContent.includes("do not match")',
    );
    expect(await browser.js('fixture.resets.length')).toBe(0);
    await browser.js(
      "fixture.input('confirmPassword','Synthetic-new-password');document.querySelector('form').requestSubmit();document.querySelector('form').requestSubmit()",
    );
    await browser.wait('fixture.resets.length===1');
    await browser.js(
      "fixture.resets[0].resolve(fixture.response({error:'Invalid or expired recovery code.'},400))",
    );
    await browser.wait('document.querySelector("[role=alert]")?.textContent.includes("expired")');
    await browser.js("document.querySelector('form').requestSubmit()");
    await browser.wait('fixture.resets.length===2');
    await browser.js('fixture.resets[1].resolve(fixture.response({ok:true}))');
    await browser.wait(
      '!!document.querySelector("[name=password]") && document.body.textContent.includes("Password reset. Sign in")',
    );
    expect(await browser.js('fixture.signedIn')).toBe(0);
    expect(await browser.js('document.querySelector("[name=password]").value')).toBe('');
  });
});
