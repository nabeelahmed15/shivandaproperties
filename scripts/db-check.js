// Reports where the site stores its records and exits non-zero when that
// storage is temporary, unreadable or read-only. Read-only: it never creates a
// schema, an admin user or any other row.
//
//   npm run db:check

require('dotenv').config();

const { db, databaseReport } = require('../lib/db');

const LABELS = {
  properties: 'Properties',
  property_images: 'Property images',
  enquiries: 'Enquiries',
  packages: 'Packages',
  package_specs: 'Package specifications',
  testimonials: 'Testimonials',
  faqs: 'FAQs',
  projects_gallery: 'Gallery items',
  settings: 'Settings',
  admins: 'Admin users'
};

async function main() {
  try {
    await db.prepare('SELECT 1 AS ok').get();
  } catch (error) {
    console.error(`Cannot reach the database: ${error.message}`);
    console.error('Check DATABASE_URL in .env (or the hosting environment variables).');
    process.exitCode = 1;
    return;
  }

  const report = await databaseReport();

  console.log('');
  console.log(`Storage:       ${report.label}`);
  console.log(`Engine:        ${report.engine} (${report.host})`);
  console.log(`Permanent:     ${report.persistent ? 'yes' : 'NO'}`);
  console.log(`Shared:        ${report.shared ? 'yes - every device sees the same records' : 'no - this machine only'}`);
  console.log(`Write access:  ${report.writable === false ? 'FAILED' : 'ok'}`);
  console.log('');

  for (const [table, count] of Object.entries(report.rows)) {
    const label = LABELS[table] || table;
    console.log(`  ${label.padEnd(22)} ${count === null ? 'missing table' : count}`);
  }

  console.log('');
  console.log(`  Total records: ${report.totalRecords}`);
  console.log('');

  const missingTables = Object.entries(report.rows)
    .filter(([, count]) => count === null)
    .map(([table]) => table);

  if (!report.persistent) {
    console.error(`FAIL: records are not stored permanently. ${report.note}`);
    process.exitCode = 1;
    return;
  }

  if (missingTables.length) {
    console.error(`FAIL: these tables are missing: ${missingTables.join(', ')}`);
    console.error('Start the app once (npm start) to create the schema, or run npm run migrate:cloud.');
    process.exitCode = 1;
    return;
  }

  if (report.writable === false) {
    console.error(`FAIL: the database rejected the write-access check. ${report.note}`);
    process.exitCode = 1;
    return;
  }

  console.log(`PASS: ${report.totalRecords} records are stored permanently in ${report.label}.`);
}

main()
  .catch((error) => {
    console.error('Database check failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db && db.pool && typeof db.pool.end === 'function') {
      await db.pool.end().catch(() => {});
    }
  });
