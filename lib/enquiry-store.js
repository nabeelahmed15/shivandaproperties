const runningInFunction = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);

const ENQUIRY_COLUMNS = [
  'property_id',
  'property_name',
  'package_name',
  'service_type',
  'buyer_name',
  'phone',
  'email',
  'budget_range',
  'message',
  'status',
  'admin_notes',
  'created_at',
  'updated_at'
];

let warned = false;
function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn('[shivanda] Enquiry blob persistence unavailable:', error && error.message);
}

// Blob storage is only used when the app runs in a Netlify function without a
// persistent DATABASE_URL; locally and on Supabase the database already keeps data.
function getStoreSafe() {
  if (!runningInFunction || process.env.DATABASE_URL) return null;
  try {
    const { getStore } = require('@netlify/blobs');
    return getStore('enquiry-archive');
  } catch (error) {
    warnOnce(error);
    return null;
  }
}

function keyFor(row) {
  return `enquiry:${row.created_at}|${row.phone}`;
}

async function saveEnquiry(row) {
  const store = getStoreSafe();
  if (!store || !row || !row.phone || !row.created_at) return;
  try {
    await store.setJSON(keyFor(row), row);
  } catch (error) {
    warnOnce(error);
  }
}

async function removeEnquiry(row) {
  const store = getStoreSafe();
  if (!store || !row || !row.phone || !row.created_at) return;
  try {
    await store.delete(keyFor(row));
  } catch (error) {
    warnOnce(error);
  }
}

async function loadEnquiries() {
  const store = getStoreSafe();
  if (!store) return [];
  try {
    const { blobs } = await store.list({ prefix: 'enquiry:' });
    const rows = [];
    for (const { key } of blobs) {
      try {
        rows.push(await store.getJSON(key));
      } catch (error) {
        console.warn('[shivanda] Skipping unreadable enquiry blob:', key);
      }
    }
    return rows;
  } catch (error) {
    warnOnce(error);
    return [];
  }
}

// Best-effort restore of archived enquiries into the (possibly fresh) database.
// Never throws: persistence must never take the site down.
async function rehydrate(db, rows = null) {
  try {
    const source = rows === null ? await loadEnquiries() : rows;
    let restored = 0;
    for (const row of source) {
      if (!row || !row.phone || !row.created_at) continue;
      try {
        const existing = await db
          .prepare('SELECT id FROM enquiries WHERE phone = ? AND created_at = ? LIMIT 1')
          .get(row.phone, row.created_at);
        if (existing) continue;
        const values = ENQUIRY_COLUMNS.map((column) => (row[column] === undefined ? null : row[column]));
        const placeholders = ENQUIRY_COLUMNS.map(() => '?').join(', ');
        await db
          .prepare(`INSERT INTO enquiries (${ENQUIRY_COLUMNS.join(', ')}) VALUES (${placeholders})`)
          .run(...values);
        restored += 1;
      } catch (error) {
        console.warn('[shivanda] Could not restore one enquiry:', error && error.message);
      }
    }
    if (restored > 0) {
      console.log(`[shivanda] Restored ${restored} enquir${restored === 1 ? 'y' : 'ies'} from blob storage.`);
    }
    return restored;
  } catch (error) {
    warnOnce(error);
    return 0;
  }
}

module.exports = {
  ENQUIRY_COLUMNS,
  saveEnquiry,
  removeEnquiry,
  loadEnquiries,
  rehydrate
};
