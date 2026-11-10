'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
let count = 0;
for (const directory of ['app', 'server', 'shared', 'scripts', 'test']) {
  for (const name of fs.readdirSync(path.join(__dirname, '..', directory))) {
    if (!/\.(cjs|js)$/.test(name)) continue;
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', directory, name)], { stdio: 'inherit' }); count++;
  }
}
console.log(`Syntax checked: ${count} JavaScript files.`);
