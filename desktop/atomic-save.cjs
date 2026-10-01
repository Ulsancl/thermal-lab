const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const WINDOWS_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400]);
const transientCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);

// A complete sibling replaces the destination only after it has been flushed.
// Some Windows readers/scanners briefly prevent replacement; retry only that
// operation, with the destination checked again before every attempt.
async function atomicWriteProject(target, contents, {
  validateTarget,
  operations = fs,
  platform = process.platform,
  wait = delay,
} = {}) {
  if (typeof validateTarget !== 'function') throw new TypeError('A target validator is required');
  await validateTarget(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let ownsTemporary = false;
  try {
    const handle = await operations.open(temporary, 'wx');
    ownsTemporary = true;
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      await validateTarget(target);
      try {
        await operations.rename(temporary, target);
        ownsTemporary = false;
        return;
      } catch (error) {
        if (platform !== 'win32' || !transientCodes.has(error.code) || attempt >= WINDOWS_RETRY_DELAYS_MS.length) throw error;
        await wait(WINDOWS_RETRY_DELAYS_MS[attempt]);
      }
    }
  } finally {
    if (ownsTemporary) await operations.unlink(temporary).catch(() => {});
  }
}

module.exports = { atomicWriteProject, WINDOWS_RETRY_DELAYS_MS };
