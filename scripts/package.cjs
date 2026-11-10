'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  if (!fs.existsSync(path.join(root, 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node')))
    throw new Error('Missing Windows Koffi binary. Install @koromix/koffi-win32-x64@3.3.7 for the target platform (see README).');
  const { packager } = await import('@electron/packager');
  const results = await packager({
    dir: root, name: 'Tandem', platform: 'win32', arch: 'x64', electronVersion: require('../package.json').devDependencies.electron,
    out: path.join(root, 'release'), overwrite: true, prune: true,
    asar: { unpack: '**/*.{node,dll}' },
    ignore: [/^\/release($|\/)/, /^\/artifacts($|\/)/, /^\/test($|\/)/, /^\/deploy($|\/)/, /^\/scripts($|\/)/, /accounts\.sqlite/, /^\/server\/data($|\/)/, /^\/node_modules\/\.cache/],
    download: { cacheRoot: process.env.ELECTRON_CACHE || path.join(root, '..', 'electron-cache') },
    appCopyright: 'Tandem contributors', executableName: 'Tandem'
  });
  for (const directory of results) {
    fs.copyFileSync(path.join(root, 'START-HERE.txt'), path.join(directory, 'НАЧНИТЕ-ЗДЕСЬ.txt'));
    console.log(`Windows client: ${directory}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
