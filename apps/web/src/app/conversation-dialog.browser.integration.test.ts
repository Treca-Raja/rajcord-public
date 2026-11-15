import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AuthService } from '../../../api/src/auth/service';
import { createApp } from '../../../api/src/app';
import { testDatabase } from '../../../api/src/db/test-database';
import { voiceConfig } from '../../../api/src/voice/config';
import { launch, type Browser } from '../../../api/src/voice/browser-harness';

it('preserves conversation dialog focus, failed group drafts, invitation boundaries and category navigation', async () => {
  const database = await testDatabase();
  let server: ReturnType<typeof createApp> | undefined;
  let browser: Browser | undefined;
  try {
    const origin = 'http://127.0.0.1:3013';
    const auth = new AuthService(database.database.pool);
    const password = randomUUID() + '-Dialog';
    const owner = await auth.bootstrap('dialog_owner', 'Dialog owner', password);
    const account = await auth.login(
      { username: owner.username, password, remember: false },
      undefined,
    );
    const friend = await auth.register({
      username: 'dialog_friend',
      displayName: 'Dialog friend',
      password,
    });
    await auth.changeStatus(account.token, friend.id, 'approve');
    const config = voiceConfig();
    if (!config) throw new Error('Local voice fixture services are not configured.');
    server = createApp({
      databaseUrl: database.url,
      allowedOrigins: [origin],
      rateLimits: false,
      voiceConfig: { ...config, prefix: 'dialog-ui-' + randomUUID() + '-' },
      staticRoot: fileURLToPath(new URL('../../dist', import.meta.url)),
    });
    await server.app.listen({ host: '127.0.0.1', port: 3013 });
    const page = await launch({ fakeMicrophone: false });
    browser = page;
    await page.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__dialogCaptureCalls=0;
        for(const method of ['getUserMedia','getDisplayMedia'])navigator.mediaDevices[method]=async()=>{
          window.__dialogCaptureCalls++;throw Error('Dialog fixtures must not capture media');
        };`,
    });
    await page.call('Network.setCookie', {
      name: 'tricord_session',
      value: account.token,
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    });
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.call('Page.navigate', { url: origin });
    await page.wait(
      "!!document.querySelector('[aria-label=\"Create group\"]') && !!document.querySelector('.message-scroll')",
    );
    await page.js('document.querySelector(\'[aria-label="Toggle navigation"]\').click()');
    await page.wait("document.querySelector('.shell').classList.contains('mobile-open')");
    const open = async (label: string) => {
      await page.js(
        `(()=>{const button=document.querySelector('button[aria-label="${label}"]');button.focus();button.click()})()`,
      );
      await page.wait("!!document.querySelector('.chat-dialog')");
    };
    const escape = () =>
      page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await open('Create group');
    await page.wait(
      "document.activeElement===document.querySelector('.chat-dialog input[name=name]')",
    );
    expect(
      await page.js(`!!document.querySelector('.chat-dialog input[value="${owner.id}"]')`),
    ).toBe(false);
    expect(
      await page.js(
        `!!document.querySelector('.chat-dialog input[name=userIds][value="${friend.id}"]')`,
      ),
    ).toBe(true);
    await page.js("document.querySelector('.chat-dialog .primary').focus()");
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    });
    expect(await page.js("document.activeElement.getAttribute('aria-label')")).toBe('Close dialog');
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    });
    expect(
      await page.js("document.activeElement===document.querySelector('.chat-dialog .primary')"),
    ).toBe(true);
    await page.js(
      `(()=>{const form=document.querySelector('.chat-dialog form');form.elements.name.focus();form.elements.name.value='   ';form.querySelector('input[value="${friend.id}"]').checked=true;form.requestSubmit()})()`,
    );
    await page.wait(
      "!!document.querySelector('.chat-dialog .form-error') && !document.querySelector('.chat-dialog .primary').disabled",
    );
    expect(await page.js("document.querySelector('.chat-dialog input[name=name]').value")).toBe(
      '   ',
    );
    expect(
      await page.js(`document.querySelector('.chat-dialog input[value="${friend.id}"]').checked`),
    ).toBe(true);
    expect(
      await page.js(
        "document.activeElement===document.querySelector('.chat-dialog input[name=name]')",
      ),
    ).toBe(true);
    expect(
      await page.js(
        "document.documentElement.scrollWidth<=innerWidth && document.querySelector('.chat-dialog').scrollWidth<=document.querySelector('.chat-dialog').clientWidth",
      ),
    ).toBe(true);
    const artifacts = fileURLToPath(new URL('../../../../artifacts', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      artifacts + '/conversation-dialog-group-error-mobile.png',
      Buffer.from(shot.data as string, 'base64'),
    );
    await page.js(
      "(()=>{const form=document.querySelector('.chat-dialog form');form.elements.name.value='Dialog fixture group';form.requestSubmit()})()",
    );
    await page.wait(
      "!document.querySelector('.chat-dialog') && document.querySelector('.channel-header strong').textContent==='Dialog fixture group'",
    );
    await page.wait("document.activeElement.getAttribute('aria-label')==='Create group'");
    // Successful creation closes the dialog and restores focus to its trigger.
    expect(await page.js("document.activeElement.getAttribute('aria-label')")).toBe('Create group');
    const group = (
      await database.database.pool.query(
        "SELECT id FROM conversations WHERE kind='group' AND name=$1",
        ['Dialog fixture group'],
      )
    ).rows[0];
    expect(
      (
        await database.database.pool.query(
          'SELECT user_id FROM memberships WHERE conversation_id=$1 AND end_seq IS NULL',
          [group.id],
        )
      ).rows,
    ).toEqual([{ user_id: owner.id }]);
    expect(
      (
        await database.database.pool.query(
          'SELECT invitee_id,status FROM invitations WHERE conversation_id=$1',
          [group.id],
        )
      ).rows,
    ).toEqual([{ invitee_id: friend.id, status: 'pending' }]);
    await open('New direct message');
    await page.wait("document.activeElement.getAttribute('aria-label')==='Close dialog'");
    expect(
      await page.js(`!!document.querySelector('.chat-dialog option[value="${owner.id}"]')`),
    ).toBe(false);
    await page.js(
      `(()=>{const form=document.querySelector('.chat-dialog form');form.elements.userId.value='${friend.id}';form.requestSubmit()})()`,
    );
    await page.wait(
      "!document.querySelector('.chat-dialog') && document.querySelector('.channel-header strong').textContent.includes('Dialog friend')",
    );
    expect(await page.js("document.activeElement.getAttribute('aria-label')")).toBe(
      'New direct message',
    );
    await open('Create channel');
    await page.wait(
      "document.activeElement===document.querySelector('.chat-dialog input[name=name]')",
    );
    await page.js("document.querySelector('.chat-dialog .text-button').click()");
    await page.wait('!!document.querySelector(\'form[aria-label="Create category"]\')');
    await escape();
    await page.wait("!document.querySelector('.chat-dialog')");
    await open('Create channel');
    await escape();
    await page.wait("!document.querySelector('.chat-dialog')");
    expect(await page.js("document.activeElement.getAttribute('aria-label')")).toBe(
      'Create channel',
    );
    expect(await page.js('window.__dialogCaptureCalls')).toBe(0);
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.app.close();
      } finally {
        await database.cleanup();
      }
    }
  }
});
