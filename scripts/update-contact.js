require('dotenv').config();
const { Pool } = require('pg');
const Database = require('better-sqlite3');
const path = require('path');

const email = 'Shivandapropertiesandconstruct@gmail.com';
const phone = '+91 96860 01144';
const whatsapp = '+91 96860 01144';

async function update() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL.replace(':5432', ':6543'),
    ssl: { rejectUnauthorized: false }
  });

  const entries = [
    ['email', email],
    ['phone', phone],
    ['whatsapp', whatsapp]
  ];

  for (const [k, v] of entries) {
    await pool.query(
      `INSERT INTO settings ("key", "value") VALUES ($1, $2)
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
      [k, v]
    );
  }
  console.log('SUPABASE SUCCESS');
  await pool.end();

  try {
    const db = new Database(path.join(__dirname, '..', 'data', 'shivanda.db'));
    for (const [k, v] of entries) {
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
    }
    console.log('SQLITE SUCCESS');
  } catch (err) {
    console.warn('SQLite skipped:', err.message);
  }
}

update().then(() => {
  console.log('ALL UPDATED');
  process.exit(0);
}).catch(e => {
  console.error('Update failed:', e);
  process.exit(1);
});
