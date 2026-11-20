import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, type Browser } from '../../../../api/src/voice/browser-harness';

// Mount real chat components; only account requests and external GIF responses are synthetic.
const fixture = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposer } from '/src/features/chat/ChatComposer.tsx';
import { GifSearch } from '/src/features/chat/GifSearch.tsx';
import { MessageCard } from '/src/features/chat/MessageCard.tsx';
import { ChatPanel } from '/src/features/chat/ChatPanel.tsx';
import '/src/app/styles.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((r,e)=>{resolve=r;reject=e});return {promise,resolve,reject}};
const f=window.fixture={sends:[],gifSends:[],updates:[],configs:[],searches:[],errors:[],closed:0};
f.pinRequests=[];
window.addEventListener('error',event=>f.errors.push(event.message));
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
f.providers={providers:[{id:'giphy',label:'GIPHY',enabled:true,publicKey:'synthetic-fixture-key'},{id:'klipy',label:'KLIPY',enabled:false}]};
f.request=(path,method,body,signal)=>{if(path.startsWith('/conversations/fixture-room/pins')){const work={...deferred(),path};f.pinRequests.push(work);return work.promise}if(path!=='/gifs/providers')throw Error('Unexpected fixture request: '+path);const work={...deferred(),signal};f.configs.push(work);if(!f.holdConfig)work.resolve(f.providers);return work.promise};
f.page=(title='Fixture GIF')=>({meta:{status:200},pagination:{offset:0,count:1,total_count:1},data:[{id:'fixture',title,images:{original:{url:'https://media.giphy.com/media/fixture/giphy.gif',width:'120',height:'80'},fixed_width_small_still:{url:'https://media.giphy.com/media/fixture/giphy_s.gif'}}}]});
const nativeFetch=window.fetch.bind(window);
window.fetch=(url,options={})=>{if(!String(url).startsWith('https://api.giphy.com/'))return nativeFetch(url,options);const work={...deferred(),url:String(url),signal:options.signal};f.searches.push(work);if(!f.holdSearch)work.resolve(new Response(JSON.stringify(f.page()),{headers:{'Content-Type':'application/json'}}));return work.promise};
f.resolveSearch=(index,title)=>f.searches[index].resolve(new Response(JSON.stringify(f.page(title)),{headers:{'Content-Type':'application/json'}}));
f.input=(selector,value)=>{const input=document.querySelector(selector);const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
f.key=(selector,key,options={})=>document.querySelector(selector).dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));
const item={id:'fixture-message',conversationId:'fixture-room',sequence:1,featureVersion:2,author:{id:'self',username:'fixture',displayName:'Fixture author'},body:'Original message',createdAt:'2026-11-15T12:00:00Z',editedAt:null,deleted:false,pinned:false,mentions:[],reactions:[],replyCount:0,replyTo:null};
f.item=item;
function View(){
 const [mode,setMode]=useState('composer'),[body,setBody]=useState('Draft text'),[flags,setFlags]=useState({sending:false,replyLoading:false,replyFailed:false,disabled:false}),[open,setOpen]=useState(true);
 f.mode=setMode;f.body=setBody;f.flags=next=>setFlags(previous=>({...previous,...next}));f.open=setOpen;
 const sendGif=url=>{const work={...deferred(),url};f.gifSends.push(work);return work.promise};
 return h('main',{style:{maxWidth:760,margin:'80px auto',padding:24}},
 mode==='composer'?h(ChatComposer,{body,onChange:setBody,onSend:event=>{event.preventDefault();f.sends.push(body)},reply:null,onCancelReply:()=>{},retrying:false,members:[],userId:'self',onSendGif:sendGif,...flags}):
 mode==='gif'?h(GifSearch,{open,onClose:()=>{f.closed++;setOpen(false)},onSend:sendGif}):
 mode==='pins'?h('div',{className:'chat-history-layout',style:{height:480}},h(ChatPanel,{panel:{kind:'pins'},open:true,conversation:{id:'fixture-room',kind:'channel',archived:false},channels:[],onClose:()=>{f.closed++;setMode('composer')},onReply:()=>{},onThread:()=>{},onJump:()=>{},onUpdate:async()=>{}})):
 mode==='geometry'?h('div',{className:'message-scroll'},...[false,true].map(grouped=>h(MessageCard,{
   key:String(grouped),grouped,item:{...item,
     id:grouped?'followup':'first',author:{id:'self',displayName:'Astral Cartographer of the Outer Rim',username:'astral_cartographer_of_outer_rim'},
     body:grouped?'Next lap?':'Replay '+ 'Q7xb2'.repeat(100)},userId:'self',canPin:true,archived:false,onReply:()=>{},onThread:()=>{},onJump:()=>{},onUpdate:async()=>{}
 }))):
 h(MessageCard,{item,userId:'self',canPin:true,archived:false,onReply:()=>{},onThread:()=>{},onJump:()=>{},onUpdate:(message,action,body)=>{const work={...deferred(),action,body};f.updates.push(work);return work.promise}}));
}
f.root=createRoot(document.getElementById('root'));f.root.render(h(View));
`;

async function mountedFixture(work: (browser: Browser) => Promise<void>) {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    cacheDir: 'node_modules/.vite-chat-polish',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'chat-polish-fixture',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '/__chat-fixture.js') return '\0chat-fixture';
          if (
            id === '../account' &&
            (importer?.endsWith('/GifSearch.tsx') || importer?.endsWith('/ChatPanel.tsx'))
          )
            return '\0chat-auth';
        },
        load(id) {
          if (id === '\0chat-fixture') return fixture;
          if (id === '\0chat-auth')
            return 'export const useAuth=()=>({request:window.fixture.request,state:{user:{id:"self"}},socket:null})';
        },
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(
              '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/__chat-fixture.js"></script>',
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
    // GIF previews and all other external resources stay outside this disposable fixture.
    await browser.call('Network.setBlockedURLs', { urls: ['https://*'] });
    await browser.call('Page.navigate', { url: server.resolvedUrls!.local[0] });
    await browser.wait('!!window.fixture?.flags && !!document.querySelector("textarea")');
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

const messageInput = 'textarea[aria-label="Message"]';
const searchInput = 'input[aria-label="Search GIFs"]';

async function search(browser: Browser, query = 'cats') {
  await browser.wait(
    '!!document.querySelector(\'[aria-label="Run GIF search"]\') && !document.querySelector(\'[aria-label="Run GIF search"]\').disabled',
  );
  await browser.js(`fixture.input(${JSON.stringify(searchInput)},${JSON.stringify(query)})`);
  await browser.js('document.querySelector(\'[aria-label="Run GIF search"]\').click()');
  await browser.wait('fixture.searches.length>0');
}

async function edit(browser: Browser) {
  await browser.js('document.querySelector(\'[aria-label="More message actions"]\').click()');
  await browser.wait('!!document.querySelector(\'[role="menuitem"]\')');
  await browser.click('Edit message');
  await browser.wait('!!document.querySelector(\'textarea[aria-label="Edit message"]\')');
}

it('keeps pins loading, failures, results and empty states exclusive and retries the failed page', async () => {
  await mountedFixture(async (browser) => {
    const panelHeight = () =>
      browser.js(
        "document.querySelector('.chat-feature-panel').getBoundingClientRect().height",
      ) as Promise<number>;
    await browser.js("fixture.mode('pins')");
    await browser.wait(
      "fixture.pinRequests.length===1 && !!document.querySelector('.panel-loading')",
    );
    expect(await panelHeight()).toBeLessThan(125);
    expect(
      await browser.js("document.activeElement===document.querySelector('.chat-feature-panel h2')"),
    ).toBe(true);
    await browser.js("fixture.pinRequests[0].reject(new Error('Pins could not be loaded.'))");
    await browser.wait(
      "document.querySelector('.panel-error [role=alert]')?.textContent.includes('Pins could not be loaded.')",
    );
    expect(await panelHeight()).toBeLessThan(175);
    expect(
      await browser.js("document.querySelector('.panel-empty,.panel-loading,.chat-panel-history')"),
    ).toBeNull();
    expect(await browser.js("document.querySelector('.chat-feature-panel h2').textContent")).toBe(
      'Pinned messages',
    );
    await browser.click('Retry');
    await browser.wait(
      "fixture.pinRequests.length===2 && !!document.querySelector('.panel-loading')",
    );
    expect(
      await browser.js("document.activeElement===document.querySelector('.chat-feature-panel h2')"),
    ).toBe(true);
    await browser.js('fixture.pinRequests[1].resolve({messages:[],nextBefore:null,total:0})');
    await browser.wait(
      "document.querySelector('.panel-empty')?.textContent.includes('No pinned messages')",
    );
    expect(await panelHeight()).toBeLessThan(190);
    expect(await browser.js("document.querySelector('.panel-loading,.panel-error')")).toBeNull();
    await browser.js('document.querySelector(\'[aria-label="Refresh pins"]\').click()');
    await browser.wait('fixture.pinRequests.length===3');
    await browser.js(
      "fixture.pinRequests[2].resolve({messages:[fixture.item],total:2,nextBefore:'10'})",
    );
    await browser.wait("!!document.querySelector('.chat-panel-history [data-message-id]')");
    expect(await panelHeight()).toBeLessThan(260);
    expect(await browser.js("document.querySelector('.chat-feature-panel h2').textContent")).toBe(
      'Pinned messages (2)',
    );
    await browser.click('Load older pins');
    await browser.wait('fixture.pinRequests.length===4');
    await browser.js("fixture.pinRequests[3].reject(new Error('Older pins request failed.'))");
    await browser.wait("!!document.querySelector('.panel-error')");
    expect(
      await browser.js("document.querySelector('.panel-empty,.panel-loading,.chat-panel-history')"),
    ).toBeNull();
    await browser.click('Retry');
    await browser.wait('fixture.pinRequests.length===5');
    expect(await browser.js('fixture.pinRequests.slice(-2).map(request=>request.path)')).toEqual([
      '/conversations/fixture-room/pins?before=10',
      '/conversations/fixture-room/pins?before=10',
    ]);
    await browser.js(
      "fixture.pinRequests[4].resolve({messages:Array.from({length:24},(_,i)=>({...fixture.item,id:'older-'+i})),total:25,nextBefore:null})",
    );
    await browser.wait(
      "!!document.querySelector('.chat-panel-history [data-message-id=older-23]')",
    );
    for (const width of [1440, 390]) {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      expect(await panelHeight()).toBeLessThanOrEqual(360);
      expect(
        await browser.js(`(() => {
        const history=document.querySelector('.chat-panel-history'), panel=document.querySelector('.chat-feature-panel');
        const header=panel.querySelector('header'), headerTop=header.getBoundingClientRect().top;
        history.scrollTop=history.scrollHeight;
        const last=history.lastElementChild.getBoundingClientRect();
        return history.scrollTop>0 && last.bottom<=history.getBoundingClientRect().bottom+1 &&
          headerTop===header.getBoundingClientRect().top && panel.scrollWidth<=panel.clientWidth;
      })()`),
      ).toBe(true);
    }
    expect(
      await browser.js("document.querySelector('.panel-empty,.panel-loading,.panel-error')"),
    ).toBeNull();
    await browser.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    });
    expect(await browser.js("document.activeElement.getAttribute('aria-label')")).toBe(
      'Refresh pins',
    );
    expect(await browser.js('getComputedStyle(document.activeElement).outlineStyle')).not.toBe(
      'none',
    );
    await browser.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
    });
    await browser.wait("fixture.closed===1 && !document.querySelector('.chat-feature-panel')");
  });
});

it('keeps conversation timestamps beside their author or grouped text on wide and narrow screens', async () => {
  await mountedFixture(async (browser) => {
    await browser.js(
      "fixture.mode('geometry');Object.assign(document.querySelector('main').style,{maxWidth:'none',margin:'0',padding:'0'})",
    );
    await browser.wait("!!document.querySelector('.chat-message-author time')");
    for (const width of [1920, 768, 390]) {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const measures = (await browser.js(`(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const row = document.querySelector('[data-message-id=first]');
        const handle = rect('.chat-author-handle'), headerTime=rect('.chat-message-author time');
        const body = rect('[data-message-id=followup] .message-body'), time = rect('[data-message-id=followup] time');
        return {overflow:row.scrollWidth-row.clientWidth,body:rect('[data-message-id=first] .message-body').width,
          sameHeaderLine:Math.abs(handle.top-headerTime.top)<=4,headerGap:headerTime.left-handle.right,
          groupedGap:time.left-body.right,groupedTop:Math.abs(time.top-body.top),fullHandle:document.querySelector('.chat-author-handle').textContent};
      })()`)) as {
        overflow: number;
        body: number;
        sameHeaderLine: boolean;
        headerGap: number;
        groupedGap: number;
        groupedTop: number;
        fullHandle: string;
      };
      expect(measures.overflow).toBe(0);
      expect(measures.body).toBeLessThan(850);
      expect(measures.fullHandle).toBe('@astral_cartographer_of_outer_rim');
      if (width === 1920) expect(measures.sameHeaderLine).toBe(true);
      if (measures.sameHeaderLine) expect(measures.headerGap).toBeLessThanOrEqual(10);
      expect(measures.groupedGap).toBeGreaterThanOrEqual(0);
      expect(measures.groupedGap).toBeLessThanOrEqual(10);
      expect(measures.groupedTop).toBeLessThanOrEqual(5);
    }
  });
});

it.each(['sending', 'replyLoading', 'replyFailed', 'disabled'] as const)(
  'blocks Enter, form submission and GIF opening while %s, then recovers without losing the draft',
  async (flag) => {
    await mountedFixture(async (browser) => {
      await browser.js(`fixture.flags({${flag}:true})`);
      await browser.wait('document.querySelector(\'[aria-label="Send message"]\').disabled');
      await browser.js(
        `fixture.key(${JSON.stringify(messageInput)},'Enter');document.querySelector('.composer').requestSubmit()`,
      );
      expect(await browser.js('fixture.sends')).toEqual([]);
      expect(
        await browser.js(`document.querySelector(${JSON.stringify(messageInput)}).value`),
      ).toBe('Draft text');
      await browser.js("fixture.body('/gif')");
      await browser.wait('!!document.querySelector(".gif-command-suggestion")');
      expect(
        await browser.js(
          'document.querySelector(\'button[aria-label="Search GIFs"]\').disabled && document.querySelector(".gif-command-suggestion").disabled',
        ),
      ).toBe(true);
      await browser.js(
        `fixture.key(${JSON.stringify(messageInput)},'Enter');document.querySelector('.gif-command-suggestion').click()`,
      );
      expect(await browser.js('!!document.querySelector(".gif-search-panel")')).toBe(false);
      expect(
        await browser.js(`document.querySelector(${JSON.stringify(messageInput)}).value`),
      ).toBe('/gif');
      await browser.js(`fixture.flags({${flag}:false});fixture.body('Recovered draft')`);
      await browser.wait('!document.querySelector(\'[aria-label="Send message"]\').disabled');
      await browser.js(`fixture.key(${JSON.stringify(messageInput)},'Enter')`);
      expect(await browser.js('fixture.sends')).toEqual(['Recovered draft']);
      expect(
        await browser.js(
          `document.activeElement===document.querySelector(${JSON.stringify(messageInput)})`,
        ),
      ).toBe(true);
    });
  },
);

it('keeps blank, Shift+Enter and composing Enter out of the send path and opens /gif normally', async () => {
  await mountedFixture(async (browser) => {
    await browser.js("fixture.body('   ')");
    await browser.wait('document.querySelector(\'[aria-label="Send message"]\').disabled');
    await browser.js(`fixture.key(${JSON.stringify(messageInput)},'Enter')`);
    await browser.js("fixture.body('Editable draft')");
    await browser.wait('!document.querySelector(\'[aria-label="Send message"]\').disabled');
    await browser.js(
      `fixture.key(${JSON.stringify(messageInput)},'Enter',{shiftKey:true});fixture.key(${JSON.stringify(messageInput)},'Enter',{isComposing:true})`,
    );
    expect(await browser.js('fixture.sends')).toEqual([]);
    await browser.js("fixture.body('/gif')");
    await browser.wait('!!document.querySelector(".gif-command-suggestion")');
    await browser.js(`fixture.key(${JSON.stringify(messageInput)},'Enter')`);
    await browser.wait('document.querySelector(".gif-search-panel")?.dataset.open==="true"');
    expect(await browser.js(`document.querySelector(${JSON.stringify(messageInput)}).value`)).toBe(
      '',
    );
    expect(await browser.js('fixture.sends')).toEqual([]);
  });
});

it('clears short-query loading and rejects late search results after abort', async () => {
  await mountedFixture(async (browser) => {
    await browser.js("fixture.holdSearch=true;fixture.mode('gif')");
    await search(browser);
    await browser.wait('!!document.querySelector(".gif-search-loading")');
    await browser.js(`fixture.input(${JSON.stringify(searchInput)},'c')`);
    await browser.wait(
      'fixture.searches[0].signal.aborted && !document.querySelector(".gif-search-loading")',
    );
    await browser.js("fixture.resolveSearch(0,'Obsolete result')");
    await browser.wait(
      'document.querySelector(".gif-search-stage").textContent.includes("Type at least two characters")',
    );
    expect(await browser.js('!!document.querySelector(".gif-search-results")')).toBe(false);
    await search(browser, 'dogs');
    await browser.wait('fixture.searches.length===2');
    await browser.js("fixture.resolveSearch(1,'Current result')");
    await browser.wait('!!document.querySelector(\'[aria-label="Send GIF: Current result"]\')');
    await browser.js(`fixture.input(${JSON.stringify(searchInput)},'')`);
    await browser.wait(
      '!document.querySelector(".gif-search-results") && !document.querySelector(".gif-search-loading")',
    );
    expect(await browser.js('fixture.searches.length')).toBe(2);
  });
});

it('ignores obsolete provider configuration after the picker is closed and reopened', async () => {
  await mountedFixture(async (browser) => {
    await browser.js("fixture.holdConfig=true;fixture.mode('gif')");
    await browser.wait('fixture.configs.length===1');
    await browser.js('fixture.open(false)');
    await browser.wait('fixture.configs[0].signal.aborted');
    await browser.js('fixture.open(true)');
    await browser.wait('fixture.configs.length===2');
    await browser.js('fixture.configs[1].resolve(fixture.providers)');
    await browser.wait('!document.querySelector(\'[aria-label="Run GIF search"]\').disabled');
    await browser.js('fixture.configs[0].resolve({providers:[]})');
    await search(browser);
    await browser.wait('!!document.querySelector(\'[aria-label="Send GIF: Fixture GIF"]\')');
    expect(
      await browser.js('document.querySelector(\'[aria-label="Run GIF search"]\').disabled'),
    ).toBe(false);
  });
});

it.each(['resolve', 'reject'] as const)(
  'fences a late GIF send %s after dismissal/reopening without clearing the new pending send',
  async (outcome) => {
    await mountedFixture(async (browser) => {
      await browser.js("fixture.mode('gif')");
      await search(browser);
      await browser.wait('!!document.querySelector(\'[aria-label="Send GIF: Fixture GIF"]\')');
      await browser.js('document.querySelector(\'[aria-label="Send GIF: Fixture GIF"]\').click()');
      await browser.wait('fixture.gifSends.length===1');
      await browser.js('document.querySelector(\'[aria-label="Close GIF search"]\').click()');
      await browser.wait('document.querySelector(".gif-search-panel").dataset.open==="false"');
      await browser.js('fixture.open(true)');
      await browser.wait(
        '!!document.querySelector(\'[aria-label="Send GIF: Fixture GIF"]\') && !document.querySelector(\'[aria-label="Send GIF: Fixture GIF"]\').disabled',
      );
      await browser.js('document.querySelector(\'[aria-label="Send GIF: Fixture GIF"]\').click()');
      await browser.wait('fixture.gifSends.length===2');
      await browser.js(
        `fixture.gifSends[0].${outcome}(${outcome === 'reject' ? "new Error('Obsolete send failure')" : ''})`,
      );
      expect(await browser.js('document.querySelector(".gif-search-panel").dataset.open')).toBe(
        'true',
      );
      expect(
        await browser.js(
          'document.querySelector(\'[aria-label="Send GIF: Fixture GIF"]\').disabled',
        ),
      ).toBe(true);
      expect(
        await browser.js(
          'document.querySelector(".gif-search-panel").textContent.includes("Obsolete send failure")',
        ),
      ).toBe(false);
      expect(await browser.js('fixture.closed')).toBe(1);
      await browser.js('fixture.gifSends[1].resolve()');
      await browser.wait(
        'fixture.closed===2 && document.querySelector(".gif-search-panel").dataset.open==="false"',
      );
    });
  },
);

it('blocks blank and duplicate edits, preserves a failed draft and restores row focus on Escape', async () => {
  await mountedFixture(async (browser) => {
    await browser.js("fixture.mode('message')");
    await browser.wait('!!document.querySelector(".chat-message-row")');
    await edit(browser);
    await browser.js('fixture.input(\'textarea[aria-label="Edit message"]\',"   ")');
    await browser.wait('document.querySelector(".edit-form .primary").disabled');
    await browser.js('document.querySelector(".edit-form").requestSubmit()');
    expect(await browser.js('fixture.updates.length')).toBe(0);
    await browser.js('fixture.input(\'textarea[aria-label="Edit message"]\',"Changed message")');
    await browser.wait('!document.querySelector(".edit-form .primary").disabled');
    await browser.js(
      'const form=document.querySelector(".edit-form");form.requestSubmit();form.requestSubmit()',
    );
    await browser.wait(
      'fixture.updates.length===1 && document.querySelector(".edit-form textarea").disabled',
    );
    expect(await browser.js('fixture.updates.map(({action,body})=>({action,body}))')).toEqual([
      { action: 'edit', body: 'Changed message' },
    ]);
    await browser.js('fixture.updates[0].reject(new Error("Fixture save failed"))');
    await browser.wait(
      'document.querySelector(\'[role="alert"]\')?.textContent.includes("Fixture save failed")',
    );
    expect(await browser.js('document.querySelector(".edit-form textarea").value')).toBe(
      'Changed message',
    );
    await browser.js(
      'fixture.key(\'textarea[aria-label="Edit message"]\',"Escape",{isComposing:true})',
    );
    expect(await browser.js('!!document.querySelector(".edit-form")')).toBe(true);
    await browser.js('fixture.key(\'textarea[aria-label="Edit message"]\',"Escape")');
    await browser.wait('!document.querySelector(".edit-form")');
    expect(
      await browser.js('document.activeElement===document.querySelector(".chat-message-row")'),
    ).toBe(true);
    expect(await browser.js('!!document.querySelector(\'[role="alert"]\')')).toBe(false);
    await edit(browser);
    expect(await browser.js('document.querySelector(".edit-form textarea").value')).toBe(
      'Original message',
    );
    await browser.js('fixture.input(\'textarea[aria-label="Edit message"]\',"Successful message")');
    await browser.js('document.querySelector(".edit-form").requestSubmit()');
    await browser.wait('fixture.updates.length===2');
    await browser.js('fixture.updates[1].resolve()');
    await browser.wait('!document.querySelector(".edit-form")');
    expect(
      await browser.js('document.activeElement===document.querySelector(".chat-message-row")'),
    ).toBe(true);
    await browser.js(
      "fixture.narrowResize=new Promise(resolve=>window.addEventListener('resize',()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),{once:true}));void 0",
    );
    await browser.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.js('fixture.narrowResize');
    await edit(browser);
    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' });
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/polish-message-edit-narrow.png',
      Buffer.from(screenshot.data as string, 'base64'),
    );
  });
});
