import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(root, 'dist');
if (path.dirname(target) !== root || path.basename(target) !== 'dist') throw new Error('Invalid build output boundary');
if (fs.existsSync(target)) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('dist must be a real project directory');
  if (fs.realpathSync(target) !== path.join(fs.realpathSync(root), 'dist')) throw new Error('Unexpected resolved output path');
  const clear = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name), relative = path.relative(target, item);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output escaped project boundary');
      const child = fs.lstatSync(item);
      if (child.isDirectory() && !child.isSymbolicLink()) { clear(item); fs.rmdirSync(item); }
      else fs.unlinkSync(item);
    }
  };
  clear(target);
  console.log('Cleared generated dist assets inside Thermal Lab.');
}
