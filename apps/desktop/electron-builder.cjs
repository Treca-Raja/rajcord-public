// No publishing from a build command. GitHub release creation is a separate workflow step.
const signed = process.env.RAJCORD_SIGNED_RELEASE === '1';
const publisher = process.env.RAJCORD_PUBLISHER_DN;
const updateKey = process.env.RAJCORD_UPDATE_PUBLIC_KEY;
if (signed && (!publisher?.startsWith('CN=') || !process.env.WIN_CSC_LINK))
  throw new Error('Signed builds require RAJCORD_PUBLISHER_DN and WIN_CSC_LINK.');
// The synchronous CommonJS builder config uses the same validator as the packaged updater.
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (updateKey && !require('./dist/update-manifest.js').updatePublicKey(updateKey))
  throw new Error('The Rajcord update key must be a base64 Ed25519 public key.');

module.exports = {
  appId: 'com.rajcord.desktop',
  productName: 'Rajcord',
  executableName: 'Rajcord',
  artifactName: 'Rajcord-Setup-${version}-${arch}.${ext}',
  directories: { output: '../../artifacts/desktop', buildResources: 'resources' },
  files: [
    'dist/**/*.js',
    'dist/picker/*.html',
    'dist/picker/*.css',
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
