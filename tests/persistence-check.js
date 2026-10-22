// Proves that the Netlify function sandbox keeps its data: everything written
// to the SQLite file is copied to Netlify Blobs, and a "cold start" restored
// from that copy still has the change (including an unpublished property).
//
// Runs as its own process because lib/db decides on storage at load time.

process.env.NETLIFY = 'true';
process.env.DATABASE_URL = '';
process.env.CLOUDINARY_URL = '';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shivanda-persist-'));
process.env.DATA_DIR = path.join(workDir, 'sandbox');
process.env.BACKUP_DIR = path.join(workDir, 'backups');

// Minimal in-memory stand-in for the Netlify Blobs store.
const blobs = new Map();
const fakeStore = {
  async set(key, value) {
    blobs.set(key, Buffer.from(value));
  },
  async get(key, options) {
    const value = blobs.get(key);
    if (!value) return null;
    if (options && options.type === 'arrayBuffer') {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return value;
  },
  async delete(key) {
    blobs.delete(key);
  }
};

const persistence = require('../lib/sqlite-persistence');
persistence.__setStoreFactory(() => fakeStore);

const { db, initializeDatabase, ensureAdmin } = require('../lib/db');

async function run() {
  assert(persistence.isEnabled(), 'durable storage should be active inside a Netlify function without DATABASE_URL');

  await initializeDatabase();
  assert(blobs.has(persistence.DB_KEY), 'the starting database should be saved to Netlify Blobs');

  const initialCopy = Buffer.from(blobs.get(persistence.DB_KEY));
  assert(initialCopy.length > 0, 'the saved database should not be empty');

  await db
    .prepare('INSERT INTO properties (slug, title, is_published) VALUES (?, ?, ?)')
    .run('persist-test-villa', 'Persisted Villa', 0);

  const flushed = await persistence.flush();
  assert(flushed.ok, `flush should report success (got ${JSON.stringify(flushed)})`);

  const saved = blobs.get(persistence.DB_KEY);
  assert(!saved.equals(initialCopy), 'writing a property should update the saved database');

  // Simulate a brand-new function instance: a different sandbox folder and a
  // fresh Node process, which can only see the saved bytes.
  const blobFile = path.join(workDir, 'saved-copy.db');
  fs.writeFileSync(blobFile, saved);

  const coldStart = spawnSync(process.execPath, [path.join(__dirname, 'persistence-cold-start.js'), blobFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NETLIFY: 'true',
      DATABASE_URL: '',
      DATA_DIR: path.join(workDir, 'cold-sandbox'),
      BACKUP_DIR: path.join(workDir, 'cold-backups')
    }
  });
  assert(
    coldStart.status === 0,
    `a cold start should restore the saved data\n${coldStart.stdout || ''}${coldStart.stderr || ''}`
  );

  // A password changed in the dashboard must survive a restart. Only an
  // explicitly configured ADMIN_PASSWORD is allowed to replace it.
  const email = (process.env.ADMIN_EMAIL || 'admin@shivanda.com').trim();
  const changed = 'ChangedPass!23';
  await db.prepare('UPDATE admins SET password_hash = ? WHERE email = ?').run(bcrypt.hashSync(changed, 10), email);
  await ensureAdmin();
  const admin = await db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  assert(bcrypt.compareSync(changed, admin.password_hash), 'a dashboard password change must not be reset on restart');

  await persistence.flush();
  console.log('Durable storage checks passed');
}

run()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (error) {
      // Windows may hold the file for a moment; the OS cleans temp folders.
    }
  });
