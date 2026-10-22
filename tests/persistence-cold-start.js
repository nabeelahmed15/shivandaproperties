// Runs as a fresh process with an empty sandbox folder: the only thing it can
// see is the saved copy of the database, exactly like a Netlify cold start.
// Invoked by tests/persistence-check.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const blobFile = process.argv[2];
const persistence = require('../lib/sqlite-persistence');

persistence.__setStoreFactory(() => ({
  async get(key, options) {
    if (key !== persistence.DB_KEY) return null;
    const buffer = fs.readFileSync(blobFile);
    if (options && options.type === 'arrayBuffer') {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    return buffer;
  },
  async set() {},
  async delete() {}
}));

const { db, initializeDatabase } = require('../lib/db');

async function run() {
  await initializeDatabase();

  const property = await db.prepare('SELECT * FROM properties WHERE slug = ?').get('persist-test-villa');
  assert(property, 'a cold start should bring back the property saved earlier');
  assert(Number(property.is_published) === 0, 'a property left unpublished must stay unpublished after a cold start');

  const packages = await db.prepare('SELECT COUNT(*) AS count FROM packages').get();
  assert(Number(packages.count) >= 4, 'the restored database should keep every table, not just one');

  const enquiries = await db.prepare('SELECT COUNT(*) AS count FROM enquiries').get();
  assert(Number(enquiries.count) >= 0, 'the enquiries table should exist after a cold start');

  await persistence.flush();
  console.log('Cold start restore passed');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
