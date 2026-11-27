import fs from 'node:fs';
import assert from 'node:assert/strict';

const notices = fs.readFileSync(new URL('../docs/THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
for (const [name, display] of Object.entries({
  three: 'Three.js', electron: 'Electron', vite: 'Vite',
  'electron-builder': 'electron-builder', playwright: 'Playwright', '@electron/fuses': '@electron/fuses',
})) {
  const { version } = lock.packages['node_modules/' + name];
  const mentioned = notices.split(display + ' ')[1]?.match(/^\d+(?:\.\d+){2}(?:[-+][\w.-]+)?/)?.[0];
  assert.equal(mentioned, version, 'Update dependency notice for ' + name);
}
