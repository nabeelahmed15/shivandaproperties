// Free, self-hosted backups: writes a JSON snapshot of every table to a folder
// on this computer (which the project's OneDrive folder already syncs to the
// cloud). No account, service or payment is involved, and nothing is sent
// anywhere except when you download a snapshot from the admin dashboard.
//
// Backups contain customer names, phone numbers and messages, so `backups/` is
// git-ignored and must never be committed to the public repository.

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { ENQUIRY_COLUMNS } = require('./enquiry-store');

const TABLES = [
  'properties',
  'property_images',
  'enquiries',
  'packages',
  'package_specs',
  'testimonials',
  'faqs',
  'projects_gallery',
  'settings',
  'admins'
];

const KEEP_DAILY = 14;
const runningInFunction = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);

function backupDir() {
  return process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(__dirname, '..', 'backups');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// Local time, so one snapshot per calendar day as the owner expects.
function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function today(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function collectSnapshot() {
  const tables = {};
  for (const table of TABLES) {
    try {
      tables[table] = await db.prepare(`SELECT * FROM ${table}`).all();
    } catch (error) {
      tables[table] = null;
    }
  }

  const counts = {};
  let totalRecords = 0;
  for (const [table, rows] of Object.entries(tables)) {
    counts[table] = Array.isArray(rows) ? rows.length : null;
    if (Array.isArray(rows)) totalRecords += rows.length;
  }

  return {
    app: 'shivanda-properties-construction',
    createdAt: new Date().toISOString(),
    totalRecords,
    counts,
    tables
  };
}

function writeSnapshot(snapshot, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  return filePath;
}

function pruneDaily(dir, keep = KEEP_DAILY) {
  try {
    const daily = fs.readdirSync(dir)
      .filter((name) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .reverse();

    daily.slice(keep).forEach((name) => {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (error) {
        // Pruning is best effort.
      }
    });
  } catch (error) {
    // Nothing to prune yet.
  }
}

async function createBackup({ reason = 'manual', filePath = null } = {}) {
  const snapshot = await collectSnapshot();
  const dir = backupDir();
  const file = writeSnapshot(snapshot, filePath || path.join(dir, `${reason}-${stamp()}.json`));
  writeSnapshot(snapshot, path.join(dir, 'latest.json'));
  if (reason === 'daily') pruneDaily(dir);

  return { file, dir, totalRecords: snapshot.totalRecords, counts: snapshot.counts, createdAt: snapshot.createdAt };
}

// One snapshot per day, so running the server does not fill the disk. Skipped
// inside a hosting sandbox, where the file system is thrown away anyway.
async function dailyBackup() {
  if (runningInFunction && !process.env.BACKUP_DIR) return null;

  const dir = backupDir();
  const file = path.join(dir, `daily-${today()}.json`);
  if (fs.existsSync(file)) return { file, skipped: true, dir };

  // Pass the exact file name so one snapshot is written per day, and so the
  // pruning rule below can find and rotate older snapshots.
  return createBackup({ reason: 'daily', filePath: file });
}

function latestBackup() {
  const dir = backupDir();
  const candidates = ['latest.json']
    .map((name) => path.join(dir, name))
    .concat(
      fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((name) => name !== 'latest.json').map((name) => path.join(dir, name))
        : []
    );

  let newest = null;
  for (const candidate of candidates) {
    try {
      const info = fs.statSync(candidate);
      if (!info.isFile()) continue;
      if (!newest || info.mtimeMs > newest.modifiedAt) {
        newest = {
          file: candidate,
          name: path.basename(candidate),
          dir,
          sizeBytes: info.size,
          modifiedAt: info.mtimeMs
        };
      }
    } catch (error) {
      // Missing or unreadable file; ignore it.
    }
  }

  return { dir, newest };
}

function backupSummary() {
  const { dir, newest } = latestBackup();
  return {
    dir,
    writable: (() => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch (error) {
        return false;
      }
    })(),
    available: Boolean(newest),
    name: newest ? newest.name : null,
    sizeBytes: newest ? newest.sizeBytes : 0,
    modifiedAt: newest ? new Date(newest.modifiedAt).toISOString() : null
  };
}

function readLatestSnapshot() {
  const { newest } = latestBackup();
  if (!newest) return { snapshot: null, source: null };
  try {
    return { snapshot: JSON.parse(fs.readFileSync(newest.file, 'utf8')), source: newest.name };
  } catch (error) {
    return { snapshot: null, source: newest.name };
  }
}

// Disaster recovery: when the database has no enquiries at all (a reset or a
// swapped connection string), put the ones from the newest snapshot back.
// Applies only to an empty table, so enquiries you deleted on purpose stay
// deleted.
async function restoreEnquiriesFromLatestBackup({ onlyIfEmpty = true } = {}) {
  try {
    if (onlyIfEmpty) {
      const existing = await db.prepare('SELECT COUNT(*) AS count FROM enquiries').get();
      if (Number(existing && existing.count) > 0) return { restored: 0, source: null, skipped: 'database already has enquiries' };
    }

    const { snapshot, source } = readLatestSnapshot();
    const rows = snapshot && snapshot.tables && Array.isArray(snapshot.tables.enquiries)
      ? snapshot.tables.enquiries
      : null;
    if (!rows || !rows.length) return { restored: 0, source, skipped: 'no enquiries in the newest backup' };

    let restored = 0;
    for (const row of rows) {
      if (!row || !row.phone || !row.created_at) continue;
      try {
        const columns = ENQUIRY_COLUMNS;
        const values = columns.map((column) => (row[column] === undefined ? null : row[column]));
        const placeholders = columns.map(() => '?').join(', ');
        await db
          .prepare(`INSERT INTO enquiries (${columns.join(', ')}) VALUES (${placeholders})`)
          .run(...values);
        restored += 1;
      } catch (error) {
        console.warn('[shivanda] Could not restore one enquiry from backup:', error && error.message);
      }
    }

    return { restored, source };
  } catch (error) {
    console.warn('[shivanda] Enquiry restore from backup skipped:', error && error.message);
    return { restored: 0, source: null, error: error && error.message };
  }
}

module.exports = {
  TABLES,
  backupDir,
  collectSnapshot,
  createBackup,
  dailyBackup,
  backupSummary,
  restoreEnquiriesFromLatestBackup
};
