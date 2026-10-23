import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
const smoke = process.argv.includes('--smoke');
const local = path.resolve(__dirname, '../.local');
fs.mkdirSync(local, { recursive: true });
app.setPath('userData', local);
app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 720,
      minHeight: 600,
      show: !smoke,
      backgroundColor: '#16191f',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (smoke) win.webContents.on('console-message', (event) => console.log(event.message));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    const dev = process.env.TRICORD_DEV_URL;
    if (dev && dev !== 'http://127.0.0.1:5173')
      throw new Error('Only the local development origin is permitted.');
    if (dev) await win.loadURL(dev);
    else await win.loadFile(path.resolve(__dirname, '../../web/dist/index.html'));
    if (smoke) {
      const artifacts = path.resolve(__dirname, '../../../artifacts');
      fs.mkdirSync(artifacts, { recursive: true });
      let result;
      try {
        result = await win.webContents.executeJavaScript(
          `new Promise((resolve,reject)=>{const end=Date.now()+15000;const timer=setInterval(()=>{if(document.querySelector('[data-connection="connected"]')){clearInterval(timer);resolve({title:document.title,connected:true,isolated:typeof require==='undefined'&&typeof process==='undefined',desktop:window.tricordDesktop?.platform})}else if(Date.now()>end){clearInterval(timer);reject(new Error('API connection timed out'))}},100)})`,
        );
        try {
          fs.writeFileSync(
            path.join(artifacts, 'desktop.png'),
            (
              await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
            ).toPNG(),
          );
        } catch {
          console.warn(
            'Hidden-window screenshot unavailable; renderer and connection checks completed.',
          );
        }
        fs.writeFileSync(path.join(artifacts, 'desktop.json'), JSON.stringify(result, null, 2));
        app.exit((result as { isolated: boolean }).isolated ? 0 : 1);
      } catch (error) {
        console.log(await win.webContents.executeJavaScript('document.body.innerText'));
        console.error(error);
        app.exit(1);
      }
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
