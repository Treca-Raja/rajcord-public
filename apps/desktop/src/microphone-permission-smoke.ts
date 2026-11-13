import { app, BrowserWindow, session } from 'electron';
import assert from 'node:assert/strict';
import { MicrophonePermission, installMicrophonePermissions } from './microphone-permission.js';
const profile = process.env.TRICORD_MICROPHONE_SMOKE_PROFILE;
const target = process.env.TRICORD_MICROPHONE_SMOKE_ORIGIN;
const stage = process.env.TRICORD_MICROPHONE_SMOKE_STAGE;
if (!profile || !target || !stage || new URL(target).hostname !== '127.0.0.1')
  throw new Error('Loopback microphone smoke fixture required.');
app.setPath('userData', profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const capture = `(async()=>{const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
  try{return stream.getAudioTracks().length}finally{stream.getTracks().forEach(track=>track.stop())}})()`;
async function run() {
  await app.whenReady();
  let prompts = 0;
  const permission = new MicrophonePermission({
    profileDirectory: profile!,
    target: target!,
    ask: async () => {
      prompts++;
      return stage !== 'other-origin';
    },
    onError: (message) => assert.fail(message),
  });
  const remembered = stage === 'remembered' || stage === 'reset';
  assert.equal(
    permission.allowed,
    remembered,
    'Only an approved matching origin may restore consent',
  );
  assert.equal(prompts, 0, 'Startup must not prompt');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  installMicrophonePermissions(session.defaultSession, win.webContents, target!, permission);
  await win.loadURL(target!);
  const js = (source: string) => win.webContents.executeJavaScript(source, true);
  assert.equal(await js("typeof require==='undefined'&&typeof process==='undefined'"), true);
  await js('navigator.mediaDevices.enumerateDevices().then(devices=>devices.length)');
  assert.equal(prompts, 0, 'Passive inventory must not prompt');
  if (stage === 'other-origin') {
    assert.equal(
      await js(capture + ".then(()=>false,error=>error.name==='NotAllowedError')"),
      true,
    );
    assert.equal(prompts, 1);
    assert.equal(permission.allowed, false);
  } else if (stage === 'reset') {
    assert.equal(permission.reset(), true);
    assert.equal(permission.allowed, false);
  } else {
    assert.equal(await js(capture), 1);
    assert.equal(
      prompts,
      remembered ? 0 : 1,
      'Remembered approval must not ask again after restart',
    );
    assert.equal(permission.allowed, true);
    const previous = prompts;
    assert.equal(
      await js(
        "navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return false},error=>error.name==='NotAllowedError')",
      ),
      true,
    );
    await js(
      "new Promise(resolve=>{const frame=document.createElement('iframe');frame.src='/frame';frame.onload=()=>resolve(true);document.body.append(frame)})",
    );
    const frame = win.webContents.mainFrame.frames[0]!;
    assert.equal(
      await frame.executeJavaScript(
        capture + ".then(()=>false,error=>error.name==='NotAllowedError')",
        true,
      ),
      true,
    );
    const other = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await other.loadURL(target!);
    assert.equal(
      await other.webContents.executeJavaScript(
        capture + ".then(()=>false,error=>error.name==='NotAllowedError')",
        true,
      ),
      true,
    );
    other.destroy();
    assert.equal(prompts, previous, 'Untrusted requests must not reach the consent dialog');
  }
  win.destroy();
  console.log('PASS Electron microphone permission: ' + stage);
}
void run().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error);
    app.exit(1);
  },
);
