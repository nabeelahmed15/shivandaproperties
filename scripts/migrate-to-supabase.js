require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cloudinary = require('cloudinary').v2;
const PostgresDatabase = require('../lib/postgres');

const rootDir = path.join(__dirname, '..');
const sqlitePath = path.join(rootDir, 'data', 'shivanda.db');
const tables = [
  'admins',
  'properties',
  'property_images',
  'packages',
  'package_specs',
  'enquiries',
  'testimonials',
  'faqs',
  'projects_gallery',
  'settings'
];

async function migrate() {
  if (!process.env.DATABASE_URL || !process.env.CLOUDINARY_URL) {
    throw new Error('Set DATABASE_URL and CLOUDINARY_URL before migrating.');
  }
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`Local SQLite database not found: ${sqlitePath}`);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  const postgres = new PostgresDatabase(process.env.DATABASE_URL);

  try {
    await postgres.exec(fs.readFileSync(path.join(rootDir, 'data', 'schema.postgres.sql'), 'utf8'));

    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      for (const row of rows) {
        if (['property_images', 'projects_gallery'].includes(table) && row.image_url?.startsWith('/uploads/')) {
          const localImage = path.join(rootDir, 'public', row.image_url.replace(/^\//, ''));
          if (!fs.existsSync(localImage)) {
            throw new Error(`Uploaded image is missing from disk: ${localImage}`);
          }
          const uploaded = await cloudinary.uploader.upload(localImage, {
            folder: `shivanda/migrated/${table}`,
            public_id: path.basename(localImage, path.extname(localImage)),
            overwrite: true
          });
          row.image_url = uploaded.secure_url;
        }

        const columns = Object.keys(row);
        const values = columns.map((column) => row[column]);
        const names = columns.map((column) => `"${column}"`).join(', ');
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        const updates = columns.filter((column) => column !== 'id')
          .map((column) => `"${column}" = EXCLUDED."${column}"`).join(', ');
        await postgres.pool.query(
          `INSERT INTO "${table}" (${names}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updates}`,
          values
        );
      }

      if (rows.length) {
        await postgres.pool.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM "${table}"), true)`
        );
      }
      console.log(`Migrated ${rows.length} ${table} records.`);
    }
  } finally {
    sqlite.close();
    await postgres.pool.end();
  }
}

migrate().catch((error) => {
  console.error('Supabase migration failed:', error);
  process.exitCode = 1;
});