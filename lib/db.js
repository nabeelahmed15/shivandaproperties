const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const PostgresDatabase = require('./postgres');

const runningInFunction = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);
const usesPostgres = Boolean(process.env.DATABASE_URL);
if (runningInFunction && !usesPostgres) {
  console.warn(
    '[shivanda] DATABASE_URL is not set; using temporary SQLite storage. ' +
      'Data will reset on every cold start or new deploy. Set DATABASE_URL in the Netlify dashboard ' +
      'to use the persistent database.'
  );
}

let db;

if (usesPostgres) {
  db = new PostgresDatabase(process.env.DATABASE_URL);
} else {
  const Database = require('better-sqlite3');
  const dataDir = process.env.DATA_DIR || (runningInFunction
    ? path.join(os.tmpdir(), 'shivanda-data')
    : path.join(__dirname, '..', 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'shivanda.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

async function ensureTables() {
  if (usesPostgres) {
    const schemaPath = path.join(runningInFunction ? process.cwd() : path.join(__dirname, '..'), 'data', 'schema.postgres.sql');
    await db.exec(fs.readFileSync(schemaPath, 'utf8'));
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
}

async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@shivanda.com').trim();
  const password = process.env.ADMIN_PASSWORD || 'Shivanda@123';
  const existing = await db.prepare('SELECT * FROM admins WHERE email = ?').get(email);

  if (!existing) {
    const hash = bcrypt.hashSync(password, 10);
    await db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, hash);
    return;
  }

  const isPasswordMatch = bcrypt.compareSync(password, existing.password_hash || '');
  if (!isPasswordMatch) {
    const hash = bcrypt.hashSync(password, 10);
    await db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  }
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

  const defaultPackages = [
    { name: 'Elegance', rate: 1999, badge: null },
    { name: 'Premium', rate: 2149, badge: 'Most Chosen' },
    { name: 'Elite', rate: 2299, badge: 'Best Value' },
    { name: 'Luxury', rate: 2399, badge: null }
  ];

  defaultPackages.forEach((pkg) => {
    db.prepare('INSERT INTO packages (name, rate, badge, active) VALUES (?, ?, ?, 1)').run(pkg.name, pkg.rate, pkg.badge);
  });

  const packageMap = db.prepare('SELECT * FROM packages ORDER BY id').all();
  const packageSpecs = {
    Elegance: ['Design', 'Structure', 'Kitchen', 'Bathroom', 'Plumbing', 'Doors & Windows', 'Painting', 'Flooring', 'Electrical', 'Elevation', 'Miscellaneous'],
    Premium: ['Design', 'Structure', 'Kitchen', 'Bathroom', 'Plumbing', 'Doors & Windows', 'Painting', 'Flooring', 'Electrical', 'Elevation', 'Miscellaneous'],
    Elite: ['Design', 'Structure', 'Kitchen', 'Bathroom', 'Plumbing', 'Doors & Windows', 'Painting', 'Flooring', 'Electrical', 'Elevation', 'Miscellaneous'],
    Luxury: ['Design', 'Structure', 'Kitchen', 'Bathroom', 'Plumbing', 'Doors & Windows', 'Painting', 'Flooring', 'Electrical', 'Elevation', 'Miscellaneous']
  };

  packageMap.forEach((pkg) => {
    packageSpecs[pkg.name].forEach((label, index) => {
      const placeholder = 'Placeholder: Replace with client-specific specification for ' + pkg.name + ' package.';
      db.prepare('INSERT INTO package_specs (package_id, label, content, sort_order) VALUES (?, ?, ?, ?)').run(pkg.id, label, placeholder, index);
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

  db.prepare('INSERT INTO enquiries (property_id, property_name, package_name, service_type, buyer_name, phone, email, budget_range, message, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    1,
    'Sunrise Villas, Bommanahalli',
    null,
    'Buy',
    'Rohan Kumar',
    '+919876543210',
    'rohan@example.com',
    '₹50L - ₹1Cr',
    'Interested in the villa and would like a site visit.',
    'New',
    new Date().toISOString(),
    new Date().toISOString()
  );
}

async function initializeDatabase() {
  await ensureTables();
  await ensureAdmin();
  await ensureDefaultSettings();
  if (!usesPostgres) ensureSeedData();
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
