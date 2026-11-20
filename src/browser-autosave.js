// Only cooperatively updated tabs use this lock. A storage event alone
// cannot make localStorage's read/compare/write an indivisible operation.
export const autosaveLockName = key => `${key}:autosave`;
export const supportsAutosaveLock = locks => typeof locks?.request === 'function';
export async function withAutosaveLock(locks, key, task) {
  return locks.request(autosaveLockName(key), { mode: 'exclusive' }, task);
}

export function writeIfUnchanged(storage, key, expected, contents) {
  const stored = storage.getItem(key);
  if (stored !== expected && stored !== contents) return false;
  if (stored !== contents) storage.setItem(key, contents);
  return true;
}

const tabDraftKey = key => `${key}:tab-draft`;
const validDraft = draft => draft !== null && typeof draft === 'object'
  && Object.keys(draft).length === 4
  && ['version', 'expected', 'contents', 'interrupted'].every(key => Object.hasOwn(draft, key))
  && draft.version === 1
  && (draft.expected === null || typeof draft.expected === 'string')
  && typeof draft.contents === 'string' && typeof draft.interrupted === 'boolean';

export function readTabDraft(storage, key) {
  try {
    const draft = JSON.parse(storage().getItem(tabDraftKey(key)));
    return validDraft(draft) ? draft : null;
  } catch { return null; }
}

export function writeTabDraft(storage, key, { expected, contents, interrupted = false }) {
  try {
    const draft = { version: 1, expected, contents, interrupted };
    if (!validDraft(draft)) return false;
    storage().setItem(tabDraftKey(key), JSON.stringify(draft));
    return true;
  } catch { return false; }
}

export function clearTabDraft(storage, key, contents) {
  try {
    if (contents === undefined || readTabDraft(storage, key)?.contents === contents) storage().removeItem(tabDraftKey(key));
  } catch { /* A private recovery draft must not break ordinary storage. */ }
}

export function createBrowserAutosave({ key, storage, locks, expected, baseline, capture, onStatus }) {
  let clean = baseline, exported;
  let enabled = supportsAutosaveLock(locks), queued = false, active = null;
  async function drain() {
    while (queued && enabled) {
      try {
        await withAutosaveLock(locks, key, () => {
          // Requests made while waiting need only the last visible snapshot.
          queued = false;
          let status, contents;
          try {
            contents = capture();
            if (contents === clean) status = 'unchanged';
            else if (writeIfUnchanged(storage(), key, expected, contents)) {
              expected = clean = contents;
              status = 'saved';
            } else {
              enabled = false;
              status = 'conflict';
            }
          } catch { status = 'failed'; }
          onStatus(status, contents);
        });
      } catch {
        // The API may exist but be denied for this origin or document.
        // Never fall back to an unlocked shared write.
        enabled = false;
        onStatus('unavailable');
      }
    }
    if (!enabled) queued = false;
  }
  function flush() {
    if (!enabled) return Promise.resolve();
    queued = true;
    if (!active) active = drain().finally(() => {
      active = null;
      if (queued && enabled) return flush();
    });
    return active;
  }
  function unsavedDraft() {
    const contents = capture();
    return contents === clean || contents === exported ? null : { expected, contents, interrupted: !enabled };
  }
  return {
    canSave: () => enabled,
    flush,
    markExported(contents) { exported = contents; },
    unsavedDraft,
    hasUnsavedChanges: () => unsavedDraft() !== null,
  };
}
