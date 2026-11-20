import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, type Browser } from '../../../../api/src/voice/browser-harness';

// Exercise the real composer, draft lifetimes, send policy and message renderer.
const source = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Messages } from '/src/features/chat/Messages.tsx';
import { DraftStore } from '/src/features/chat/chat-state.ts';
import { AuthContext } from '/src/features/account/context.tsx';
import '/src/app/styles.ts';
const user={id:'f6cbec6b-2154-43cf-b785-d66e0bc73187',username:'fixture_member',displayName:'Fixture member',status:'approved',isOwner:false};
const room=(id,name)=>({id,name,kind:'channel',archived:false,topic:'',category:null,position:0,metadataRevision:'0',unreadCount:0,mentionCount:0,lastReadSeq:'0',activity:'0',managerId:null,members:[user]});
const first=room('75d7ccf1-e3fb-4e6d-8451-18559de43a55','First conversation');
const second=room('f4cbc678-f8d2-4c10-8cc9-37a4aec89d87','Second conversation');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const f=window.fixture={sends:[],errors:[],histories:{},drafts:new DraftStore(),first,second};
window.addEventListener('error',event=>f.errors.push(event.message));
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
f.request=async(path,method='GET',body)=>{
 const match=path.match(/^\\/conversations\\/([^/]+)\\/messages(?:\\/with-attachment)?(?:\\?.*)?$/);
 if(!match)throw Error('Unexpected fixture request '+method+' '+path);
 const conversationId=match[1];
 if(method==='GET')return {messages:f.histories[conversationId]??[],nextBefore:null,change:String((f.histories[conversationId]??[]).length),hasMore:false};
 if(method==='POST'){const work={...deferred(),path,conversationId,body};f.sends.push(work);return work.promise}
 throw Error('Unexpected fixture method '+method);
};
f.complete=index=>{
 const work=f.sends[index],history=f.histories[work.conversationId]??=[];
 const message={featureVersion:2,id:crypto.randomUUID(),conversationId:work.conversationId,clientId:work.body.clientId,seq:String(history.length+1),change:String(history.length+1),contextChange:String(history.length+1),author:user,body:work.body.body,createdAt:new Date().toISOString(),editedAt:null,deleted:false,replyTo:null,threadRoot:null,replyCount:0,pinned:false,reactions:[],mentions:[],...(work.body.attachment?{attachment:{mimeType:work.body.attachment.mimeType,size:atob(work.body.attachment.base64).length}}:{})};
 history.push(message);work.message=message;work.resolve({message});
};
f.input=value=>{const input=document.querySelector('textarea[name=message]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(value.length,value.length)};
f.file=(type='image/png',size)=>{
 const canvas=document.createElement('canvas');canvas.width=800;canvas.height=200;const context=canvas.getContext('2d');context.fillStyle='#95c96d';context.fillRect(0,0,800,200);context.fillStyle='#1a2126';context.fillRect(40,40,720,120);
 const bytes=size===undefined?Uint8Array.from(atob(canvas.toDataURL(type).split(',')[1]),character=>character.charCodeAt(0)):new Uint8Array(size);
 return new File([bytes],'fixture-screenshot-'+crypto.randomUUID(),{type});
};
f.paste=({type='image/png',size,count=1,text='',filesOnly=false,outside=false}={})=>{
 const input=document.querySelector('textarea[name=message]');input.focus();
 const transfer=new DataTransfer();if(text)transfer.setData('text/plain',text);
 for(let index=0;index<count;index++)transfer.items.add(f.file(type,size));
 const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});
 if(filesOnly)Object.defineProperty(event,'clipboardData',{value:{items:[],files:transfer.files,getData:kind=>transfer.getData(kind)}});
 (outside?document.body:input).dispatchEvent(event);f.pastePrevented=event.defaultPrevented;return event.defaultPrevented;
};
f.pasteText=text=>{const input=document.querySelector('textarea[name=message]');input.focus();const transfer=new DataTransfer();transfer.setData('text/plain',text);const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});input.dispatchEvent(event);return event.defaultPrevented};
const ignore=()=>{};
function View(){
 const [conversation,setConversation]=useState(first);f.room=id=>setConversation(id==='second'?second:first);f.current=conversation.id;
 const value={state:{user,csrfToken:'fixture-csrf',expiresAt:new Date(Date.now()+600000).toISOString(),remember:false},connected:true,socket:null,request:f.request,requestContract:f.request,refresh:async()=>{},logout:async()=>{},openSettings:ignore,notificationSettingsHost:null,voiceSettingsHost:null};
 return h(AuthContext.Provider,{value},h('main',{className:'chat-main',style:{height:'100dvh',width:'100%',maxWidth:980,margin:'0 auto',minWidth:0}},h(Messages,{key:conversation.id,conversation,readingAllowed:false,drafts:f.drafts,navigation:null,onAccessLost:ignore,channels:[],onChannel:ignore})));
}
f.root=createRoot(document.getElementById('root'));f.root.render(h(View));
`;

async function fixture(work: (browser: Browser) => Promise<void>) {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'chat-image-paste-fixture',
        resolveId: (id) => (id === '/__image-paste.js' ? '\0image-paste' : undefined),
        load: (id) => (id === '\0image-paste' ? source : undefined),
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.startsWith('/media/chat-attachments/')) {
              response.setHeader('Content-Type', 'image/svg+xml');
              response.setHeader('Cache-Control', 'no-store');
              response.end(
                '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="800" height="200" fill="#95c96d"/><rect x="40" y="40" width="720" height="120" fill="#1a2126"/></svg>',
              );
              return;
            }
            if (request.url !== '/') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(
              '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/__image-paste.js"></script>',
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
    await browser.call('Network.setBlockedURLs', { urls: ['https://*'] });
    await browser.call('Page.navigate', { url: server.resolvedUrls!.local[0] });
    await browser.wait(
      '!!window.fixture?.room && !!document.querySelector("textarea[name=message]") && !document.querySelector(".chat-status[role=status]")',
    );
    await work(browser);
    expect(await browser.js('fixture.errors')).toEqual([]);
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await server.close();
    }
  }
}

const textarea = 'textarea[name=message]';
const preview = '.composer-attachment-preview img';
const settle = (browser: Browser) =>
  browser.js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

async function send(browser: Browser) {
  await browser.js('document.querySelector(\'[aria-label="Send message"]\').click()');
}

async function input(browser: Browser, value: string) {
  await browser.js(`fixture.input(${JSON.stringify(value)})`);
  await browser.wait(
    `document.querySelector(${JSON.stringify(textarea)}).value===${JSON.stringify(value)}`,
  );
}

it('previews a pasted screenshot and caption, sends only explicitly and removes a selected image', async () => {
  await fixture(async (browser) => {
    await browser.js('fixture.paste({outside:true})');
    await settle(browser);
    expect(await browser.js(`!!document.querySelector(${JSON.stringify(preview)})`)).toBe(false);
    await input(browser, 'Existing caption ');
    await browser.js('fixture.paste({text:"pasted text"})');
    await browser.wait(`!!document.querySelector(${JSON.stringify(preview)})`);
    expect(await browser.js('fixture.pastePrevented')).toBe(true);
    expect(await browser.js('fixture.sends.length')).toBe(0);
    expect(await browser.js(`document.querySelector(${JSON.stringify(textarea)}).value`)).toBe(
      'Existing caption pasted text',
    );
    await browser.js('document.querySelector(\'[aria-label="Remove image"]\').click()');
    await browser.wait(`!document.querySelector(${JSON.stringify(preview)})`);
    expect(await browser.js(`document.querySelector(${JSON.stringify(textarea)}).value`)).toBe(
      'Existing caption pasted text',
    );
    await browser.js('fixture.paste()');
    await browser.wait(`!!document.querySelector(${JSON.stringify(preview)})`);
    await send(browser);
    await browser.wait('fixture.sends.length===1');
    expect(await browser.js('fixture.sends[0].path.endsWith("/messages/with-attachment")')).toBe(
      true,
    );
    expect(await browser.js('fixture.sends[0].body.body')).toBe('Existing caption pasted text');
    expect(await browser.js('fixture.sends[0].body.attachment.mimeType')).toBe('image/png');
    expect(await browser.js('fixture.sends[0].body.attachment.base64.length>0')).toBe(true);
    await browser.js('fixture.complete(0)');
    await browser.wait(
      `document.querySelector(${JSON.stringify(textarea)}).value==="" && !document.querySelector(${JSON.stringify(preview)})`,
    );
    expect(await browser.js('fixture.sends.length')).toBe(1);
  });
});

it('leaves plain-text paste uncancelled and preserves native textarea insertion at the caret', async () => {
  await fixture(async (browser) => {
    await input(browser, 'before after');
    await browser.js('document.querySelector("textarea").setSelectionRange(7,7)');
    expect(await browser.js('fixture.pasteText("pasted\\ntext ")')).toBe(false);
    // CDP performs native insertion without replacing the operator's system clipboard.
    await browser.call('Input.insertText', { text: 'pasted\ntext ' });
    await browser.wait(
      `document.querySelector(${JSON.stringify(textarea)}).value==="before pasted\\ntext after"`,
    );
    expect(await browser.js(`!!document.querySelector(${JSON.stringify(preview)})`)).toBe(false);
    expect(await browser.js('fixture.sends.length')).toBe(0);
  });
});

it('keeps a caption-limit error visible instead of silently dropping pasted image text', async () => {
  await fixture(async (browser) => {
    const retained = 'x'.repeat(3999);
    await input(browser, retained);
    await browser.js('fixture.paste({text:"clipboard caption"})');
    await browser.wait(
      'document.querySelector(".chat-composer-controls [role=alert]")?.textContent.includes("4000")',
    );
    expect(await browser.js(`document.querySelector(${JSON.stringify(textarea)}).value`)).toBe(
      retained,
    );
    expect(await browser.js(`!!document.querySelector(${JSON.stringify(preview)})`)).toBe(false);
    expect(await browser.js('fixture.sends.length')).toBe(0);
  });
});

it.each([
  ['unsupported image', { type: 'image/svg+xml', size: 20 }],
  ['oversized screenshot', { type: 'image/png', size: 8 * 1024 * 1024 + 1 }],
  ['multiple images', { count: 2 }],
] as const)('rejects %s without changing the caption or sending', async (_name, clipboard) => {
  await fixture(async (browser) => {
    await input(browser, 'Retained text');
    await browser.js(`fixture.paste(${JSON.stringify(clipboard)})`);
    await browser.wait('!!document.querySelector(".chat-composer-controls [role=alert]")');
    expect(await browser.js(`document.querySelector(${JSON.stringify(textarea)}).value`)).toBe(
      'Retained text',
    );
    expect(await browser.js(`!!document.querySelector(${JSON.stringify(preview)})`)).toBe(false);
    expect(await browser.js('fixture.sends.length')).toBe(0);
  });
});

it('retains a failed image attempt across conversation switches and retries the same message identifier', async () => {
  await fixture(async (browser) => {
    await input(browser, 'Room A screenshot');
    await browser.js('fixture.paste({filesOnly:true})');
    await browser.wait(`!!document.querySelector(${JSON.stringify(preview)})`);
    await send(browser);
    await browser.wait('fixture.sends.length===1');
    await browser.js('fixture.sends[0].reject(new Error("Fixture connection dropped"))');
    await browser.wait('document.body.textContent.includes("Fixture connection dropped")');
    expect(await browser.js(`!!document.querySelector(${JSON.stringify(preview)})`)).toBe(true);
    await browser.js('fixture.room("second")');
    await browser.wait(
      `fixture.current===fixture.second.id && document.querySelector(${JSON.stringify(textarea)}).value===""`,
    );
    expect(await browser.js(`!!document.querySelector(${JSON.stringify(preview)})`)).toBe(false);
    await browser.js('fixture.input("Room B draft");fixture.room("first")');
    await browser.wait(
      `document.querySelector(${JSON.stringify(textarea)}).value==="Room A screenshot" && !!document.querySelector(${JSON.stringify(preview)})`,
    );
    await send(browser);
    await browser.wait('fixture.sends.length===2');
    expect(
      await browser.js('fixture.sends[0].body.clientId===fixture.sends[1].body.clientId'),
    ).toBe(true);
    expect(
      await browser.js(
        'fixture.sends[0].body.attachment.base64===fixture.sends[1].body.attachment.base64',
      ),
    ).toBe(true);
    await browser.js('fixture.complete(1)');
    await browser.wait(`document.querySelector(${JSON.stringify(textarea)}).value===""`);
    await browser.js('fixture.room("second")');
    await browser.wait(
      `document.querySelector(${JSON.stringify(textarea)}).value==="Room B draft"`,
    );
    expect(await browser.js('!!document.querySelector(".chat-image")')).toBe(false);
  });
});

it('keeps a late image-send response in its original conversation', async () => {
  await fixture(async (browser) => {
    await browser.js('fixture.paste()');
    await browser.wait(`!!document.querySelector(${JSON.stringify(preview)})`);
    await send(browser);
    await browser.wait('fixture.sends.length===1');
    await browser.js('fixture.room("second")');
    await browser.wait(
      `fixture.current===fixture.second.id && !!document.querySelector(${JSON.stringify(textarea)})`,
    );
    await browser.js('fixture.input("Unrelated room draft");fixture.complete(0)');
    await settle(browser);
    expect(await browser.js(`document.querySelector(${JSON.stringify(textarea)}).value`)).toBe(
      'Unrelated room draft',
    );
    expect(await browser.js('!!document.querySelector(".chat-image")')).toBe(false);
    expect(await browser.js('fixture.sends.length')).toBe(1);
  });
});

it('sends an image without text and provides a fitted viewer, download and unavailable-image fallback', async () => {
  await fixture(async (browser) => {
    await browser.js('fixture.paste()');
    await browser.wait(`!!document.querySelector(${JSON.stringify(preview)})`);
    await send(browser);
    await browser.wait('fixture.sends.length===1');
    expect(await browser.js('fixture.sends[0].body.body')).toBe('');
    await browser.js('fixture.complete(0)');
    await browser.wait(
      '!!document.querySelector(\'[aria-label="Open image"] img\') && document.querySelector(\'[aria-label="Open image"] img\').naturalWidth===800',
    );
    const geometry = (await browser.js(
      '(()=>{const image=document.querySelector(\'[aria-label="Open image"] img\');const box=image.getBoundingClientRect();return {width:box.width,height:box.height,container:image.closest(".chat-message-content").getBoundingClientRect().width}})()',
    )) as { width: number; height: number; container: number };
    expect(geometry.width).toBeLessThanOrEqual(geometry.container);
    expect(geometry.width / geometry.height).toBeCloseTo(4, 1);
    await browser.js('document.querySelector(\'[aria-label="Open image"]\').click()');
    await browser.wait('!!document.querySelector(\'dialog[aria-label="Image preview"]\')');
    expect(
      await browser.js(
        'document.querySelector("dialog a[download]")?.getAttribute("href").endsWith("?download=1")',
      ),
    ).toBe(true);
    await browser.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await browser.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await browser.wait('!document.querySelector(\'dialog[aria-label="Image preview"]\')');
    expect(await browser.js('document.activeElement.getAttribute("aria-label")')).toBe(
      'Open image',
    );
    await browser.call('Emulation.setDeviceMetricsOverride', {
      width: 380,
      height: 800,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await settle(browser);
    expect(await browser.js('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
    const shot = await browser.call('Page.captureScreenshot', { format: 'png' });
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/chat-image-paste-mobile.png',
      Buffer.from(shot.data as string, 'base64'),
    );
    await browser.js(
      'document.querySelector(\'[aria-label="Open image"] img\').dispatchEvent(new Event("error"))',
    );
    await browser.wait('document.body.textContent.includes("Image unavailable")');
    await browser.click('Retry image');
    await browser.wait(
      '!!document.querySelector(\'[aria-label="Open image"] img\') && document.querySelector(\'[aria-label="Open image"] img\').naturalWidth===800',
    );
  });
});
