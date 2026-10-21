// Writes a JSON snapshot of every table to the local backups folder.
//
//   npm run db:backup
//
// No account, service or payment is involved. Set BACKUP_DIR to change where
// the snapshots are written.

require('dotenv').config();

const { createBackup } = require('../lib/backup');
const { db } = require('../lib/db');

async function main() {
  await db.prepare('SELECT 1 AS ok').get();

  const result = await createBackup({ reason: 'manual' });

  console.log('');
  console.log(`Wrote ${result.totalRecords} records to:`);
  console.log(`  ${result.file}`);
  console.log('');
  for (const [table, count] of Object.entries(result.counts)) {
    console.log(`  ${table.padEnd(20)} ${count === null ? 'unreadable' : count}`);
  }
  console.log('');
  console.log('Keep these files private - they contain customer names and phone numbers.');
  console.log('');
}

main()
  .catch((error) => {
    console.error('Backup failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db && db.pool && typeof db.pool.end === 'function') {
      await db.pool.end().catch(() => {});
    }
  });
