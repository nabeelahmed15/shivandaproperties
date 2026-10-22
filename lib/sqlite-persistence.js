// Durable storage for the SQLite fallback used inside Netlify Functions.
//
// A Netlify Function only has a throwaway /tmp sandbox, so a plain SQLite file
// is wiped on every cold start and redeploy. That silently lost enquiries,
// unpacked property edits and every other change. Netlify Blobs is available to
// functions with no account setup or extra environment variables, so the whole
// database file is mirrored there and restored before the app starts.
//
// Every operation is best effort: storage problems are logged and never break a
// visitor's enquiry or the admin panel.

const fs = require('fs');
const path = require('path');

const STORE_NAME = 'shivanda-database';
const DB_KEY = 'shivanda.db';
const METADATA_KEY = 'shivanda.db.meta';
const TIMEOUT_MS = 5000;

const runningInFunction = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);

// Only needed when there is no hosted database to talk to.
function isEnabled() {
  return runningInFunction && !process.env.DATABASE_URL;
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let warned = false;
function warnOnce(action, error) {
  const message = error && error.message ? error.message : String(error);
  console.warn(`[shivanda] Durable storage ${action} failed: ${message}`);
  if (warned) return;
  warned = true;
}

let storeFactory = null;
let storePromise = null;

async function loadStoreFactory() {
  // @netlify/blobs is published as ESM with a CommonJS build. Try the plain
  // require first, then fall back to import() on runtimes that refuse it.
  try {
    const cjs = require('@netlify/blobs');
    if (cjs && typeof cjs.getStore === 'function') return cjs.getStore;
  } catch (error) {
    // Fall through to the dynamic import below.
  }
  const esm = await import('@netlify/blobs');
  if (esm && typeof esm.getStore === 'function') return esm.getStore;
  throw new Error('Netlify Blobs is not available in this runtime');
}

function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const factory = storeFactory || (await loadStoreFactory());
      return factory(STORE_NAME);
    })();
  }
  return storePromise;
}

let uploading = false;
let queued = false;
let pending = Promise.resolve();
let lastSavedAt = null;
let lastError = null;
let lastBytes = 0;
let restoredFromBlob = false;
let consecutiveFailures = 0;
let paused = false;

function snapshot(file) {
  // journal_mode is DELETE in this mode, so the main file is the whole database.
  return fs.readFileSync(file);
}

async function upload(file) {
  const store = await withTimeout(getStore(), 'Connecting to storage');
  const data = snapshot(file);
  // Blobs accepts strings, ArrayBuffers and Blobs; hand it an exact ArrayBuffer.
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  await withTimeout(
    store.set(DB_KEY, bytes, { metadata: { updatedAt: new Date().toISOString(), bytes: String(data.length) } }),
    'Saving the database'
  );
  lastSavedAt = new Date().toISOString();
  lastError = null;
  lastBytes = data.length;
}

function scheduleUpload(file) {
  // If durable storage is unreachable, do not add seconds of waiting to every
  // admin action. The next cold start tries again.
  if (paused) return;
  if (uploading) {
    queued = true;
    return;
  }
  uploading = true;
  queued = false;
  pending = (async () => {
    try {
      await upload(file);
      consecutiveFailures = 0;
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      consecutiveFailures += 1;
      warnOnce('save', error);
      if (consecutiveFailures >= 2) {
        paused = true;
        console.warn('[shivanda] Durable storage is unreachable; pausing saves until the next cold start.');
      }
    } finally {
      uploading = false;
      if (queued) scheduleUpload(file);
    }
  })();
}

// Called after every write: the database file changed, queue a save.
function markDirty(file) {
  if (!isEnabled()) return;
  scheduleUpload(file);
}

// Waits until everything written so far has reached durable storage. Used
// before a response is sent so a submitted enquiry cannot be lost when the
// function sandbox is frozen.
async function flush() {
  if (!isEnabled() || paused) return { ok: !lastError, skipped: paused, error: lastError };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await pending.catch(() => {});
    if (!uploading && !queued) break;
  }
  return { ok: !lastError, savedAt: lastSavedAt, error: lastError };
}

// Replaces the sandbox database file with the saved copy, if there is one.
async function restore(file) {
  if (!isEnabled()) return false;
  try {
    const store = await withTimeout(getStore(), 'Connecting to storage');
    const data = await withTimeout(store.get(DB_KEY, { type: 'arrayBuffer' }), 'Loading the saved database');
    if (!data || !data.byteLength) return false;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.unlinkSync(`${file}${suffix}`);
      } catch (error) {
        // Not there.
      }
    }
    fs.writeFileSync(file, Buffer.from(data));
    restoredFromBlob = true;
    console.log(`[shivanda] Restored ${data.byteLength} bytes of saved data from Netlify Blobs.`);
    return true;
  } catch (error) {
    warnOnce('restore', error);
    return false;
  }
}

function status() {
  return {
    enabled: isEnabled(),
    restored: restoredFromBlob,
    lastSavedAt,
    lastError,
    lastBytes,
    paused
  };
}

// Test hooks: swap the Blobs store for an in-memory one.
function __setStoreFactory(factory) {
  storeFactory = factory;
  storePromise = null;
  uploading = false;
  queued = false;
  pending = Promise.resolve();
  lastSavedAt = null;
  lastError = null;
  restoredFromBlob = false;
  consecutiveFailures = 0;
  paused = false;
}

module.exports = {
  STORE_NAME,
  DB_KEY,
  isEnabled,
  markDirty,
  flush,
  restore,
  status,
  __setStoreFactory
};
