import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { session } from 'electron';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
// Private test harness: enabled only by --auth-smoke with a separate disposable profile.
export async function runAuthSmoke(win: BrowserWindow, target: string) {
  const chatOnly = process.env.TRICORD_CHAT_SMOKE_ONLY === '1';
  const raw = process.env.TRICORD_SMOKE_INPUT;
  delete process.env.TRICORD_SMOKE_INPUT;
  if (!raw) throw new Error('Smoke fixture required.');
  const payload = JSON.parse(raw) as {
    stage: 'temporary' | 'remember' | 'restore';
    username: string;
    password: string;
  };
  const js = (source: string) => win.webContents.executeJavaScript(source);
  async function wait(expression: string) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await js(expression)) return;
      await delay(100);
    }
    throw new Error('Desktop UI assertion timed out: ' + expression);
  }
  async function click(label: string) {
    await js(
      "(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===" +
        JSON.stringify(label) +
        ");if(!button)throw new Error('Button missing');button.click();})()",
    );
  }
  async function fill(values: Record<string, string>) {
    await js(
      '(()=>{const values=' +
        JSON.stringify(values) +
        ";for(const [key,value] of Object.entries(values)){const input=document.querySelector('input[name='+key+']');if(!input)throw new Error('Input missing');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}})()",
    );
  }
  async function login(remember: boolean) {
    await wait("!!document.querySelector('input[name=username]')");
    await fill({ username: payload.username, password: payload.password });
    if (remember) await js("document.querySelector('input[name=remember]').click()");
    await js("document.querySelector('form').requestSubmit()");
  }
  async function checkLinks() {
    for (const href of [
      'https://example.com/desktop',
      'https://example.com/docs',
      'https://example.com/reply',
    ]) {
      const selector = '.message-body a[href="' + href + '"]';
      await wait('!!document.querySelector(' + JSON.stringify(selector) + ')');
      assert.equal(
        await js(
          '(()=>{const a=document.querySelector(' +
            JSON.stringify(selector) +
            ');return a.target==="_blank" && a.rel==="noopener noreferrer" && a.title===a.href})()',
        ),
        true,
      );
    }
  }
  await wait("!!document.querySelector('.auth-card,.shell')");
  assert.equal(
    await js(
      "typeof require==='undefined'&&typeof process==='undefined'&&window.tricordDesktop.platform==='win32'",
    ),
    true,
  );
  if (payload.stage === 'temporary') {
    await click('Create an account');
    await fill({
      username: payload.username,
      password: payload.password,
      displayName: 'Desktop test member',
    });
    await js("document.querySelector('form').requestSubmit()");
    await wait("!!document.querySelector('input[name=remember]')");
    await login(false);
    await wait("!!document.querySelector('[data-account-status=pending]')");
    assert.equal(await js("!!document.querySelector('.shell')"), false);
    console.log('TRICORD_SMOKE_PENDING');
    await wait("!!document.querySelector('[data-connection=connected]')");
    await wait("!!document.querySelector('[data-presence-state=ready] [data-presence=online]')");
    const originalSize = win.getSize();
    win.setSize(620, 820);
    await wait(
      "getComputedStyle(document.querySelector('button[aria-label=Members]')).display!=='none'",
    );
    await js(
      "document.querySelector('button[aria-label=Members]').focus();document.querySelector('button[aria-label=Members]').click()",
    );
    await wait("!!document.querySelector('[role=dialog][aria-label=Members]')");
    assert.equal(
      await js("!!document.activeElement.closest('[role=dialog][aria-label=Members]')"),
      true,
    );
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=dialog][aria-label=Members]')");
    assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Members');
    win.setSize(originalSize[0]!, originalSize[1]!);

    assert.equal(
      await js("window.tricordDesktop.notify({conversationId:'https://evil.test',mention:true})"),
      false,
    );
    assert.equal(await js('window.tricordDesktop.enableNotifications()'), true);
    assert.equal(
      await js('window.tricordDesktop.notify({conversationId:crypto.randomUUID(),mention:false})'),
      true,
    );
    await wait("!!document.querySelector('textarea[name=message]')");
    await js(
      "(()=>{const input=document.querySelector('textarea[name=message]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Electron says hello https://example.com/desktop [Docs](https://example.com/docs)');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await js('document.querySelector(\'button[aria-label="Send message"]\').click()');
    await wait("document.querySelector('textarea[name=message]').value===''");
    await wait("document.querySelector('.message-scroll').innerText.includes('Reply to Electron')");
    await checkLinks();

    if (!chatOnly) {
      assert.equal(
        await js(
          "navigator.mediaDevices.getUserMedia({video:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return false}).catch(e=>e.name==='NotAllowedError')",
        ),
        true,
      );
      await js("document.querySelector('.voice-settings-toggle').click()");
      await click('Find audio devices');
      await wait(
        'document.querySelector(\'select[aria-label="Voice microphone"]\').options.length>1',
      );
      for (const label of ['Voice microphone', 'Voice speakers']) {
        await js(
          "(()=>{const s=document.querySelector('select[aria-label=" +
            JSON.stringify(label) +
            "]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()",
        );
      }
      await wait('!document.querySelector(\'select[aria-label="Join voice channel"]\').disabled');
      await js(
        "(()=>{const s=document.querySelector('select[aria-label=\"Join voice channel\"]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()",
      );
      await wait(
        "document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'",
      );
      assert.equal(
        await js(
          "document.querySelector('button[aria-label=\"Unmute microphone\"]')?.getAttribute('aria-pressed')",
        ),
        'true',
      );
      await js('document.querySelector(\'button[aria-label="Unmute microphone"]\').click()');
      await wait("fetch('/test/voice-published').then(r=>r.json()).then(r=>r.published)");
      await js("document.querySelector('button[aria-label=Deafen]').click()");
      assert.equal(
        await js(
          "document.querySelector('button[aria-label=Deafen]').getAttribute('aria-pressed')",
        ),
        'true',
      );
      await js('document.querySelector(\'button[aria-label="Leave voice"]\').click()');
      await wait("!document.querySelector('[data-voice-status]')");
    }

    await js("document.querySelector('button[aria-label=Settings]').click()");
    await wait("!!document.querySelector('input[name=displayName]')");
    await fill({ displayName: 'Verified desktop member' });
    await click('Save name');
    await wait("document.body.innerText.includes('Display name saved.')");
    await click('Sign out of Rajcord');
    await wait("!!document.querySelector('input[name=username]')");
    await login(false);
    await wait("!!document.querySelector('.shell')");
    win.minimize();
    assert.equal((await session.defaultSession.fetch(target + '/api/auth/me')).status, 200);
    assert.equal(
      (await session.defaultSession.cookies.get({ name: 'tricord_session' }))[0]?.session,
      true,
    );
  } else if (payload.stage === 'remember') {
    assert.equal(await js("!!document.querySelector('input[name=username]')"), true);
    await login(true);
    await wait("!!document.querySelector('[data-connection=connected]')");
    assert.equal(
      (await session.defaultSession.cookies.get({ name: 'tricord_session' }))[0]?.session,
      false,
    );
  } else {
    await wait("!!document.querySelector('[data-connection=connected]')");
    assert.equal(await js("document.body.innerText.includes('Verified desktop member')"), true);
    await wait(
      "document.querySelector('.message-scroll')?.innerText.includes('Electron says hello')",
    );
    await wait(
      "document.querySelector('.message-scroll')?.innerText.includes('Reply to Electron')",
    );
    await checkLinks();
    await js("document.querySelector('button[aria-label=Settings]').click()");
    await wait("!!document.querySelector('[role=dialog]')");
    await click('Sign out of Rajcord');
    await wait("!!document.querySelector('input[name=username]')");
  }
  assert.equal(await js('Object.keys(localStorage).length'), 0);
  fs.writeFileSync(
    path.join(process.env.TRICORD_TEST_PROFILE!, 'smoke-' + payload.stage + '.json'),
    JSON.stringify({ passed: true }),
  );
}
