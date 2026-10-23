import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { session } from 'electron';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
// Private test harness: enabled only by --auth-smoke with a separate disposable profile.
export async function runAuthSmoke(win: BrowserWindow, target: string) {
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
    await js("document.querySelector('button[aria-label=Settings]').click()");
    await wait("!!document.querySelector('input[name=displayName]')");
    await fill({ displayName: 'Verified desktop member' });
    await click('Save name');
    await wait("document.body.innerText.includes('Display name saved.')");
    await click('Sign out of Tricord');
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
    await js("document.querySelector('button[aria-label=Settings]').click()");
    await wait("!!document.querySelector('[role=dialog]')");
    await click('Sign out of Tricord');
    await wait("!!document.querySelector('input[name=username]')");
  }
  assert.equal(await js('Object.keys(localStorage).length'), 0);
  fs.writeFileSync(
    path.join(process.env.TRICORD_TEST_PROFILE!, 'smoke-' + payload.stage + '.json'),
    JSON.stringify({ passed: true }),
  );
}
