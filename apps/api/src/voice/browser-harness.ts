import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
export type Browser = Awaited<ReturnType<typeof launch>>;
export async function launch() {
  const profile = await mkdtemp(path.join(tmpdir(), 'tricord-voice-browser-'));
  const wav = Buffer.alloc(44 + 48000 * 2 * 4);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000 * 4; i++)
    wav.writeInt16LE(
      Math.round(5000 * Math.sin((i * 2 * Math.PI * 440) / 48000) * (Math.floor(i / 12000) % 2)),
      44 + i * 2,
    );
  const audio = path.join(profile, 'tone.wav');
  await writeFile(audio, wav);
  const child = spawn(
    process.env.TRICORD_BROWSER_PATH ||
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + audio,
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let launchError: Error | undefined;
  child.on('error', (error) => {
    launchError = error;
  });
  const cleanup = async () => {
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++)
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++)
      await delay(100);
    if (child.exitCode === null && child.signalCode === null && !launchError)
      throw new Error('Test browser did not exit');
    if (
      path.dirname(profile) !== path.resolve(tmpdir()) ||
      !path.basename(profile).startsWith('tricord-voice-browser-')
    )
      throw new Error('Refusing unexpected test profile cleanup');
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    let port = '';
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      try {
        port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!;
        break;
      } catch {
        await delay(100);
      }
    }
    assert.match(port, /^\d+$/);
    const pages = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const ws = new WebSocket(pages.find((p) => p.type === 'page')!.webSocketDebuggerUrl);
    let sequence = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data));
      const request = pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error.message));
      else request.resolve(data.result);
    });
    ws.addEventListener('close', () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Test browser closed'));
      }
      pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP failed')), { once: true });
    });
    const call = (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('CDP timeout: ' + method));
          }, 20000);
        pending.set(id, {
          resolve: (value) => resolve(value as Record<string, unknown>),
          reject,
          timer,
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const js = async (expression: string) => {
      const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails)
        throw new Error('Browser JS failed: ' + JSON.stringify(result.exceptionDetails));
      return (result.result as { value: unknown }).value;
    };
    const wait = async (expression: string) => {
      for (let i = 0; i < 200; i++) {
        if (await js(expression)) return;
        await delay(100);
      }
      throw new Error(
        'Voice browser timeout: ' + expression + '; UI: ' + (await js('document.body.innerText')),
      );
    };
    const click = async (label: string) =>
      js(
        "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===" +
          JSON.stringify(label) +
          ");if(!b)throw Error('Missing button');b.click()})()",
      );
    const httpErrors: { status: number; path: string }[] = [];
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data));
      if (data.method === 'Network.responseReceived' && data.params.response.status >= 400) {
        const target = new URL(data.params.response.url);
        if (target.pathname.startsWith('/api/'))
          httpErrors.push({ status: data.params.response.status, path: target.pathname });
      }
    });
    await call('Network.enable');
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "window.__voiceOpens=0;const Socket=window.WebSocket;window.WebSocket=class extends Socket{constructor(...args){super(...args);if(String(args[0]).includes('/media/'))this.addEventListener('open',()=>window.__voiceOpens++)}};window.__peers=[];const Original=window.RTCPeerConnection;window.RTCPeerConnection=class extends Original{constructor(...args){super(...args);window.__peers.push(this);}};window.__captureCount=0;window.__captures=[];const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(...args)=>{window.__captureCount++;const stream=await capture(...args);window.__captures.push(...stream.getTracks());return stream};",
    });
    return {
      child,
      ws,
      httpErrors,
      call,
      js,
      wait,
      click,
      close: async () => {
        try {
          await call('Browser.close');
        } catch {
          child.kill();
        }
        ws.close();
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Test browser closed'));
        }
        pending.clear();
        await cleanup();
      },
    };
  } catch (error) {
    child.kill();
    await cleanup();
    throw error;
  }
}
export async function setup(browser: Browser, token: string, origin: string) {
  await browser.call('Network.setCookie', {
    name: 'tricord_session',
    value: token,
    url: origin,
    httpOnly: true,
    sameSite: 'Strict',
  });
  await browser.call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 980,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.call('Page.navigate', { url: origin });
  await browser.wait("!!document.querySelector('.voice-settings-toggle')");
  await browser.js("document.querySelector('.voice-settings-toggle').click()");
  await browser.click('Find audio devices');
  await browser.wait(
    'document.querySelector(\'select[aria-label="Voice microphone"]\').options.length>1',
  );
  for (const label of ['Voice microphone', 'Voice speakers']) {
    await browser.js(
      "(()=>{const s=document.querySelector('select[aria-label=" +
        JSON.stringify(label) +
        "]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
  }
  await browser.wait(
    '!document.querySelector(\'select[aria-label="Join voice channel"]\').disabled',
  );
  await browser.js(
    "(()=>{const s=document.querySelector('select[aria-label=\"Join voice channel\"]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await browser.wait(
    "document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'",
  );
}
