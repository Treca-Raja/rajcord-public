/* This entry point is included only in disposable acceptance installers. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRequire } = require('node:module');
const load = createRequire(__filename);
const assert = load('node:assert/strict');
const fs = load('node:fs');
const path = load('node:path');
const port = 39475;
const installerName = 'Rajcord-Setup-0.1.2-x64.exe';
const manifestName = 'rajcord-windows-update.json';
const { RAJCORD_FIXTURE_DIR: location, RAJCORD_FIXTURE_ROLE: role } = process.env;
assert.ok(location && path.isAbsolute(location));

if (role === 'feed') {
  const http = load('node:http');
  const files = new Map([
    ['/releases/latest/download/' + manifestName, manifestName],
    ['/releases/download/v0.1.2/' + installerName, installerName],
  ]);
  http
    .createServer((request, response) => {
      if (request.url === '/ready') return response.end('ready');
      const name = files.get(request.url);
      if (request.method !== 'GET' || !name) {
        response.statusCode = 404;
        return response.end();
      }
      const file = path.join(location, name);
      response.setHeader('Content-Length', fs.statSync(file).size);
      fs.appendFileSync(path.join(location, 'requests.txt'), name + '\n');
      fs.createReadStream(file).pipe(response);
    })
    .listen(port, '127.0.0.1');
} else if (role === 'idle') {
  load('electron').app.exit(0);
} else {
  assert.ok(['decline', 'install', 'probe'].includes(role));
  const { app, dialog, shell } = load('electron');
  app.setPath('userData', path.join(app.getPath('appData'), 'Rajcord'));
  const marker = path.join(app.getPath('userData'), 'upgrade-fixture-profile.txt');
  const failure = (error) => {
    fs.writeFileSync(path.join(location, 'error.txt'), String(error.stack ?? error));
    app.exit(1);
  };
  const observe = (name, data) =>
    fs.writeFileSync(path.join(location, name + '.json'), JSON.stringify(data));
  app
    .whenReady()
    .then(async () => {
      if (role === 'probe') {
        assert.equal(app.getVersion(), '0.1.2');
        assert.equal(fs.readFileSync(marker, 'utf8'), 'same profile after upgrade');
        observe('upgraded', { version: app.getVersion(), profilePreserved: true });
        app.exit(0);
        return;
      }
      assert.equal(app.getVersion(), '0.1.1');
      if (role === 'decline') {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, 'same profile after upgrade', { flag: 'wx' });
      }
      assert.equal(fs.readFileSync(marker, 'utf8'), 'same profile after upgrade');
      let offered = false;
      let prepared = false;
      dialog.showMessageBox = async (options) => {
        assert.equal(options.title, 'Rajcord update', options.message);
        assert.deepEqual(options.buttons, ['Later', 'Download and install']);
        offered = true;
        return { response: role === 'install' ? 1 : 0 };
      };
      shell.openPath = async (file) => {
        assert.equal(role, 'install');
        assert.ok(offered && prepared);
        assert.equal(path.basename(file), installerName);
        assert.match(fs.readFileSync(file + ':Zone.Identifier', 'utf8'), /ZoneId=3/);
        // The runner opens the recorded installer after Rajcord has exited.
        observe('installer', { file, internetZone: true });
        return '';
      };
      const { configureUpdates } = load('./updates.js');
      await configureUpdates(async () => {
        prepared = true;
      }).check();
      assert.ok(offered);
      if (role === 'decline') {
        assert.equal(prepared, false);
        observe('declined', { version: app.getVersion() });
        app.exit(0);
      }
    })
    .catch(failure);
}
