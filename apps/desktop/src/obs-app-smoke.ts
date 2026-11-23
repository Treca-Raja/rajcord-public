import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWindow, desktopCapturer, screen, session } from 'electron';
import { screenPickerUrl } from './screen-picker.js';

export function showDesktopViewer(win: BrowserWindow) {
  const position = process.env.RAJCORD_TEST_ROOM_WINDOW;
  if (position === 'left' || position === 'right') {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.floor(area.width / 2);
    win.setBounds({
      x: area.x + (position === 'right' ? width : 0),
      y: area.y,
      width,
      height: Math.floor(area.height * 0.8),
    });
  }
  if (position !== 'background') win.show();
  console.log('RAJCORD_DESKTOP_VIEWER_READY');
}

export async function nativeScreenSmoke(win: BrowserWindow, origin: string) {
  const token = process.env.RAJCORD_TEST_SESSION;
  assert.match(token ?? '', /^[0-9a-f]{64}$/);
  delete process.env.RAJCORD_TEST_SESSION;
  await session.defaultSession.cookies.set({
    url: origin,
    name: 'tricord_session',
    value: token!,
    httpOnly: true,
  });
  await win.loadURL(origin);
  const title = process.env.RAJCORD_TEST_WINDOW;
  assert.match(title ?? '', /^Rajcord WGC fixture [a-f0-9-]{36}$/);
  const js = (expression: string) => win.webContents.executeJavaScript(expression, true);
  const wait = async (check: () => Promise<unknown>, stage: string) => {
    for (let n = 0; n < 180; n++) {
      if (await check()) return;
      await delay(150);
    }
    const status = await js(
      "({phase:document.querySelector('#screen-panel')?.dataset.phase, error:document.querySelector('.screen-error')?.textContent})",
    );
    const picker = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === screenPickerUrl,
    );
    const choices =
      picker &&
      (await picker.webContents.executeJavaScript(
        `({choices:document.querySelectorAll('button.source').length, fixture:[...document.querySelectorAll('button.source')].some(b=>b.title.includes(${JSON.stringify(title)})),status:document.querySelector('#status')?.textContent})`,
      ));
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const own = sources.find((s) => s.id.split(':')[1] === process.env.RAJCORD_TEST_HWND);
    throw new Error(
      stage +
        ' timed out. ' +
        JSON.stringify({
          status,
          choices,
          rawFixture: !!own,
          titleMatched: own?.name.includes(title!),
        }),
    );
  };
  const click = (label: string) =>
    wait(
      () =>
        js(
          `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);if(!b)return false;b.click();return true})()`,
        ),
      label,
    );
  const choose = (label: string, value?: string) =>
    wait(
      () =>
        js(
          `(()=>{const s=document.querySelector('select[aria-label="${label}"]');const o=s && ${value ? 'Array.from(s.options).find(o=>o.value===' + JSON.stringify(value) + ')' : 's.options[1]'};if(!o || o.disabled)return false;s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
        ),
      label,
    );
  win.show();
  await wait(() => js("!!document.querySelector('.profile-settings')"), 'Sign in');
  await js("document.querySelector('.profile-settings').click()");
  await click('Voice & audio');
  await click('Allow microphone access');
  await choose('Voice microphone');
  await choose('Voice speakers');
  await js(
    "document.querySelector('[aria-label=\"Close settings\"]').click();document.querySelector('[data-voice-channel-id]').click()",
  );
  await wait(
    () => js("document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'"),
    'Voice join',
  );
  await js("document.querySelector('.screen-launcher > button').click()");
  assert.equal(await js(`!!document.querySelector('[aria-label="Screen sender"]')`), false);
  assert.equal(await js(`document.querySelector('[aria-label="Screen encoder"]')?.value`), 'auto');
  if (process.env.RAJCORD_OBS_ENCODER)
    await choose('Screen encoder', process.env.RAJCORD_OBS_ENCODER);
  await choose('Screen source sound', 'none');
  await choose('Screen resolution', process.env.RAJCORD_TEST_VOICE_ROOM === '1' ? '1080' : '720');
  await choose('Screen frame rate', process.env.RAJCORD_TEST_VOICE_ROOM === '1' ? '60' : '30');
  if (process.env.RAJCORD_TEST_VOICE_ROOM === '1') await choose('Screen video bitrate', '12000000');
  await click('Prepare source');
  await wait(
    () => js("document.querySelector('#screen-panel')?.dataset.prepared==='true'"),
    'Prepare',
  );
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const owned = sources.find((s) => s.id.split(':')[1] === process.env.RAJCORD_TEST_HWND);
  assert.ok(
    owned &&
      owned.name.includes(title!) &&
      sources.filter((s) => s.name === owned.name).length === 1,
    'The fixture must have a visible HWND and a unique picker label.',
  );
  await click('Choose source');
  await wait(async () => {
    const picker = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === screenPickerUrl,
    );
    if (!picker) return false;
    return picker.webContents.executeJavaScript(
      `(()=>{const b=Array.from(document.querySelectorAll('button.source')).find(b=>b.title===${JSON.stringify(owned.name)});if(!b)return false;b.click();const confirm=document.querySelector('#confirm');if(confirm.disabled)return false;confirm.click();return true})()`,
      true,
    );
  }, 'Select exact fixture in isolated picker');
  await wait(
    () => js("document.querySelector('#screen-panel')?.dataset.phase==='preview'"),
    'Preview',
  );
  await click('Start sharing');
  await wait(
    () => js("document.querySelector('#screen-panel')?.dataset.phase==='sharing'"),
    'Publish',
  );
  const message = (timeout: number) =>
    Promise.race([
      new Promise<unknown>((resolve) => process.once('message', resolve)),
      delay(timeout),
    ]);
  process.send?.('published');
  let action = await message(110000);
  while (action === 'reduce-quality' || action === 'raise-quality') {
    const [height, frameRate, bitrate] =
      action === 'reduce-quality' ? ['480', '15', '4000000'] : ['1080', '60', '12000000'];
    await js('document.querySelector(\'[aria-label="Open stream settings"]\').click()');
    await choose('Screen resolution', height);
    await choose('Screen frame rate', frameRate);
    await choose('Screen video bitrate', bitrate);
    await click('Apply stream quality');
    await wait(
      () =>
        js(
          `document.querySelector('.screen-quality-badge')?.textContent.includes('${height}p ${frameRate} FPS')`,
        ),
      'Live publisher quality',
    );
    await js('document.querySelector(\'[aria-label="Close screen settings"]\').click()');
    process.send?.('quality-applied');
    action = await message(110000);
  }
  if (action === 'stop')
    assert.match(
      String(await js("document.querySelector('.screen-status')?.textContent")),
      /NVIDIA NVENC|AMD AMF|Software x264/,
      'The OBS share must report its actual encoder.',
    );
  if (action === 'stop')
    await js(
      'document.querySelector(\'#screen-panel [aria-label="Stop screen sharing"]\').click()',
    );
  else if (action === 'logout') {
    await js(`document.querySelector('button[aria-label="Settings"]').click()`);
    await click('Sign out of Rajcord');
    await wait(() => js(`!!document.querySelector('input[name="username"]')`), 'Signed out');
  } else assert.ok(['source-ended', 'helper-ended', 'revoked'].includes(String(action)));
  await wait(
    () =>
      js(
        "document.querySelector('#screen-panel')?.dataset.phase !== 'sharing' && !document.querySelector('#screen-panel [aria-label=\"Stop screen sharing\"]')",
      ),
    'Unpublish',
  );
  if (action !== 'logout' && action !== 'revoked')
    assert.equal(
      await js("document.querySelector('[data-voice-status]').dataset.voiceStatus"),
      'connected',
    );
  process.send?.('stopped');
  assert.equal(await message(25000), 'finish', 'Viewer must confirm cleanup and voice continuity.');
}
