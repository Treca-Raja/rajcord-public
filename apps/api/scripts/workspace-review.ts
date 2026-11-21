import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { testDatabase } from '../src/db/test-database.js';
import { ChatFeatures } from '../src/chat/features.js';
import { ChatService } from '../src/chat/service.js';
import { launch, setup, type Browser } from '../src/voice/browser-harness.js';
import { checkVoiceTestServices } from '../src/voice/test-services.js';

// Local review harness. The normal application build has no fixture routes or accounts.
const before = process.argv.includes('--before');
const review = process.argv.includes('--review');
const finalUx = process.argv.includes('--final-ux');
const label = before ? 'before' : 'after';
const root = new URL('../../../', import.meta.url);
const dist = new URL(before ? '.local/design-v1-baseline/dist/' : 'apps/web/dist/', root);
const directory = new URL(
  finalUx ? 'artifacts/design-v1-final-ux/' : 'artifacts/design-v1-refinement/',
  root,
);
const port = review ? 3076 : 3077;
const origin = 'http://127.0.0.1:' + port;
// Validate the selected build before allocating accounts or starting any services.
await access(new URL('index.html', dist));
const config = await checkVoiceTestServices();
const fixture = await testDatabase();
const browsers: Browser[] = [];
const peers: Socket[] = [];
let server: ReturnType<typeof createApp> | undefined;
const layouts = [
  [1920, 1080],
  [1440, 900],
  [1280, 720],
  [768, 900],
  [390, 844],
] as const;

const distanceFromLatest = `(() => {
  const timeline = document.querySelector('.message-scroll');
  return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
})()`;

async function capture(browser: Browser, name: string) {
  if (
    finalUx &&
    ![
      '1440x900',
      '768x900',
      'navigation-390x844',
      'voice-dock-390x844',
      'pins-empty',
      'pins-loaded',
      'watching-chat-390x844',
      'keyboard-viewport',
      'watching',
      'watch-ended',
      'returned-to-channel',
    ].includes(name)
  )
    return;
  await browser.js(
    'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
  );
  const image = await browser.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    new URL(label + '-' + name + '.png', directory),
    Buffer.from(image.data as string, 'base64'),
  );
}

async function resize(page: Browser, width: number, height: number) {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function key(page: Browser, name: 'Enter' | 'Tab' | 'Escape', modifiers = 0) {
  const keyCode = { Enter: 13, Tab: 9, Escape: 27 }[name];
  for (const type of ['keyDown', 'keyUp'])
    await page.call('Input.dispatchKeyEvent', {
      type,
      key: name,
      code: name,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(type === 'keyDown' && name === 'Enter' ? { text: '\r' } : {}),
    });
}

async function checkMobileKeyboard(page: Browser) {
  const toggle = 'button[aria-label="Toggle navigation"]';
  await page.js(`document.querySelector('${toggle}').focus()`);
  assert.equal(await page.js(`document.activeElement===document.querySelector('${toggle}')`), true);
  await key(page, 'Enter');
  await page.wait("document.activeElement?.getAttribute('aria-label')==='Close navigation'");
  await key(page, 'Tab', 8);
  assert.equal(await page.js("document.activeElement?.closest('#community-sidebar')!==null"), true);
  await key(page, 'Tab');
  await page.wait("document.activeElement?.getAttribute('aria-label')==='Close navigation'");
  const outline = await page.js('getComputedStyle(document.activeElement).outlineStyle');
  assert.notEqual(outline, 'none');
  await capture(page, 'navigation-390x844');
  await key(page, 'Escape');
  await page.wait(`document.activeElement===document.querySelector('${toggle}')`);
  assert.equal(await page.js("document.querySelector('.chat').inert"), false);
}

// A generated practice circuit replaces only the desktop picker in the publisher.
// Both clients still negotiate their real screen session and exchange video over WebRTC.
const practiceCircuit = `
navigator.mediaDevices.getDisplayMedia = async ({video}) => {
  const canvas = document.createElement('canvas');
  canvas.width = video.width.ideal;
  canvas.height = video.height.ideal;
  const ctx = canvas.getContext('2d');
  const route = [[0,0],[130,-105],[230,-86],[289,-28],[234,12],[180,2],[118,60],[180,128],[81,179],[-100,150],[-212,58],[-177,-33],[-110,-50],[0,0]];
  let position = 0;
  function draw() {
    ctx.setTransform(canvas.width / 960, 0, 0, canvas.height / 540, 0, 0);
    ctx.fillStyle = '#111e27'; ctx.fillRect(0, 0, 960, 540);
    ctx.strokeStyle = '#23333d'; ctx.lineWidth = 1;
    for (let x=0; x<960; x+=36) {ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,540); ctx.stroke()}
    for (let y=0; y<540; y+=36) {ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(960,y); ctx.stroke()}
    ctx.fillStyle = '#9bb5be'; ctx.font = '15px monospace'; ctx.fillText('TIME TRIAL   /   PRACTICE', 36, 45);
    ctx.fillStyle = '#eaf1f2'; ctx.font = 'bold 29px sans-serif'; ctx.fillText('Relay Circuit', 36, 83);
    ctx.translate(465,243); ctx.beginPath(); ctx.lineJoin = 'round';
    route.forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.strokeStyle = '#738993'; ctx.lineWidth = 18; ctx.stroke();
    ctx.strokeStyle = '#253842'; ctx.lineWidth = 13; ctx.stroke();
    for (const [offset, color] of [[0,'#ccf661'], [3,'#76caff'],[7,'#f3f6ef']]) {
      const index = (position+offset) % (route.length-1); const i = Math.floor(index);
      const [x,y] = route[i], [nx,ny] = route[i+1];
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x+(nx-x)*(index-i),y+(ny-y)*(index-i),6,0,Math.PI*2); ctx.fill();
    }
    position += 0.018;
  }
  draw(); const timer=setInterval(draw,1000/30);
  const stream=canvas.captureStream(video.frameRate.ideal);
  const track=stream.getVideoTracks()[0], stop=track.stop.bind(track);
  track.stop=()=>{clearInterval(timer);stop()};
  return stream;
};`;

async function checkPins(page: Browser, addPin: (messageId: string) => Promise<unknown>) {
  await page.wait("document.querySelectorAll('.message-scroll [data-message-id]').length >= 45");
  await page.js(`const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      if (!new URL(args[0],location.href).pathname.endsWith('/pins')) return originalFetch(...args);
      window.fetch = originalFetch;
      await new Promise(resolve => window.releaseReviewPins = resolve);
      return new Response(JSON.stringify({error:'Unable to load pinned messages.'}), {
        status:503,headers:{'Content-Type':'application/json'}
      });
    };`);
  await page.click('Pinned messages');
  await page.wait('!!document.querySelector(\'[aria-label="Loading pinned messages"]\')');
  await capture(page, 'loading');
  await page.js('window.releaseReviewPins()');
  await page.wait("!!document.querySelector('.chat-feature-panel [role=alert]')");
  await capture(page, 'error');
  if (!before) {
    assert.equal(
      await page.js(
        "!!document.querySelector('.chat-feature-panel :is(.panel-empty,.panel-loading,[data-message-id])')",
      ),
      false,
    );
  }
  await page.click('Retry');
  await page.wait(
    "document.querySelector('.chat-feature-panel[aria-busy=false] .panel-empty') && !document.querySelector('.chat-feature-panel [role=alert]')",
  );
  await capture(page, 'pins-empty');
  const lastMessageId = await page.js(
    "Array.from(document.querySelectorAll('.message-scroll [data-message-id]')).at(-1).dataset.messageId",
  );
  assert.equal(typeof lastMessageId, 'string');
  await addPin(String(lastMessageId));
  if (finalUx) {
    const previous = (await page.js(
      "Array.from(document.querySelectorAll('.message-scroll [data-message-id]')).slice(-13,-1).map(el=>el.dataset.messageId)",
    )) as string[];
    for (const id of previous) await addPin(id);
  }
  await page.js('document.querySelector(\'[aria-label="Refresh pins"]\').click()');
  await page.wait("!!document.querySelector('.chat-feature-panel [data-message-id]')");
  assert.equal(
    await page.js(
      "!!document.querySelector('.chat-feature-panel :is(.panel-empty,.panel-loading,[role=alert])')",
    ),
    false,
  );
  if (finalUx)
    await page.wait(
      "document.querySelectorAll('.chat-feature-panel [data-message-id]').length >= 12",
    );
  await capture(page, 'pins-loaded');
  await page.js('document.querySelector(\'[aria-label="Close chat panel"]\').click()');
}

async function checkStreams(page: Browser, owner: string, publisherToken: string) {
  const channelButton = before ? '[aria-label="Back to chat"]' : '[aria-label="Back to channel"]';
  const publisher = await launch();
  browsers.push(publisher);
  await publisher.call('Page.addScriptToEvaluateOnNewDocument', { source: practiceCircuit });
  await setup(publisher, publisherToken, origin);
  await publisher.js(
    'document.querySelector(\'[aria-label="Dismiss notification setup"]\')?.click()',
  );
  await publisher.js("document.querySelector('.screen-launcher > button').click()");
  await publisher.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
  await publisher.click('Prepare source');
  await publisher.wait("document.querySelector('#screen-panel')?.dataset.prepared==='true'");
  await publisher.click('Choose source');
  await publisher.wait("document.querySelector('#screen-panel')?.dataset.phase==='preview'");
  await publisher.click('Start sharing');
  await publisher.wait("document.querySelector('#screen-panel')?.dataset.phase==='sharing'");
  if (!review) {
    if (!before) {
      const stopCount = await publisher.js(`Array.from(document.querySelectorAll('button'))
        .filter(el => el.checkVisibility() && /stop (screen )?sharing/i.test([el.textContent,el.title,el.getAttribute('aria-label')].join(' '))).length`);
      assert.equal(stopCount, 1, 'Publisher must have a single visible stop-sharing action');
    }
    await capture(publisher, 'publishing');
    await resize(publisher, 390, 844);
    await capture(publisher, 'publishing-390x844');
    await resize(publisher, 1440, 900);
  }
  await setup(page, owner, origin);
  await page.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
  await page.js(`document.querySelector('${channelButton}').click()`);
  await page.wait("!document.querySelector('.live-shell.screen-call-open')");
  if (review) {
    await page.call('Emulation.clearDeviceMetricsOverride');
    await page.js(
      "const historyView=document.querySelector('.message-scroll');historyView.scrollTop=historyView.scrollHeight",
    );
  } else await resize(page, 1440, 900);
  if (!review) {
    // Establish the reading position before checking that a viewport resize preserves it.
    await page.js(
      "const feed=document.querySelector('.message-scroll');feed.scrollTop=feed.scrollHeight",
    );
    await page.wait("!document.querySelector('.jump-latest')");
    await capture(page, 'voice-dock');
    if (!before) {
      await resize(page, 390, 844);
      for (const label of ['Open call view', 'Unmute microphone', 'Leave voice']) {
        const control = `.mobile-call-controls button[aria-label="${label}"]`;
        const visible = await page.js(`(() => {
          const button = document.querySelector('${control}');
          if (!button || !button.checkVisibility()) return false;
          const box = button.getBoundingClientRect();
          return box.width >= 24 && box.height >= 24 && box.top >= 0 && box.bottom <= innerHeight;
        })()`);
        assert.ok(visible, label + ' must be available in phone chat');
      }
      await capture(page, 'voice-dock-390x844');
      assert.ok(
        Number(await page.js(distanceFromLatest)) < 2,
        'Connected phone chat should stay at latest',
      );
      await page.js(
        'document.querySelector(\'.mobile-call-controls [aria-label="Unmute microphone"]\').click()',
      );
      await page.wait(
        '!!document.querySelector(\'.mobile-call-controls [aria-label="Mute microphone"][aria-pressed=false]\')',
      );
      await page.js(
        'document.querySelector(\'.mobile-call-controls [aria-label="Mute microphone"]\').click()',
      );
      await page.wait(
        '!!document.querySelector(\'.mobile-call-controls [aria-label="Unmute microphone"][aria-pressed=true]\')',
      );
      await resize(page, 1440, 900);
    }
    await page.js('document.querySelector(\'[aria-label="Browse shared screens"]\').click()');
    await page.wait("!!document.querySelector('.screen-share-item .screen-share-action')");
    await page.js("document.querySelector('.screen-share-item .screen-share-action').click()");
    await page.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
    await capture(page, 'watching');
    await resize(page, 390, 844);
    await capture(page, 'watching-390x844');
    if (!before) {
      const watch = (await page.js(`(() => {
        const video = document.querySelector('[data-screen-playback]');
        const box = video.getBoundingClientRect();
        return {fit:getComputedStyle(video).objectFit, width:box.width, height:box.height, top:box.top,
          ratio:video.videoWidth/video.videoHeight};
      })()`)) as { fit: string; width: number; height: number; top: number; ratio: number };
      assert.equal(watch.fit, 'contain');
      assert.ok(watch.top < 100, 'Portrait video should start near the header');
      assert.ok(
        Math.abs(watch.height - watch.width / watch.ratio) <= 6,
        'Portrait stage should fit the source aspect ratio',
      );

      await page.js("window.reviewVideo=document.querySelector('[data-screen-playback]')");
      const frames = Number(
        await page.js('window.reviewVideo.getVideoPlaybackQuality().totalVideoFrames'),
      );
      const chatTab = '[aria-label="Chat in this call"]';
      const peopleTab = '[aria-label="People in this call"]';
      if (!finalUx) await page.js(`document.querySelector('${chatTab}').click()`);
      await page.wait(
        "document.querySelector('#screen-panel').dataset.discussion==='true' && document.querySelector('textarea[name=message]').checkVisibility()",
      );
      await page.js("document.querySelector('textarea[name=message]').focus()");
      await page.call('Input.insertText', { text: 'One more lap?' });
      await page.wait(
        `window.reviewVideo === document.querySelector('[data-screen-playback]') && window.reviewVideo.getVideoPlaybackQuality().totalVideoFrames > ${frames}`,
      );
      await capture(page, 'watching-chat-390x844');
      if (finalUx) {
        // Emulate the space left by a 320px software keyboard on a 390 x 844 phone.
        await resize(page, 390, 524);
        await page.call('Input.insertText', { text: ' Ready.' });
        await page.wait(`(() => {
          const box = document.activeElement.getBoundingClientRect();
          const video = document.querySelector('[data-screen-playback]');
          return document.activeElement.matches('textarea[name=message]') && document.activeElement.value.endsWith(' Ready.')
            && box.bottom <= innerHeight && box.top >= 0 && window.reviewVideo === video && !video.paused;
        })()`);
        const keyboardFrames = Number(
          await page.js('window.reviewVideo.getVideoPlaybackQuality().totalVideoFrames'),
        );
        await page.wait(
          `window.reviewVideo.getVideoPlaybackQuality().totalVideoFrames > ${keyboardFrames}`,
        );
        await capture(page, 'keyboard-viewport');
        await resize(page, 390, 844);
      }
      const previousDraft = await page.js("document.querySelector('textarea[name=message]').value");
      await page.js(`document.querySelector('${peopleTab}').click()`);
      await page.wait("!document.querySelector('#screen-participants').hidden");
      await page.js(`document.querySelector('${chatTab}').click()`);
      assert.equal(
        await page.js("document.querySelector('textarea[name=message]').value"),
        previousDraft,
      );
      assert.equal(
        await page.js(
          "window.reviewVideo === document.querySelector('[data-screen-playback]') && !window.reviewVideo.paused",
        ),
        true,
      );
    }
    await resize(page, 1440, 900);
    if (!before) {
      await page.js(
        'document.querySelector(\'#screen-panel button[title="Stop watching"]\').click()',
      );
      await page.wait(
        "!document.querySelector('[data-screen-playback]') && !!document.querySelector('[data-voice-status=connected]')",
      );
      if (finalUx) {
        assert.ok(await page.js("document.querySelector('#screen-panel').checkVisibility()"));
        await capture(page, 'watch-ended');
        if (await page.js("document.querySelector('#screen-settings')?.hidden")) {
          await page.js(
            "document.querySelector('button[aria-controls=screen-settings][aria-expanded=false]').click()",
          );
        }
        await page.js("document.querySelector('.screen-share-item .screen-share-action').click()");
        await page.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
        await page.js("document.querySelector('#screen-panel .screen-close').click()");
        await page.wait(
          "!document.querySelector('.live-shell.screen-call-open') && !document.querySelector('[data-screen-playback]') && !!document.querySelector('[data-voice-status=connected]')",
        );
        await capture(page, 'returned-to-channel');
        await page.js("document.querySelector('.screen-watch-launcher').click()");
        await page.wait("!!document.querySelector('#screen-panel .screen-close')");
        assert.equal(await page.js("!!document.querySelector('[data-screen-playback]')"), false);
      }
      await publisher.js(
        'document.querySelector(\'#screen-panel [aria-label="Stop screen sharing"]\').click()',
      );
      await publisher.wait(
        "!document.querySelector('#screen-panel[data-phase=sharing]') && !!document.querySelector('[data-voice-status=connected]')",
      );
    }
    await page.js(`document.querySelector('${channelButton}').click()`);
    await page.wait(
      "document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'",
    );
    if (!before) await resize(page, 390, 844);
    const leave = before
      ? '[aria-label="Leave voice"]'
      : '.mobile-call-controls [aria-label="Leave voice"]';
    await page.js(`document.querySelector('${leave}').click()`);
    await page.wait("!document.querySelector('[data-voice-status=connected]')");
  }
}

try {
  const auth = new AuthService(fixture.database.pool);
  const chat = new ChatService(fixture.database.pool);
  const password = randomUUID() + '-Review';
  await auth.bootstrap('reed', 'Reed', password);
  const login = (username: string) =>
    auth.login({ username, password, remember: false }, undefined);
  const owner = await login('reed');
  const accounts = [owner];
  for (const [username, displayName] of [
    ['kestrel', 'Kestrel'],
    ['nova', 'Nova'],
    ['moss', 'Moss'],
    ['echo', 'Echo'],
    ['astral_cartographer_of_outer_rim', 'Astral Cartographer of the Outer Rim'],
    ['sol', 'Sol'],
  ] as const) {
    const member = await auth.register({ username, displayName, password });
    await auth.changeStatus(owner.token, member.id, 'approve');
    accounts.push(await login(username));
  }
  const category = await chat.createCategory(owner.token, { name: 'Clubhouse' });
  const gameNight = await chat.createCategory(owner.token, { name: 'Game nights', position: 1 });
  const lounge = await chat.create(owner.token, {
    kind: 'channel',
    name: 'the-lounge',
    categoryId: category.id,
    topic: 'After hours, between games.',
  });
  const highlights = await chat.create(owner.token, {
    kind: 'channel',
    name: 'highlights',
    categoryId: category.id,
    position: 1,
  });
  for (const name of ['looking-for-group', 'loadouts', 'raid-planning']) {
    await chat.create(owner.token, { kind: 'channel', name, categoryId: gameNight.id });
  }
  await chat.create(owner.token, { kind: 'dm', userId: accounts[1]!.auth.user.id });
  if (finalUx) {
    for (const account of accounts.slice(2, 5)) {
      await chat.create(owner.token, { kind: 'dm', userId: account.auth.user.id });
    }
    await chat.create(owner.token, {
      kind: 'group',
      name: 'Night crew',
      userIds: accounts.slice(1, 4).map((account) => account.auth.user.id),
    });
  }

  const latest: [number, string][] = [
    [1, 'Anyone around for a late run? The new map just dropped.'],
    [1, 'The relay station looks completely different at night.'],
    [2, 'I’m here. Grabbing the last update now.'],
    [0, 'Give me five. Still deciding whether the shotgun counts as a strategy.'],
    [3, 'It absolutely counts.'],
    [
      2,
      'Has anyone figured out the shortcut behind the relay station? Every time I jump from the gantry I land on the wrong platform.',
    ],
    [
      5,
      'Follow the blue lights on the left. Skip the first ledge and jump when the second antenna passes your shoulder.',
    ],
    [3, 'Oh, THAT ledge.'],
    [1, 'We can practice the route before we queue. Voice is open whenever you’re ready.'],
    [0, 'Perfect. I’ll bring the support kit this time.'],
    [0, 'Unless somebody else wants it?'],
    [4, 'I saved the last run in highlights if anyone wants to compare routes.'],
    [
      5,
      'Bring it! We can swap after the first checkpoint. I marked the two side paths in the notes. The west door stays locked until both switches are on, so wait for me at the second antenna before you take the jump.',
    ],
    [2, 'Update finished. See you in the lounge!'],
  ];
  for (let i = 0; i < 67; i++) {
    const [author, body]: [number, string] =
      i < 67 - latest.length
        ? [
            i % accounts.length,
            i === 48
              ? 'Replay code: ' + 'Q7x5k'.repeat(62)
              : 'Practice lap ' + (i + 1) + ' complete.',
          ]
        : latest[i - (67 - latest.length)]!;
    await chat.send(accounts[author]!.token, lounge.id, { body, clientId: randomUUID() });
  }
  // Fix the timestamp rhythm so both passes show the same conversation.
  await fixture.database.pool.query(
    "UPDATE messages SET created_at=date_trunc('day',now()) + interval '17 hours' + seq * interval '2 minutes' WHERE conversation_id=$1",
    [lounge.id],
  );
  for (const account of accounts) await chat.markRead(account.token, lounge.id, { seq: '67' });
  await mkdir(directory, { recursive: true });
  server = createApp({
    staticRoot: fileURLToPath(dist),
    databaseUrl: fixture.url,
    allowedOrigins: [origin],
    rateLimits: false,
    voiceConfig: { ...config, prefix: 'design-review-' + randomUUID() },
  });
  await server.app.listen({ host: '127.0.0.1', port });
  for (const account of accounts.slice(1, 5)) {
    const peer = io(origin, {
      extraHeaders: { origin, cookie: 'tricord_session=' + account.token },
      auth: { csrfToken: account.auth.csrfToken },
      transports: ['websocket'],
      reconnection: false,
    });
    peers.push(peer);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture peer failed to connect')), 6000);
      peer.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      peer.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  const page = await launch({ fakeMicrophone: true, visible: review });
  browsers.push(page);
  await page.call('Network.setCookie', {
    name: 'tricord_session',
    value: owner.token,
    url: origin,
    httpOnly: true,
    sameSite: 'Strict',
  });
  if (!review)
    await page.call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  await page.call('Page.navigate', { url: origin });
  await page.wait("document.querySelectorAll('.message-scroll [data-message-id]').length>=45");
  await page.js('document.querySelector(\'[aria-label="Dismiss notification setup"]\')?.click()');
  if (review) {
    await checkStreams(page, owner.token, accounts[1]!.token);
    console.log(
      'Local workspace review is ready. Close the preview window or press Ctrl+C here to clean up its sample database.',
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      page.ws.addEventListener('close', () => resolve(), { once: true });
    });
  } else {
    const report = [];
    for (const [width, height] of layouts) {
      await resize(page, width, height);
      if (before)
        await page.js(
          "document.querySelector('.message-scroll').scrollTop=document.querySelector('.message-scroll').scrollHeight",
        );
      await capture(page, width + 'x' + height);
      if (!before)
        assert.ok(
          Number(await page.js(distanceFromLatest)) < 2,
          'Lost latest message at width ' + width,
        );
      const geometry = (await page.js(`(()=>{
      const history=document.querySelector('.message-scroll'),form=document.querySelector('textarea[name=message]').getBoundingClientRect();
      const text=getComputedStyle(document.querySelector('.message-body'));
      return {actualWidth:innerWidth,actualHeight:innerHeight,pageOverflow:document.documentElement.scrollWidth-innerWidth,
        messageOverflow:history.scrollWidth-history.clientWidth,composerVisible:form.top>=0 && form.bottom<=innerHeight,
        rows:history.querySelectorAll('[data-message-id]').length,font:text.fontFamily,
        textSize:text.fontSize,lineHeight:text.lineHeight,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
    })()`)) as {
        pageOverflow: number;
        messageOverflow: number;
        composerVisible: boolean;
        textSize: string;
        lineHeight: string;
        reducedMotion: boolean;
      };
      report.push({ width, height, ...geometry });
      if (!before) {
        assert.equal(geometry.pageOverflow, 0, 'Page overflow at ' + width);
        assert.equal(geometry.messageOverflow, 0, 'Timeline overflow at ' + width);
        assert.ok(geometry.composerVisible, 'Composer out of view at ' + width);
        assert.equal(geometry.textSize, '15px');
        assert.equal(geometry.lineHeight, '23px');
        assert.equal(geometry.reducedMotion, true);
      }
    }
    if (!before) {
      await resize(page, 1440, 900);
      await page.js("document.querySelector('.message-scroll').scrollTop = 96");
      await page.wait("!!document.querySelector('.jump-latest')");
      await resize(page, 390, 844);
      await page.js(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      assert.ok(
        Number(await page.js(distanceFromLatest)) > 48,
        'Resizing must leave a reader in history',
      );
      assert.ok(await page.js("!!document.querySelector('.jump-latest')"));
      await page.js(
        "document.querySelector('.message-scroll').scrollTop = document.querySelector('.message-scroll').scrollHeight",
      );
      await page.wait("!document.querySelector('.jump-latest')");
      await checkMobileKeyboard(page);
    }
    await resize(page, 1440, 900);
    if (!before) {
      assert.equal(await page.js("!!document.querySelector('#workspace-activity')"), false);
      await page.js("document.querySelector('button[aria-controls=workspace-activity]').click()");
      await page.wait("!!document.querySelector('#workspace-activity [data-member-id]')");
      await capture(page, 'activity');
      await page.js("document.querySelector('button[aria-controls=workspace-activity]').click()");
      await page.wait("!document.querySelector('#workspace-activity')");
      await page.js("document.querySelector('.conversation-jump').click()");
      await page.wait("document.activeElement?.getAttribute('role')==='combobox'");
      await capture(page, 'switcher');
      await key(page, 'Escape');
      await page.wait("!document.querySelector('dialog[open]')");
    }
    await page.js("document.querySelector('textarea[name=message]').focus()");
    // Observe real row subtrees while the native input dispatches a draft edit.
    await page.js(`window.reviewMutations=0;window.reviewObserver=new MutationObserver(records=>window.reviewMutations+=records.length);
    for(const row of document.querySelectorAll('.message-scroll [data-message-id]'))window.reviewObserver.observe(row,{subtree:true,childList:true,attributes:true,characterData:true});`);
    const frameDelays: number[] = [];
    for (const text of ['Meet ', 'at ', 'the ', 'south ', 'gate.']) {
      await page.js(`void (window.reviewFrame = new Promise(resolve => {
        document.querySelector('textarea[name=message]').addEventListener('input', () => {
          const start = performance.now();
          requestAnimationFrame(() => resolve(performance.now() - start));
        }, {once:true});
      }))`);
      await page.call('Input.insertText', { text });
      frameDelays.push(Number(await page.js('window.reviewFrame')));
    }
    await page.wait(
      "document.querySelector('textarea[name=message]').value==='Meet at the south gate.'",
    );
    await page.js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    const rowMutations = await page.js('window.reviewObserver.disconnect();window.reviewMutations');
    assert.equal(rowMutations, 0);
    for (const id of [highlights.id, lounge.id]) {
      await page.js(`document.querySelector('[data-conversation-id="${id}"]').click()`);
      await page.wait(
        `document.querySelector('[data-conversation-id="${id}"]').classList.contains('selected')`,
      );
    }
    assert.equal(
      await page.js("document.querySelector('textarea[name=message]').value"),
      'Meet at the south gate.',
    );
    if (finalUx) {
      await page.js('document.querySelector(\'[aria-label="Settings"]\').click()');
      await page.click('Appearance');
      for (const theme of ['retro', 'original']) {
        await page.js(
          `document.querySelector('.appearance-swatch-${theme}').closest('button').click()`,
        );
        await page.wait(`document.documentElement.dataset.appearance === '${theme}'
          && localStorage.getItem('rajcord-appearance') === '${theme}'
          && document.querySelector('.appearance-swatch-${theme}').closest('button').getAttribute('aria-pressed') === 'true'`);
      }
      await page.js('document.querySelector(\'[aria-label="Close settings"]\').click()');
      assert.equal(
        await page.js("document.querySelector('textarea[name=message]').value"),
        'Meet at the south gate.',
      );
    }
    await checkPins(page, (id) => new ChatFeatures(chat).pin(owner.token, lounge.id, id, false));
    const reader = [...server.io.sockets.sockets.values()].find(
      (socket) => socket.data.auth.user.id === owner.auth.user.id,
    );
    assert.ok(reader, 'Workspace reader must have an authenticated realtime session');
    reader.conn.close();
    await page.wait("!!document.querySelector('[data-connection=disconnected]')");
    await capture(page, 'reconnecting');
    await page.wait("!!document.querySelector('[data-connection=connected]')");
    assert.equal(
      await page.js("document.querySelector('textarea[name=message]').value"),
      'Meet at the south gate.',
    );
    await checkStreams(page, owner.token, accounts[1]!.token);
    await writeFile(
      new URL(label + '-metrics.json', directory),
      JSON.stringify(
        {
          layouts: report,
          unchangedRowDomMutations: rowMutations,
          inputToNextFrameMs: frameDelays,
        },
        null,
        2,
      ),
    );
    console.log(
      label +
        ': five viewport captures, long history, drafts, loading/retry, connected voice, synthetic screen publishing and received video passed.',
    );
  }
} finally {
  for (const peer of peers) peer.disconnect();
  try {
    await Promise.all(browsers.map((browser) => browser.close()));
  } finally {
    try {
      await server?.app.close();
    } finally {
      await fixture.cleanup();
    }
  }
}
