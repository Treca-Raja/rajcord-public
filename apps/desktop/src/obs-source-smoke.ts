import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';

function sourceMarker() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 10;
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:10px';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d')!;
  const paint = () => {
    const stamp = Date.now() & 0xffffff;
    const word = stamp | (((stamp ^ (stamp >> 8) ^ (stamp >> 16) ^ 0xa5) & 255) << 24);
    for (let bit = 0; bit < 32; bit++) {
      context.fillStyle = word & (1 << bit) ? '#fff' : '#000';
      context.fillRect(bit * 10, 0, 10, 10);
    }
    requestAnimationFrame(paint);
  };
  paint();
}

async function run() {
  const directory = process.env.TRICORD_TEST_PROFILE;
  const title = process.env.RAJCORD_TEST_WINDOW;
  assert(
    directory &&
      path.isAbsolute(directory) &&
      title &&
      /^Rajcord WGC fixture [a-f0-9-]{36}$/.test(title),
  );
  app.setPath('userData', directory);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  await app.whenReady();
  const win = new BrowserWindow({
    title,
    width: 1920,
    height: 1080,
    frame: false,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.on('page-title-updated', (event) => event.preventDefault());
  const video = process.env.RAJCORD_SCREEN_BENCH_VIDEO;
  const file = path.join(directory, 'source.html');
  await writeFile(
    file,
    `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src file:; style-src 'unsafe-inline'">
    <style>*{margin:0}body{background:navy;overflow:hidden}video{width:100vw;height:100vh;object-fit:fill}
    div{width:15vw;height:100vh;background:orange;animation:move 1s linear infinite alternate}@keyframes move{to{transform:translateX(80vw)}}</style>` +
      (video ? '<video muted loop></video>' : '<div></div>'),
  );
  await win.loadFile(file);
  if (video)
    await win.webContents.executeJavaScript(
      `(async()=>{const v=document.querySelector('video');v.src=${JSON.stringify(pathToFileURL(path.resolve(video)).href)};await v.play()})()`,
      true,
    );
  if (
    process.env.RAJCORD_SCREEN_BENCH_MARKER === '1' &&
    process.env.RAJCORD_SCREEN_BENCH_INDEXED !== '1'
  )
    await win.webContents.executeJavaScript('(' + sourceMarker.toString() + ')()');
  win.setTitle(title);
  process.send?.(win.getNativeWindowHandle().readBigUInt64LE().toString());
  let otherWindow: BrowserWindow | undefined;
  process.on('message', async (request) => {
    if (request === 'frames' && video) {
      const frames = await win.webContents.executeJavaScript(
        `(()=>{const q=document.querySelector('video').getVideoPlaybackQuality();return q.totalVideoFrames-q.droppedVideoFrames})()`,
      );
      process.send?.(frames);
    }
    if (process.env.RAJCORD_SCREEN_BENCH_WINDOW_LIFECYCLE !== '1') return;
    if (request === 'focus-other') {
      otherWindow ??= new BrowserWindow({
        width: 320,
        height: 180,
        backgroundColor: '#00ff00',
      });
      otherWindow.show();
      otherWindow.focus();
      process.send?.(otherWindow.isFocused() && !win.isFocused());
    } else if (request === 'resize') {
      win.setContentSize(1280, 960);
      process.send?.(win.getContentSize());
    } else if (request === 'minimize') {
      win.minimize();
      process.send?.(true);
    } else if (request === 'restore') {
      win.restore();
      process.send?.(true);
    }
  });
  process.once('disconnect', () => app.quit());
}
run().catch((error) => {
  console.error(error);
  app.exit(1);
});
