// No publishing from a build command. GitHub release creation is a separate workflow step.
const signed = process.env.RAJCORD_SIGNED_RELEASE === '1';
const publisher = process.env.RAJCORD_PUBLISHER_DN;
if (signed && (!publisher?.startsWith('CN=') || !process.env.WIN_CSC_LINK))
  throw new Error('Signed builds require RAJCORD_PUBLISHER_DN and WIN_CSC_LINK.');

module.exports = {
  appId: 'com.rajcord.desktop',
  productName: 'Rajcord',
  executableName: 'Rajcord',
  artifactName: 'Rajcord-Setup-${version}-${arch}.${ext}',
  directories: { output: '../../artifacts/desktop', buildResources: 'resources' },
  files: ['dist/**/*.js', '!dist/**/*.test.js', '!dist/smoke.js', 'resources/icon.png'],
  extraMetadata: { name: 'rajcord', description: 'Rajcord private community desktop client' },
  asar: true,
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
    runAfterFinish: false,
  },
};
