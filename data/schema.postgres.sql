CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS properties (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  price BIGINT,
  price_per_sqft BIGINT,
  type TEXT,
  status TEXT DEFAULT 'Available',
  locality TEXT,
  address TEXT,
  description TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  bedrooms INTEGER,
  bathrooms INTEGER,
  area INTEGER,
  facing TEXT,
  floor TEXT,
  possession_date TEXT,
  rera_id TEXT,
  amenities TEXT,
  is_published INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS property_images (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  is_cover INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS packages (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  rate BIGINT,
  badge TEXT,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS package_specs (
  id BIGSERIAL PRIMARY KEY,
  package_id BIGINT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  group_name TEXT,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enquiries (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT,
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS testimonials (
  id BIGSERIAL PRIMARY KEY,
  name TEXT,
  location TEXT,
  quote TEXT,
  youtube_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS faqs (
  id BIGSERIAL PRIMARY KEY,
  question TEXT,
  answer TEXT,
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projects_gallery (
  id BIGSERIAL PRIMARY KEY,
  title TEXT,
  location TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS settings (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE,
  value TEXT
);
CREATE INDEX IF NOT EXISTS enquiries_created_at_idx ON enquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS property_images_property_idx ON property_images (property_id, is_cover, sort_order);