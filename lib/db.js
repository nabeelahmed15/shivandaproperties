const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const PostgresDatabase = require('./postgres');
const sqlitePersistence = require('./sqlite-persistence');
const { PACKAGE_PLANS, specRows } = require('./package-specs');

const runningInFunction = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);
const usesPostgres = Boolean(process.env.DATABASE_URL);
// Inside Netlify Functions the sandbox file system is thrown away between
// invocations, so the SQLite file is mirrored to Netlify Blobs (which needs no
// account setup or environment variables) and restored on every cold start.
const blobPersistence = sqlitePersistence.isEnabled();
if (runningInFunction && !usesPostgres && !blobPersistence) {
  console.warn(
    '[shivanda] DATABASE_URL is not set; using temporary SQLite storage. ' +
      'Data will reset on every cold start or new deploy. Set DATABASE_URL in the Netlify dashboard ' +
      'to use the persistent database.'
  );
}

let dbInstance = null;
let storageInfo;
let databaseFile = null;

// Every module destructures `db` once when it is first required, so the export
// has to be a stable handle that resolves to the real connection afterwards.
const db = new Proxy({}, {
  get(target, prop) {
    if (!dbInstance) {
      if (typeof prop === 'symbol' || prop === 'pool' || prop === 'then') return undefined;
      throw new Error('[shivanda] The database is still starting up.');
    }
    const value = dbInstance[prop];
    return typeof value === 'function' ? value.bind(dbInstance) : value;
  },
  has() {
    return Boolean(dbInstance);
  }
});

function resolveSqliteFile() {
  const dataDir = process.env.DATA_DIR || (runningInFunction
    ? path.join(os.tmpdir(), 'shivanda-data')
    : path.join(__dirname, '..', 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'shivanda.db');
}

// The saved copy has to replace the sandbox file before SQLite opens it,
// otherwise the old (empty) database header wins.
async function openPersistentSqlite() {
  const Database = require('better-sqlite3');
  const restored = await sqlitePersistence.restore(databaseFile);
  const rawDb = new Database(databaseFile);
  // DELETE journal keeps the whole database in one file, which is what gets
  // saved to durable storage; WAL would leave changes in a side file.
  rawDb.pragma('journal_mode = DELETE');
  rawDb.pragma('foreign_keys = ON');
  dbInstance = wrapSqliteWrites(rawDb);
  return restored;
}

if (usesPostgres) {
  let host = 'unknown host';
  try {
    host = new URL(process.env.DATABASE_URL).hostname;
  } catch (error) {
    // Keep the placeholder; the connection will fail loudly if the URL is broken.
  }

  storageInfo = {
    engine: 'PostgreSQL',
    driver: 'postgres',
    host,
    shared: true,
    persistent: true,
    label: `Hosted PostgreSQL (${host})`,
    note: 'Records are stored in a hosted database and survive restarts, redeploys and cold starts.'
  };

  dbInstance = new PostgresDatabase(process.env.DATABASE_URL);
} else if (blobPersistence) {
  databaseFile = resolveSqliteFile();
  storageInfo = {
    engine: 'SQLite + Netlify Blobs',
    driver: 'sqlite',
    host: databaseFile,
    shared: true,
    persistent: true,
    label: 'Permanent storage saved by Netlify',
    note: 'Every change is saved to Netlify Blobs and restored after a cold start or redeploy, so enquiries, property edits and settings stay put.'
  };
} else {
  const Database = require('better-sqlite3');
  databaseFile = resolveSqliteFile();
  const rawDb = new Database(databaseFile);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  dbInstance = rawDb;

  storageInfo = runningInFunction
    ? {
        engine: 'SQLite (temporary)',
        driver: 'sqlite',
        host: databaseFile,
        shared: false,
        persistent: false,
        label: 'Temporary SQLite inside the function sandbox',
        note: 'This database is deleted on every cold start and redeploy, so enquiries and property changes can disappear. Set DATABASE_URL to a hosted database.'
      }
    : {
        engine: 'SQLite (local file)',
        driver: 'sqlite',
        host: databaseFile,
        shared: false,
        persistent: true,
        label: 'Local SQLite file on this computer',
        note: 'Records are saved on this computer only (data/shivanda.db). Other devices, and the public site once it is hosted, cannot see them - set DATABASE_URL for shared storage.'
      };
}

async function ensureTables() {
  if (usesPostgres) {
    const schemaPath = path.join(runningInFunction ? process.cwd() : path.join(__dirname, '..'), 'data', 'schema.postgres.sql');
    await db.exec(fs.readFileSync(schemaPath, 'utf8'));
    // CREATE TABLE IF NOT EXISTS cannot add a column to an existing table.
    await db.exec('ALTER TABLE package_specs ADD COLUMN IF NOT EXISTS group_name TEXT');
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE,
      title TEXT NOT NULL,
      price INTEGER,
      price_per_sqft INTEGER,
      type TEXT,
      status TEXT DEFAULT 'Available',
      locality TEXT,
      address TEXT,
      description TEXT,
      latitude REAL,
      longitude REAL,
      bedrooms INTEGER,
      bathrooms INTEGER,
      area INTEGER,
      facing TEXT,
      floor TEXT,
      possession_date TEXT,
      rera_id TEXT,
      amenities TEXT,
      is_published INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS property_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      is_cover INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rate INTEGER,
      badge TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS package_specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      group_name TEXT,
      label TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY(package_id) REFERENCES packages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER,
      property_name TEXT,
      package_name TEXT,
      service_type TEXT,
      buyer_name TEXT,
      phone TEXT,
      email TEXT,
      budget_range TEXT,
      message TEXT,
      status TEXT DEFAULT 'New',
      admin_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS testimonials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      location TEXT,
      quote TEXT,
      youtube_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS faqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT,
      answer TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS projects_gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      location TEXT,
      image_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      value TEXT
    );
  `);

  const existingColumns = db.prepare("PRAGMA table_info(enquiries)").all();
  const columns = new Set(existingColumns.map((c) => c.name));
  if (!columns.has('package_name')) {
    db.exec('ALTER TABLE enquiries ADD COLUMN package_name TEXT');
  }
  if (!columns.has('property_name')) {
    db.exec('ALTER TABLE enquiries ADD COLUMN property_name TEXT');
  }

  const specColumns = db.prepare('PRAGMA table_info(package_specs)').all();
  if (!new Set(specColumns.map((c) => c.name)).has('group_name')) {
    db.exec('ALTER TABLE package_specs ADD COLUMN group_name TEXT');
  }
}

async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@shivanda.com').trim();
  // Only an explicitly configured password may reset the stored one.
  // Previously the built-in default silently overwrote any password changed in
  // the dashboard on the next restart.
  const configuredPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  const existing = await db.prepare('SELECT * FROM admins WHERE email = ?').get(email);

  if (!existing) {
    const hash = bcrypt.hashSync(configuredPassword || 'Shivanda@123', 10);
    await db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, hash);
    return;
  }

  if (!configuredPassword) return;
  const isPasswordMatch = bcrypt.compareSync(configuredPassword, existing.password_hash || '');
  if (!isPasswordMatch) {
    const hash = bcrypt.hashSync(configuredPassword, 10);
    await db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  }
}

// Mirrors every INSERT/UPDATE/DELETE to durable storage. Reads are untouched.
function wrapSqliteWrites(rawDb) {
  const isWrite = (sql) => /^\s*(insert|update|delete|replace)\b/i.test(String(sql));

  return new Proxy(rawDb, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql, ...rest) => {
          const statement = target.prepare(sql, ...rest);
          if (!isWrite(sql)) return statement;
          return new Proxy(statement, {
            get(st, key) {
              if (key === 'run') {
                return (...args) => {
                  const result = st.run(...args);
                  sqlitePersistence.markDirty(databaseFile);
                  return result;
                };
              }
              const value = st[key];
              return typeof value === 'function' ? value.bind(st) : value;
            }
          });
        };
      }
      if (prop === 'exec') {
        return (sql) => {
          const result = target.exec(sql);
          sqlitePersistence.markDirty(databaseFile);
          return result;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function ensureDefaultSettings() {
  const defaults = {
    company_name: 'Shivanda Properties & Construction',
    phone: '+91 96860 01144',
    whatsapp: '+91 96860 01144',
    email: 'Shivandapropertiesandconstruct@gmail.com',
    address: '3457, First Floor, Vijaya Vittal Nagar, Sondekoppa Main Road, Nelamangala Town, Bengaluru 562123',
    map_link: 'https://maps.google.com/?q=3457%20Vijaya%20Vittal%20Nagar%2C%20Sondekoppa%20Main%20Road%2C%20Nelamangala%20Town%2C%20Bengaluru%20562123',
    stats_years: '12+',
    stats_properties: '480+',
    stats_homes: '120+',
    stats_families: '1,200+',
    hero_quote: 'Trusted real estate and construction guidance in Bengaluru.'
  };

  for (const [key, value] of Object.entries(defaults)) {
    const existing = await db.prepare('SELECT id FROM settings WHERE key = ?').get(key);
    if (!existing) {
      await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
}

function ensureSeedData() {
  const hasProperties = db.prepare('SELECT COUNT(*) AS count FROM properties').get().count;
  if (hasProperties > 0) return;

  const insertedNow = new Date().toISOString();
  const propertyRows = [
    {
      slug: 'sunrise-villas-bommanahalli',
      title: 'Sunrise Villas, Bommanahalli',
      price: 7800000,
      price_per_sqft: 6200,
      type: 'Villa',
      status: 'Available',
      locality: 'Bommanahalli',
      address: '18 Sunrise Avenue, Bommanahalli, Bengaluru',
      description: 'A premium villa community designed for low-maintenance luxury and family comfort.',
      latitude: 12.9141,
      longitude: 77.6093,
      bedrooms: 4,
      bathrooms: 3,
      area: 1250,
      facing: 'East',
      floor: 'Ground + 1',
      possession_date: '2026-03-15',
      rera_id: 'RERA-12345',
      amenities: JSON.stringify(['Clubhouse', 'Swimming Pool', 'Power Backup', 'Security', 'Landscaped Garden']),
      is_published: 1,
      created_at: insertedNow,
      updated_at: insertedNow
    },
    {
      slug: 'harbor-park-apartments-whitefield',
      title: 'Harbor Park Apartments, Whitefield',
      price: 9600000,
      price_per_sqft: 7100,
      type: 'Apartment',
      status: 'Available',
      locality: 'Whitefield',
      address: '52 Harbor Park, Whitefield, Bengaluru',
      description: 'Contemporary apartment living in a tech corridor with community amenities and green open spaces.',
      latitude: 12.9698,
      longitude: 77.7499,
      bedrooms: 3,
      bathrooms: 3,
      area: 1350,
      facing: 'North',
      floor: '7th Floor',
      possession_date: '2026-02-10',
      rera_id: 'RERA-22331',
      amenities: JSON.stringify(['Gym', 'Children Play Area', 'CCTV', 'Power Backup', '24x7 Security']),
      is_published: 1,
      created_at: insertedNow,
      updated_at: insertedNow
    },
    {
      slug: 'greenwood-plot-krpuram',
      title: 'Greenwood Plot, KR Puram',
      price: 5300000,
      price_per_sqft: 4200,
      type: 'Plot',
      status: 'Available',
      locality: 'KR Puram',
      address: 'Lot 14, River Road, KR Puram, Bengaluru',
      description: 'Well-located residential plot with clear titles and excellent connectivity to the airport corridor.',
      latitude: 13.0095,
      longitude: 77.6848,
      bedrooms: null,
      bathrooms: null,
      area: 1200,
      facing: 'South',
      floor: null,
      possession_date: '2027-01-01',
      rera_id: 'RERA-44001',
      amenities: JSON.stringify(['Road Access', 'Water Line', 'Electrical Provision', 'Gated Layout']),
      is_published: 1,
      created_at: insertedNow,
      updated_at: insertedNow
    },
    {
      slug: 'silverline-court-indiranagar',
      title: 'Silverline Court, Indiranagar',
      price: 14400000,
      price_per_sqft: 9200,
      type: 'Commercial',
      status: 'Available',
      locality: 'Indiranagar',
      address: '8 Silverline Court, Indiranagar, Bengaluru',
      description: 'Prime commercial address for businesses seeking visibility and premium footfall in central Bengaluru.',
      latitude: 12.9716,
      longitude: 77.6412,
      bedrooms: 0,
      bathrooms: 2,
      area: 1560,
      facing: 'West',
      floor: 'Ground + 3',
      possession_date: '2025-12-29',
      rera_id: 'RERA-33290',
      amenities: JSON.stringify(['Reception', 'Lift', 'Parking', 'Back Office', 'High Visibility']),
      is_published: 1,
      created_at: insertedNow,
      updated_at: insertedNow
    }
  ];

  for (const property of propertyRows) {
    db.prepare(`
      INSERT INTO properties (
        slug, title, price, price_per_sqft, type, status, locality, address, description,
        latitude, longitude, bedrooms, bathrooms, area, facing, floor, possession_date,
        rera_id, amenities, is_published, created_at, updated_at
      ) VALUES (
        @slug, @title, @price, @price_per_sqft, @type, @status, @locality, @address, @description,
        @latitude, @longitude, @bedrooms, @bathrooms, @area, @facing, @floor, @possession_date,
        @rera_id, @amenities, @is_published, @created_at, @updated_at
      )
    `).run(property);
  }

  const propertyRowsSelected = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const imagesByProperty = {
    1: ['https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=1200&q=80', 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1200&q=80'],
    2: ['https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=1200&q=80', 'https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1200&q=80'],
    3: ['https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=80'],
    4: ['https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80', 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1200&q=80']
  };

  propertyRowsSelected.forEach((property, index) => {
    const images = imagesByProperty[property.id] || [];
    images.forEach((imageUrl, imageIndex) => {
      db.prepare('INSERT INTO property_images (property_id, image_url, is_cover, sort_order) VALUES (?, ?, ?, ?)').run(
        property.id,
        imageUrl,
        imageIndex === 0 ? 1 : 0,
        imageIndex
      );
    });
  });

  PACKAGE_PLANS.forEach((plan) => {
    db.prepare('INSERT INTO packages (name, rate, badge, active) VALUES (?, ?, ?, 1)').run(plan.name, plan.rate, plan.badge);
    const inserted = db.prepare('SELECT * FROM packages WHERE name = ? ORDER BY id DESC LIMIT 1').get(plan.name);
    specRows(plan).forEach((row) => {
      db.prepare('INSERT INTO package_specs (package_id, group_name, label, content, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(inserted.id, row.group_name, row.label, row.content, row.sort_order);
    });
  });

  db.prepare('INSERT INTO testimonials (name, location, quote, youtube_url) VALUES (?, ?, ?, ?)').run(
    'Vivek Shankar',
    'Koramangala',
    'The team gave us a clear legal and construction path and delivered exactly as promised.',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );

  db.prepare('INSERT INTO testimonials (name, location, quote, youtube_url) VALUES (?, ?, ?, ?)').run(
    'Nandini Rao',
    'Whitefield',
    'Their design recommendations and site tracking kept the project stress-free throughout construction.',
    null
  );

  db.prepare('INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)').run(
    'Do you help with home loan assistance?',
    'Yes, we guide buyers toward trusted lenders and help coordinate documents for smoother processing.',
    1
  );
  db.prepare('INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)').run(
    'Can I customise a construction package?',
    'Absolutely. The package can be adjusted based on your plot size, finishes and preferred layouts.',
    2
  );
  db.prepare('INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)').run(
    'How do I know the property title is clear?',
    'We work with legal and registration partners to verify documents before you commit to a purchase.',
    3
  );

  db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)').run(
    'Modern G+2 Residence',
    'Bengaluru',
    '/images/project-elevation-modern.webp'
  );
  db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)').run(
    'Contemporary Villa',
    'Bengaluru',
    '/images/project-villa-contemporary.webp'
  );
  db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)').run(
    'Vivid Facade Residence',
    'Bengaluru',
    '/images/project-elevation-vivid.webp'
  );
  db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)').run(
    'Slate Facade Residence',
    'Bengaluru',
    '/images/project-residence-slate.webp'
  );
  db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)').run(
    'Terrace Balcony Residence',
    'Bengaluru',
    '/images/project-residence-terrace.webp'
  );
  db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)').run(
    'Jaali Screen Residence',
    'Bengaluru',
    '/images/project-elevation-jaali.webp'
  );
  db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)').run(
    'Lattice Detail Elevation',
    'Bengaluru',
    '/images/project-elevation-lattice.webp'
  );

  // No sample enquiries: a fake "customer" in the dashboard is mistaken for a
  // real lead, and this data is now kept permanently.
}

async function initializeDatabase() {
  let restored = false;
  if (!dbInstance && blobPersistence) {
    restored = await openPersistentSqlite();
  }

  await ensureTables();
  await ensureAdmin();
  await ensureDefaultSettings();
  if (!usesPostgres) ensureSeedData();

  // A brand-new sandbox has nothing saved yet: write the starting state so the
  // next instance restores it instead of starting from scratch.
  if (blobPersistence && !restored) {
    sqlitePersistence.markDirty(databaseFile);
    await sqlitePersistence.flush();
  }
}

const TRACKED_TABLES = [
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

// Where the records actually live, plus live proof that they are being stored:
// row counts per table and whether the application can still write.
async function databaseReport() {
  const report = {
    ...storageInfo,
    writable: null,
    rows: {},
    totalRecords: 0,
    mirror: sqlitePersistence.status()
  };

  for (const table of TRACKED_TABLES) {
    try {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      const count = Number(row && row.count) || 0;
      report.rows[table] = count;
      report.totalRecords += count;
    } catch (error) {
      report.rows[table] = null;
    }
  }

  try {
    if (usesPostgres) {
      // Ask the database whether this role may insert, instead of writing a probe row.
      const privilege = await db.prepare("SELECT has_table_privilege('enquiries', 'INSERT') AS ok").get();
      report.writable = Boolean(privilege && privilege.ok);
    } else {
      fs.accessSync(storageInfo.host, fs.constants.W_OK);
      report.writable = true;
    }
  } catch (error) {
    report.writable = false;
  }

  return report;
}

let cachedSettings = null;
let cachedSettingsTime = 0;

async function readSettings() {
  const now = Date.now();
  if (cachedSettings && (now - cachedSettingsTime < 30000)) {
    return cachedSettings;
  }
  const settings = await db.prepare('SELECT key, value FROM settings').all();
  cachedSettings = Object.fromEntries(settings.map((row) => [row.key, row.value]));
  cachedSettingsTime = now;
  return cachedSettings;
}

module.exports = {
  db,
  storageInfo,
  databaseReport,
  initializeDatabase,
  ensureTables,
  ensureAdmin,
  ensureDefaultSettings,
  readSettings,
  setSetting: async (key, value) => {
    cachedSettings = null;
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
};
