// Reports the security configuration and exits non-zero when something needs
// fixing.
//
//   npm run security:check
//
// Read-only: it never changes a password, a secret or any record.

require('dotenv').config();

const { securityReport, isProductionLike } = require('../lib/security');
const { db } = require('../lib/db');

const BADGE = { pass: 'PASS', warn: 'CHECK', fail: 'FIX ' };

async function main() {
  const report = await securityReport();

  console.log('');
  console.log(`Running as production: ${isProductionLike() ? 'yes' : 'no (local development)'}`);
  console.log(`Admin accounts:        ${report.adminCount === null ? 'unreadable' : report.adminCount}`);
  console.log('');

  for (const check of report.checks) {
    console.log(`  [${BADGE[check.status] || check.status}] ${check.label}`);
    console.log(`         ${check.detail}`);
  }

  console.log('');

  if (report.failures.length) {
    console.error(`${report.failures.length} security item(s) must be fixed: ${report.failures.map((check) => check.label).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (report.warnings.length) {
    console.log(`${report.warnings.length} item(s) to review: ${report.warnings.map((check) => check.label).join(', ')}`);
  }

  console.log(`PASS: ${report.checks.length} security checks are in place.`);
}

main()
  .catch((error) => {
    console.error('Security check failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db && db.pool && typeof db.pool.end === 'function') {
      await db.pool.end().catch(() => {});
    }
  });
