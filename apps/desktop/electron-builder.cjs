// No publishing from a build command. GitHub release creation is a separate workflow step.
const signed = process.env.RAJCORD_SIGNED_RELEASE === '1';
const publisher = process.env.RAJCORD_PUBLISHER_DN;
const updateKey = process.env.RAJCORD_UPDATE_PUBLIC_KEY;
const fs = process.getBuiltinModule('fs');
const path = process.getBuiltinModule('path');
if (signed) throw new Error('OBS distribution is blocked pending redistribution review.');
const stagedObs = process.env.RAJCORD_OBS_PACKAGE_BUNDLE;
if (stagedObs && !path.isAbsolute(stagedObs))
  throw new Error('RAJCORD_OBS_PACKAGE_BUNDLE must be an absolute path.');
const obsBundle = stagedObs || path.join(__dirname, 'native/obs/dist/bundle');
if (!fs.existsSync(path.join(obsBundle, 'inventory.json')))
  throw new Error('Run pnpm desktop:obs:setup before packaging Rajcord Desktop.');
const provenance = path.join(obsBundle, 'obs/source-build.json');
if (
  !fs.existsSync(provenance) ||
  JSON.parse(fs.readFileSync(provenance, 'utf8')).transport !== 'libdatachannel'
)
  throw new Error('Run pnpm desktop:obs:setup to stage the source-built native OBS package.');
const source = path.join(__dirname, 'src');
// Package only current compiler inputs, even when old output remains in dist.
const runtimeFiles = fs
  .readdirSync(source, { recursive: true, withFileTypes: true })
  .filter(
    (file) =>
      file.isFile() && file.name.endsWith('.ts') && !/(?:\.test|\.d|smoke)\.ts$/.test(file.name),
  )
  .map((file) =>
    path
      .join('dist', path.relative(source, file.parentPath), file.name.replace(/\.ts$/, '.js'))
      .replaceAll('\\', '/'),
  );
// The synchronous CommonJS builder config uses the same validator as the packaged updater.
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (updateKey && !require('./dist/update-manifest.js').updatePublicKey(updateKey))
  throw new Error('The Rajcord update key must be a base64 Ed25519 public key.');

module.exports = {
  appId: 'com.rajcord.desktop',
  productName: 'Rajcord',
  executableName: 'Rajcord',
  artifactName: 'Rajcord-Setup-${version}-${arch}.${ext}',
  directories: {
    output: '../../artifacts/desktop',
    buildResources: 'resources',
  },
  files: [
    ...runtimeFiles,
    'dist/picker/*.html',
    'dist/picker/*.css',
    'dist/picker/*.js',
    'dist/window-audio-process.ps1',
    '!**/*.test.js',
    '!**/*smoke.js',
    'resources/icon.png',
  ],
  extraMetadata: {
    name: 'rajcord',
    description: 'Rajcord private community desktop client',
    ...(!signed && updateKey
      ? { rajcordUpdatePublicKey: updateKey, updaterCacheDirName: 'rajcord-manifest-updater' }
      : {}),
  },
  asar: true,
  extraResources: [{ from: obsBundle, to: 'obs-screen' }],
  asarUnpack: ['dist/window-audio-process.ps1'],
  npmRebuild: false,
  forceCodeSigning: signed,
  electronUpdaterCompatibility: '>=6.8.11',
  publish: signed
    ? [{ provider: 'github', owner: 'Treca-Raja', repo: 'rajcord-public', releaseType: 'draft' }]
    : null,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icon.ico',
    verifyUpdateCodeSignature: true,
    ...(signed ? { signtoolOptions: { publisherName: publisher } } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Rajcord',
    uninstallDisplayName: 'Rajcord',
    deleteAppDataOnUninstall: false,
    runAfterFinish: !signed && Boolean(updateKey),
  },
};
