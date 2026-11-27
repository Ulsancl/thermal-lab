const fs = require('node:fs');
const path = require('node:path');

function configureProfile(normalProfile, override) {
  if (!override) {
    fs.mkdirSync(normalProfile, { recursive: true });
    return normalProfile;
  }
  if (!path.isAbsolute(override) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(override))) {
    throw new Error('THERMAL_LAB_DATA_DIR must use an absolute local path');
  }
  const target = path.resolve(override);
  const root = path.parse(target).root;
  const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(current).isDirectory() || canonical(fs.realpathSync(current)) !== canonical(current)) {
      throw new Error('THERMAL_LAB_DATA_DIR must use real directories');
    }
  }
  return target;
}

module.exports = { configureProfile };
