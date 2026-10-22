require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcrypt');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const multer = require('multer');
const sharp = require('sharp');
const z = require('zod');
const ExcelJS = require('exceljs');
const cloudinary = require('cloudinary').v2;
const { db, initializeDatabase, readSettings, setSetting, databaseReport } = require('./lib/db');
const {
  dailyBackup,
  collectSnapshot,
  backupSummary,
  restoreEnquiriesFromLatestBackup
} = require('./lib/backup');
const { resolveSessionSecret, securityReport, isProductionLike } = require('./lib/security');
const { saveEnquiry, removeEnquiry, rehydrate } = require('./lib/enquiry-store');
const sqlitePersistence = require('./lib/sqlite-persistence');
const { groupSpecs } = require('./lib/package-specs');
const {
  sendEnquiryAlert,
  getWhatsAppStatus,
  buildVisitorMessage,
  whatsappChatUrl
} = require('./lib/whatsapp-notify');

const runningInFunction = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);
if (runningInFunction) {
  const requiredEnvironment = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
  const missingEnvironment = requiredEnvironment.filter((key) => !process.env[key]);
  if (missingEnvironment.length) {
    console.warn(
      `[shivanda] Missing Netlify environment variables: ${missingEnvironment.join(', ')}. ` +
      'Falling back to defaults; set them in the Netlify dashboard (Site configuration > Environment variables) ' +
      'for persistent data and secure credentials.'
    );
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = process.env.NETLIFY ? process.cwd() : __dirname;
const uploadsDir = process.env.UPLOADS_DIR || (runningInFunction && !process.env.CLOUDINARY_URL
  ? path.join(os.tmpdir(), 'shivanda-uploads')
  : path.join(rootDir, 'public', 'uploads'));

if (!process.env.CLOUDINARY_URL) fs.mkdirSync(uploadsDir, { recursive: true });
const dbReady = initializeDatabase()
  .then(() => rehydrate(db))
  .then(async () => {
    // If the database comes back empty (reset, or a swapped connection string),
    // put the enquiries from the newest snapshot back so they are not lost.
    const restored = await restoreEnquiriesFromLatestBackup();
    if (restored && restored.restored > 0) {
      console.log(`[shivanda] Restored ${restored.restored} enquir${restored.restored === 1 ? 'y' : 'ies'} from backup ${restored.source}.`);
    }
    return restored;
  });

// Free, self-hosted safety net: one JSON snapshot per day in the local backups
// folder (already synced by OneDrive). Never blocks or breaks start-up.
dbReady
  .then(() => dailyBackup())
  .then((result) => {
    if (result && !result.skipped) console.log(`[shivanda] Daily backup written to ${result.file}`);
  })
  .catch((error) => console.warn('[shivanda] Daily backup skipped:', error && error.message));

const siteSettings = () => readSettings();

app.set('view engine', 'ejs');
app.engine('ejs', require('ejs').__express);
app.set('views', path.join(rootDir, 'views'));
// Cap request sizes so a huge body cannot tie up the server.
app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 2000 }));
app.use(express.json({ limit: '1mb' }));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      // Nobody may frame the site (clickjacking protection).
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      // Inline styles/scripts are used throughout the templates and admin forms.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://maps.googleapis.com', 'https://maps.gstatic.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      // Unsplash is listed because the seeded property photos are hosted there;
      // photos uploaded through the admin panel go to Cloudinary.
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://res.cloudinary.com',
        'https://images.unsplash.com',
        'https://maps.gstatic.com',
        'https://maps.googleapis.com'
      ],
      frameSrc: ['https://maps.google.com', 'https://www.google.com'],
      connectSrc: ["'self'"],
      ...(isProductionLike() ? { upgradeInsecureRequests: [] } : {})
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.set('trust proxy', 1);

// A weak or missing secret must never quietly sign real admin sessions.
const sessionSecret = resolveSessionSecret();
if (sessionSecret.weak) {
  console.warn(`[shivanda] SECURITY: ${sessionSecret.reason}`);
}

app.use(cookieSession({
  name: 'shivanda.session',
  keys: [sessionSecret.secret],
  maxAge: 1000 * 60 * 60 * 8,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));
app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (error) {
    next(error);
  }
});

// On Netlify the SQLite file only lives as long as one instance. Before any
// response to a change is sent, wait until that change has been copied to
// durable storage, so a submitted enquiry or property edit cannot evaporate.
if (sqlitePersistence.isEnabled()) {
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    const originalEnd = res.end.bind(res);
    let finished = false;
    res.end = (...args) => {
      if (finished) return originalEnd(...args);
      finished = true;
      sqlitePersistence.flush().catch(() => {}).finally(() => originalEnd(...args));
      return res;
    };
    return next();
  });
}

app.use(express.static(path.join(rootDir, 'public'), { maxAge: '30d' }));
if (!process.env.CLOUDINARY_URL) app.use('/uploads', express.static(uploadsDir));

// Records are only ever addressed by numeric id, so a malformed id can never
// reach a query.
app.param('id', (req, res, next, value) => {
  if (!/^\d+$/.test(String(value))) return res.status(400).send('Invalid id.');
  return next();
});

const csrfProtection = csrf();
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return csrfProtection(req, res, next);
  }
  return next();
});
app.use(async (req, res, next) => {
  try {
    res.locals.siteSettings = await siteSettings();
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
    next();
  } catch (error) {
    next(error);
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { success: false, error: 'Too many login attempts. Please wait a bit and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});

const enquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many enquiries sent from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const uploadConfig = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image uploads are allowed.'));
    }
  }
});

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'property';
}

function formatPrice(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount === 0) return '₹0';
  if (amount >= 10000000) {
    const crore = amount / 10000000;
    return `₹${crore.toFixed(2).replace(/\.00$/, '')} Cr`;
  }
  const lakh = amount / 100000;
  return `₹${lakh.toFixed(2).replace(/\.00$/, '')} L`;
}

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16).replace('T', ' ');
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata'
  }).format(date);
}

async function generateCardImage(property) {
  const existing = await db.prepare(
    'SELECT image_url FROM property_images WHERE property_id = ? AND is_cover = 1 ORDER BY sort_order LIMIT 1'
  ).get(property.id);
  return existing ? existing.image_url : '/images/logo.webp';
}

function parseAmenities(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    // ignore malformed JSON and fall through to string split
  }
  return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
}

async function saveUploadedImages(files, propertyId) {
  const results = [];
  if (!files || !files.length) return results;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const safeName = `${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}.webp`;
    const fullFile = path.join(uploadsDir, safeName);
    const thumbFile = path.join(uploadsDir, `thumb-${safeName}`);

    const fullBuffer = await sharp(file.buffer)
      .resize({ width: 1400, withoutEnlargement: true })
      .toFormat('webp', { quality: 82 })
      .toBuffer();

    const thumbBuffer = await sharp(file.buffer)
      .resize({ width: 420, withoutEnlargement: true })
      .toFormat('webp', { quality: 78 })
      .toBuffer();

    let imageUrl = `/uploads/${safeName}`;
    let thumbUrl = `/uploads/thumb-${safeName}`;
    if (process.env.CLOUDINARY_URL) {
      const uploaded = await cloudinary.uploader.upload(`data:image/webp;base64,${fullBuffer.toString('base64')}`, {
        folder: 'shivanda/properties',
        public_id: safeName.replace(/\.webp$/, '')
      });
      imageUrl = uploaded.secure_url;
      thumbUrl = uploaded.secure_url;
    } else {
      fs.writeFileSync(fullFile, fullBuffer);
      fs.writeFileSync(thumbFile, thumbBuffer);
    }

    await db.prepare('INSERT INTO property_images (property_id, image_url, is_cover, sort_order) VALUES (?, ?, ?, ?)')
      .run(propertyId, imageUrl, index === 0 ? 1 : 0, index);
    results.push({ full: imageUrl, thumb: thumbUrl });
  }
  return results;
}

async function deleteUploadedImage(imageUrl) {
  if (!imageUrl) return;
  if (process.env.CLOUDINARY_URL && /^https?:\/\//.test(imageUrl)) {
    const cloudPath = new URL(imageUrl).pathname.split('/upload/')[1];
    if (!cloudPath) return;
    const publicId = cloudPath.split('/').filter((part) => !/^v\d+$/.test(part)).join('/').replace(/\.[^.]+$/, '');
    await cloudinary.uploader.destroy(publicId);
    return;
  }
  if (!imageUrl.startsWith('/uploads/')) return;
  const safePath = path.join(uploadsDir, path.basename(imageUrl));
  if (fs.existsSync(safePath)) {
    fs.unlinkSync(safePath);
  }
}

function propertyListQuery(whereClause = 'WHERE p.is_published = 1') {
  return db.prepare(`
    SELECT p.*, 
      (SELECT pi.image_url FROM property_images pi WHERE pi.property_id = p.id AND pi.is_cover = 1 ORDER BY pi.sort_order LIMIT 1) AS cover_image,
      (SELECT COUNT(*) FROM property_images pi WHERE pi.property_id = p.id) AS image_count
    FROM properties p
    ${whereClause}
    ORDER BY p.created_at DESC
  `);
}

app.get('/', async (req, res) => {
  const properties = (await propertyListQuery('WHERE p.is_published = 1').all()).slice(0, 4);
  const packages = await db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY id').all();
  const packagesWithSpecs = await Promise.all(packages.map(async (pkg) => {
    const specs = await db.prepare('SELECT * FROM package_specs WHERE package_id = ? ORDER BY sort_order, id').all(pkg.id);
    return { ...pkg, specs, groups: groupSpecs(specs) };
  }));
  const faqs = await db.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all();
  const testimonials = await db.prepare('SELECT * FROM testimonials ORDER BY id DESC').all();
  const gallery = await db.prepare('SELECT * FROM projects_gallery ORDER BY id DESC LIMIT 12').all();

  res.render('index', {
    title: 'Shivanda Properties & Construction | Real Estate and Construction in Bengaluru',
    properties,
    packages: packagesWithSpecs,
    faqs,
    testimonials,
    gallery,
    formatPrice
  });
});

app.get('/properties', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = 6;
  const location = String(req.query.location || '').trim();
  const budgetMin = Number(req.query.minBudget || 0) || 0;
  const budgetMax = Number(req.query.maxBudget || 0) || 0;
  const type = String(req.query.type || '').trim();
  const status = String(req.query.status || '').trim();
  const sort = String(req.query.sort || 'newest');

  const clauses = ['p.is_published = 1'];
  const params = [];

  if (location) {
    clauses.push('p.locality LIKE ?');
    params.push(`%${location}%`);
  }
  if (budgetMin > 0) {
    clauses.push('p.price >= ?');
    params.push(budgetMin);
  }
  if (budgetMax > 0) {
    clauses.push('p.price <= ?');
    params.push(budgetMax);
  }
  if (type) {
    clauses.push('p.type = ?');
    params.push(type);
  }
  if (status) {
    clauses.push('p.status = ?');
    params.push(status);
  }

  const whereClause = `WHERE ${clauses.join(' AND ')}`;
  const sortSql = sort === 'price_low_high' ? 'ORDER BY p.price ASC' : sort === 'price_high_low' ? 'ORDER BY p.price DESC' : 'ORDER BY p.created_at DESC';

  const countRow = await db.prepare(`
    SELECT COUNT(*) AS count FROM properties p ${whereClause}
  `).get(...params);

  const totalPages = Math.max(1, Math.ceil((countRow.count || 0) / limit));
  const offset = (page - 1) * limit;

  const properties = await db.prepare(`
    SELECT p.*, 
      (SELECT pi.image_url FROM property_images pi WHERE pi.property_id = p.id AND pi.is_cover = 1 ORDER BY pi.sort_order LIMIT 1) AS cover_image,
      (SELECT COUNT(*) FROM property_images pi WHERE pi.property_id = p.id) AS image_count
    FROM properties p
    ${whereClause}
    ${sortSql}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('properties', {
    title: 'Property Listings',
    properties,
    page,
    totalPages,
    filters: { location, budgetMin, budgetMax, type, status, sort },
    formatPrice,
    activeFilterCount: [location, type, status, budgetMin > 0, budgetMax > 0].filter(Boolean).length
  });
});

app.get('/property/:slug', async (req, res) => {
  const property = await db.prepare('SELECT * FROM properties WHERE slug = ? AND is_published = 1 LIMIT 1').get(req.params.slug);
  if (!property) return res.status(404).render('404', { title: 'Property not found' });

  const gallery = await db.prepare('SELECT * FROM property_images WHERE property_id = ? ORDER BY sort_order, id').all(property.id);
  const amenities = parseAmenities(property.amenities);
  const similar = await db.prepare(
    'SELECT * FROM properties WHERE is_published = 1 AND type = ? AND id != ? ORDER BY created_at DESC LIMIT 3'
  ).all(property.type, property.id);

  const similarProperties = await Promise.all(similar.map(async (item) => ({
    ...item,
    cover_image: await generateCardImage(item)
  })));

  res.render('property-detail', {
    title: property.title,
    property,
    gallery,
    amenities,
    similarProperties,
    formatPrice,
    settings: await siteSettings()
  });
});

app.get('/construction', async (req, res) => {
  const packages = await db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY id').all();
  const packagesWithSpecs = await Promise.all(packages.map(async (pkg) => {
    const specs = await db.prepare('SELECT * FROM package_specs WHERE package_id = ? ORDER BY sort_order, id').all(pkg.id);
    return { ...pkg, specs, groups: groupSpecs(specs) };
  }));
  const gallery = await db.prepare('SELECT * FROM projects_gallery ORDER BY id DESC LIMIT 12').all();

  res.render('construction', {
    title: 'Construction Packages',
    packages: packagesWithSpecs,
    gallery,
    formatPrice
  });
});

app.get('/contact', async (req, res) => {
  // Enquiry buttons link here with the package or property the visitor tapped,
  // so the form and the saved enquiry both carry that context.
  const interest = String(req.query.interest || '').trim().slice(0, 100);
  let packageName = '';
  let interestedProperty = '';

  if (interest) {
    const pkg = await db.prepare('SELECT name FROM packages WHERE active = 1 AND name = ?').get(interest);
    if (pkg) {
      packageName = pkg.name;
    } else {
      const property = await db.prepare('SELECT title FROM properties WHERE title = ? AND is_published = 1').get(interest);
      if (property) interestedProperty = property.title;
    }
  }

  res.render('contact', {
    title: 'Contact Shivanda',
    interest,
    packageName,
    interestedProperty,
    serviceType: packageName ? 'Construction' : (interestedProperty ? 'Buy' : 'Buy')
  });
});

app.get('/admin/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin-login', { title: 'Shivanda Admin Login' });
});

app.post('/admin/login', loginLimiter, csrfProtection, async (req, res) => {
  const schema = z.object({
    email: z.string().trim().email(),
    password: z.string().min(6)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Please provide valid admin credentials.' });
  }

  const user = await db.prepare('SELECT * FROM admins WHERE email = ?').get(parsed.data.email);
  if (!user || !bcrypt.compareSync(parsed.data.password, user.password_hash)) {
    return res.status(401).json({ success: false, error: 'Invalid admin email or password.' });
  }

  req.session.adminId = user.id;
  req.session.adminEmail = user.email;
  return res.json({ success: true, redirect: '/admin' });
});

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.redirect('/admin/login');
  }
  return next();
}

app.get('/admin/logout', requireAdmin, (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, async (req, res) => {
  const propertyList = await db.prepare(`
    SELECT p.*, 
      (SELECT pi.image_url FROM property_images pi WHERE pi.property_id = p.id AND pi.is_cover = 1 ORDER BY pi.sort_order LIMIT 1) AS cover_image
    FROM properties p
    ORDER BY p.created_at DESC
  `).all();

  // Show every enquiry, newest first: limiting this to the last few rows made
  // real enquiries look missing whenever the list filled up with test entries.
  const recentEnquiries = await db.prepare('SELECT * FROM enquiries ORDER BY created_at DESC, id DESC').all();
  const packages = await db.prepare('SELECT * FROM packages ORDER BY id').all();
  const packageRows = await Promise.all(packages.map(async (pkg) => {
    const specs = await db.prepare('SELECT * FROM package_specs WHERE package_id = ? ORDER BY sort_order, id').all(pkg.id);
    return { ...pkg, specs, groups: groupSpecs(specs) };
  }));
  const testimonials = await db.prepare('SELECT * FROM testimonials ORDER BY id DESC').all();
  const faqs = await db.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all();
  const gallery = await db.prepare('SELECT * FROM projects_gallery ORDER BY id DESC').all();
  const settings = await siteSettings();

  const overview = {
    propertyCount: (await db.prepare('SELECT COUNT(*) AS count FROM properties').get()).count,
    publishedCount: (await db.prepare('SELECT COUNT(*) AS count FROM properties WHERE is_published = 1').get()).count,
    newEnquiries: (await db.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE status = 'New'").get()).count,
    byStatus: await db.prepare('SELECT status, COUNT(*) AS count FROM enquiries GROUP BY status').all()
  };

  const notice = req.session.adminNotice || null;
  // Assign null rather than deleting: cookie-session only persists changes it sees.
  req.session.adminNotice = null;

  res.render('admin-dashboard', {
    title: 'Shivanda Admin',
    notice,
    overview,
    properties: propertyList,
    enquiries: recentEnquiries,
    packages: packageRows,
    testimonials,
    faqs,
    gallery,
    settings,
    storage: await databaseReport(),
    backup: backupSummary(),
    security: await securityReport(),
    sessionSecretWeak: sessionSecret.weak,
    whatsappAlerts: getWhatsAppStatus(settings),
    whatsappChatUrl,
    formatWhen,
    formatPrice
  });
});

function propertySchema(defaults = {}) {
  return z.object({
    title: z.string().min(3),
    price: z.coerce.number().min(100000),
    type: z.enum(['Apartment', 'Villa', 'Plot', 'Commercial', 'Independent House']),
    status: z.enum(['Available', 'Sold', 'Rented']),
    locality: z.string().min(2),
    address: z.string().min(8),
    description: z.string().min(15),
    bedrooms: z.coerce.number().int().min(0).optional().default(0),
    bathrooms: z.coerce.number().int().min(0).optional().default(0),
    area: z.coerce.number().int().min(0).optional().default(0),
    facing: z.string().optional().default('East'),
    floor: z.string().optional().default('Ground'),
    possession_date: z.string().optional().default(''),
    rera_id: z.string().optional().default(''),
    latitude: z.coerce.number().optional().default(12.9716),
    longitude: z.coerce.number().optional().default(77.5946),
    is_published: z.coerce.number().optional().default(defaults.is_published ?? 1),
    amenities: z.string().optional().default('')
  });
}

function normalizePropertyBody(body) {
  const cleaned = { ...body };
  for (const key of ['bedrooms', 'bathrooms', 'area', 'latitude', 'longitude', 'is_published']) {
    if (cleaned[key] === '' || cleaned[key] == null) delete cleaned[key];
  }
  return cleaned;
}

const PROPERTY_FIELD_MESSAGES = {
  title: 'Title must be at least 3 characters.',
  price: 'Price must be at least ₹1,00,000 - enter the full amount in rupees (for example 8500000).',
  type: 'Choose a valid property type.',
  status: 'Choose a valid status.',
  locality: 'Locality must be at least 2 characters.',
  address: 'Address must be at least 8 characters.',
  description: 'Description must be at least 15 characters.',
  bedrooms: 'Bedrooms must be a whole number of 0 or more.',
  bathrooms: 'Bathrooms must be a whole number of 0 or more.',
  area: 'Area must be a whole number of square feet (enter 0 if it is not known).',
  latitude: 'Latitude must be a valid number.',
  longitude: 'Longitude must be a valid number.'
};

function propertyErrorMessage(fieldErrors) {
  const details = Object.keys(fieldErrors || {})
    .map((field) => PROPERTY_FIELD_MESSAGES[field] || `${field} is invalid.`)
    .join(' ');
  return `Property not saved. ${details}`;
}

// The admin property form is a regular HTML form, so a raw JSON 400 would be unreadable.
// Keep JSON for API callers, and show the real problem as a notice on the dashboard instead.
function sendPropertyValidationError(req, res, fieldErrors) {
  const message = propertyErrorMessage(fieldErrors);
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(400).json({ success: false, error: message, fields: fieldErrors || {} });
  }
  req.session.adminNotice = { type: 'error', text: message };
  return res.redirect('/admin#properties');
}

app.post('/admin/properties', requireAdmin, uploadConfig.array('images', 8), csrfProtection, async (req, res) => {
  try {
    const parsed = propertySchema().safeParse(normalizePropertyBody(req.body));
    if (!parsed.success) {
      return sendPropertyValidationError(req, res, parsed.error.flatten().fieldErrors);
    }

    const data = parsed.data;
    let slug = slugify(data.title);
    let counter = 1;
    while (await db.prepare('SELECT id FROM properties WHERE slug = ?').get(slug)) {
      slug = `${slugify(data.title)}-${counter}`;
      counter += 1;
    }

    const result = await db.prepare(`
      INSERT INTO properties (
        slug, title, price, type, status, locality, address, description,
        latitude, longitude, bedrooms, bathrooms, area, facing, floor, possession_date,
        rera_id, amenities, is_published, created_at, updated_at, price_per_sqft
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?
      )
    `).run(
      slug,
      data.title,
      Number(data.price),
      data.type,
      data.status,
      data.locality,
      data.address,
      data.description,
      Number(data.latitude),
      Number(data.longitude),
      Number(data.bedrooms),
      Number(data.bathrooms),
      Number(data.area),
      data.facing,
      data.floor,
      data.possession_date,
      data.rera_id,
      JSON.stringify(String(data.amenities).split(',').map((item) => item.trim()).filter(Boolean)),
      Number(data.is_published),
      Math.round(Number(data.price) / Math.max(Number(data.area), 1))
    );

    if (req.files && req.files.length) {
      await saveUploadedImages(req.files, result.lastInsertRowid);
    }

    req.session.adminNotice = {
      type: 'success',
      text: data.is_published ? 'Property saved and published.' : 'Property saved as a draft.'
    };
    return res.redirect('/admin#properties');
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: 'Property could not be saved. Please try again.' });
  }
});

app.post('/admin/properties/:id/toggle', requireAdmin, csrfProtection, async (req, res) => {
  const property = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!property) return res.status(404).send('Property not found');
  const nextValue = property.is_published ? 0 : 1;
  await db.prepare(`UPDATE properties SET is_published = ?, updated_at = datetime('now') WHERE id = ?`).run(nextValue, property.id);
  res.redirect('/admin#properties');
});

app.post('/admin/properties/:id/delete', requireAdmin, csrfProtection, async (req, res) => {
  const property = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!property) return res.status(404).send('Property not found');

  const images = await db.prepare('SELECT image_url FROM property_images WHERE property_id = ?').all(property.id);
  await Promise.all(images.map((row) => deleteUploadedImage(row.image_url)));

  await db.prepare('DELETE FROM property_images WHERE property_id = ?').run(property.id);
  await db.prepare('DELETE FROM properties WHERE id = ?').run(property.id);
  res.redirect('/admin#properties');
});

app.post('/admin/properties/:id/update', requireAdmin, uploadConfig.array('images', 8), csrfProtection, async (req, res) => {
  try {
    const property = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
    if (!property) return res.status(404).send('Property not found');

    const parsed = propertySchema({ is_published: property.is_published }).safeParse(normalizePropertyBody(req.body));
    if (!parsed.success) {
      return sendPropertyValidationError(req, res, parsed.error.flatten().fieldErrors);
    }

    const data = parsed.data;
    const slug = slugify(data.title);

    await db.prepare(`
      UPDATE properties SET
        slug = ?, title = ?, price = ?, type = ?, status = ?, locality = ?, address = ?, description = ?,
        latitude = ?, longitude = ?, bedrooms = ?, bathrooms = ?, area = ?, facing = ?, floor = ?, possession_date = ?,
        rera_id = ?, amenities = ?, is_published = ?, updated_at = datetime('now'), price_per_sqft = ?
      WHERE id = ?
    `).run(
      slug,
      data.title,
      Number(data.price),
      data.type,
      data.status,
      data.locality,
      data.address,
      data.description,
      Number(data.latitude),
      Number(data.longitude),
      Number(data.bedrooms),
      Number(data.bathrooms),
      Number(data.area),
      data.facing,
      data.floor,
      data.possession_date,
      data.rera_id,
      JSON.stringify(String(data.amenities).split(',').map((item) => item.trim()).filter(Boolean)),
      Number(data.is_published),
      Math.round(Number(data.price) / Math.max(Number(data.area), 1)),
      property.id
    );

    if (req.files && req.files.length) {
      await saveUploadedImages(req.files, property.id);
    }

    res.redirect('/admin#properties');
  } catch (error) {
    console.error('Update property error:', error);
    res.status(500).json({ success: false, error: 'Property update failed.' });
  }
});

app.post('/admin/enquiries/:id/status', requireAdmin, csrfProtection, async (req, res) => {
  const validStatus = ['New', 'Contacted', 'Follow-up', 'Closed'];
  const status = String(req.body.status || '').trim();
  if (!validStatus.includes(status)) return res.status(400).send('Invalid status');

  await db.prepare(`UPDATE enquiries SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  const updated = await db.prepare('SELECT * FROM enquiries WHERE id = ?').get(req.params.id);
  await saveEnquiry(updated);
  res.redirect('/admin#enquiries');
});

app.post('/admin/enquiries/:id/delete', requireAdmin, csrfProtection, async (req, res) => {
  const removed = await db.prepare('SELECT * FROM enquiries WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM enquiries WHERE id = ?').run(req.params.id);
  await removeEnquiry(removed);
  res.redirect('/admin#enquiries');
});

app.post('/admin/packages', requireAdmin, csrfProtection, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const rate = Number(req.body.rate || 0);
  const badge = String(req.body.badge || '').trim();
  if (!name || !rate) return res.status(400).send('Package name and rate are required.');

  await db.prepare('INSERT INTO packages (name, rate, badge, active) VALUES (?, ?, ?, 1)').run(name, rate, badge || null);
  res.redirect('/admin#packages');
});

app.post('/admin/packages/:id', requireAdmin, csrfProtection, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const rate = Number(req.body.rate || 0);
  const badge = String(req.body.badge || '').trim();
  if (!name || !rate) return res.status(400).send('Package name and rate are required.');

  await db.prepare('UPDATE packages SET name = ?, rate = ?, badge = ? WHERE id = ?').run(name, rate, badge || null, req.params.id);
  res.redirect('/admin#packages');
});

app.post('/admin/packages/:id/specs', requireAdmin, csrfProtection, async (req, res) => {
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.status(400).send('Invalid package.');

  await db.prepare('DELETE FROM package_specs WHERE package_id = ?').run(packageId);
  const entries = String(req.body.specs || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 400);

  for (const [index, line] of entries.entries()) {
    // "Section | Item | Detail". Two-part lines keep the old "Item | Detail" shape.
    const parts = line.split('|').map((part) => part.trim());
    const hasSection = parts.length >= 3;
    const group = hasSection ? parts[0] || null : null;
    const label = (hasSection ? parts[1] : parts[0]) || `Spec ${index + 1}`;
    const content = (hasSection ? parts.slice(2).join(' | ') : parts.slice(1).join(' | ')) || 'Included';

    await db.prepare('INSERT INTO package_specs (package_id, group_name, label, content, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(packageId, group, label, content, index);
  }
  res.redirect('/admin#packages');
});

app.post('/admin/testimonials', requireAdmin, csrfProtection, async (req, res) => {
  await db.prepare('INSERT INTO testimonials (name, location, quote, youtube_url) VALUES (?, ?, ?, ?)')
    .run(req.body.name || 'Customer', req.body.location || 'Bengaluru', req.body.quote || 'Great experience', req.body.youtube_url || null);
  res.redirect('/admin#testimonials');
});

app.post('/admin/faqs', requireAdmin, csrfProtection, async (req, res) => {
  await db.prepare('INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)')
    .run(req.body.question || 'Question', req.body.answer || 'Answer', Number(req.body.sort_order || 0));
  res.redirect('/admin#faq');
});

app.post('/admin/gallery', requireAdmin, uploadConfig.single('image'), csrfProtection, async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).send('Please upload an image.');
    const safeName = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.webp`;
    const webpBuffer = await sharp(file.buffer).resize({ width: 1200, withoutEnlargement: true }).toFormat('webp', { quality: 82 }).toBuffer();
    let imageUrl;
    if (process.env.CLOUDINARY_URL) {
      const uploaded = await cloudinary.uploader.upload(`data:image/webp;base64,${webpBuffer.toString('base64')}`, {
        folder: 'shivanda/gallery',
        public_id: safeName.replace(/\.webp$/, '')
      });
      imageUrl = uploaded.secure_url;
    } else {
      fs.writeFileSync(path.join(uploadsDir, safeName), webpBuffer);
      imageUrl = `/uploads/${safeName}`;
    }

    await db.prepare('INSERT INTO projects_gallery (title, location, image_url) VALUES (?, ?, ?)')
      .run(req.body.title || 'Project', req.body.location || 'Bengaluru', imageUrl);
    res.redirect('/admin#gallery');
  } catch (error) {
    console.error('Gallery upload error', error);
    res.status(500).send('Unable to save gallery item.');
  }
});

app.post('/admin/settings', requireAdmin, csrfProtection, async (req, res) => {
  const fields = [
    ['company_name', req.body.company_name],
    ['phone', req.body.phone],
    ['whatsapp', req.body.whatsapp],
    ['email', req.body.email],
    ['address', req.body.address],
    ['map_link', req.body.map_link],
    ['stats_years', req.body.stats_years],
    ['stats_properties', req.body.stats_properties],
    ['stats_homes', req.body.stats_homes],
    ['stats_families', req.body.stats_families],
    ['wa_callmebot_phone', req.body.wa_callmebot_phone]
  ];

  // Only fields the form actually sent are updated, so a partial save can never
  // blank out the rest of the settings.
  await Promise.all(
    fields
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => setSetting(key, (value || '').trim()))
  );

  // The API key field is a password input and is never rendered back, so an
  // empty submission means "keep the saved key" rather than "delete it".
  const callmebotKey = String(req.body.wa_callmebot_key || '').trim();
  if (callmebotKey) {
    await setSetting('wa_callmebot_key', callmebotKey);
  } else if (req.body.wa_callmebot_clear === '1') {
    await setSetting('wa_callmebot_key', '');
  }

  res.redirect('/admin#settings');
});

app.post('/admin/password', requireAdmin, csrfProtection, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 8) return res.status(400).send('New password must be at least 8 characters long.');

  const admin = await db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!admin || !bcrypt.compareSync(current, admin.password_hash)) {
    return res.status(401).send('Current password is incorrect.');
  }

  await db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), admin.id);
  res.redirect('/admin#settings');
});

app.post('/api/enquiry', enquiryLimiter, csrfProtection, async (req, res) => {
  const enquirySchema = z.object({
    name: z.string().min(2).max(100),
    phone: z.preprocess(
      (value) => typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
      z.string().regex(/^(?:\+?91|0)?[6-9]\d{9}$/)
    ),
    email: z.string().email().or(z.literal('')).optional(),
    interestedProperty: z.string().optional(),
    serviceType: z.string().min(2).max(80),
    budgetRange: z.string().optional(),
    message: z.string().min(10).max(500),
    propertyId: z.coerce.number().int().positive().optional(),
    packageName: z.string().max(80).optional(),
    website: z.string().max(0).optional().default('')
  });

  try {
    const parsed = enquirySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Please correct the highlighted enquiry details and try again.' });
    }

    if (parsed.data.website && parsed.data.website.length > 0) {
      return res.status(400).json({ success: false, error: 'Invalid submission.' });
    }

    const duplicate = await db.prepare(`
      SELECT id FROM enquiries
      WHERE phone = ?
      AND created_at >= datetime('now', '-1 day')
      AND ((property_id = ? AND service_type = ?) OR package_name = ? OR property_name = ?)
      LIMIT 1
    `).get(parsed.data.phone, parsed.data.propertyId || 0, parsed.data.serviceType, parsed.data.packageName || '', parsed.data.interestedProperty || '');

    if (duplicate) {
      return res.status(409).json({ success: false, error: 'We already received a similar enquiry from this phone number in the last 24 hours. Our team will respond soon.' });
    }

    const property = parsed.data.propertyId ? await db.prepare('SELECT * FROM properties WHERE id = ?').get(parsed.data.propertyId) : null;
    // A package enquiry keeps its package name in package_name, so the admin
    // panel can show which package the visitor tapped instead of "General".
    const propertyName = property
      ? property.title
      : (parsed.data.interestedProperty || (parsed.data.packageName ? null : 'General enquiry'));

    await db.prepare(`
      INSERT INTO enquiries (
        property_id, property_name, package_name, service_type, buyer_name, phone, email,
        budget_range, message, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', datetime('now'), datetime('now'))
    `).run(
      property ? property.id : null,
      propertyName,
      parsed.data.packageName || null,
      parsed.data.serviceType,
      parsed.data.name,
      parsed.data.phone,
      parsed.data.email || null,
      parsed.data.budgetRange || null,
      parsed.data.message
    );

    const saved = await db.prepare('SELECT * FROM enquiries WHERE phone = ? ORDER BY id DESC LIMIT 1').get(parsed.data.phone);
    await saveEnquiry(saved);

    // Forward the enquiry to the business WhatsApp number. This never throws and
    // never blocks the visitor's success message.
    const settings = await siteSettings();
    const alert = await sendEnquiryAlert(saved, settings);

    const businessNumber = settings.whatsapp || settings.phone;
    return res.json({
      success: true,
      message: 'Your enquiry has been sent. Our team will contact you shortly.',
      whatsappDelivered: Boolean(alert.sent),
      whatsappUrl: whatsappChatUrl(businessNumber, buildVisitorMessage(saved, settings))
    });
  } catch (error) {
    console.error('Enquiry creation error:', error);
    return res.status(500).json({ success: false, error: 'We could not process your enquiry right now. Please try again later.' });
  }
});

app.get('/admin/enquiries/export/csv', requireAdmin, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM enquiries ORDER BY created_at DESC').all();
  const headers = ['id', 'property_id', 'property_name', 'package_name', 'service_type', 'buyer_name', 'phone', 'email', 'budget_range', 'message', 'status', 'admin_notes', 'created_at', 'updated_at'];
  const csvRows = [headers];

  rows.forEach((row) => {
    csvRows.push(headers.map((key) => {
      const value = row[key] ?? '';
      const stringValue = String(value).replace(/\r?\n/g, ' ');
      return stringValue.startsWith('=') || stringValue.startsWith('+') || stringValue.startsWith('-') || stringValue.startsWith('@') ? `'${stringValue}` : stringValue;
    }));
  });

  const csvContent = csvRows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="shivanda-enquiries.csv"');
  res.send(`\uFEFF${csvContent}`);
});

app.get('/admin/enquiries/export/xlsx', requireAdmin, async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Enquiries');
  sheet.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Property', key: 'property_name', width: 28 },
    { header: 'Package', key: 'package_name', width: 20 },
    { header: 'Service', key: 'service_type', width: 18 },
    { header: 'Buyer', key: 'buyer_name', width: 20 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Email', key: 'email', width: 24 },
    { header: 'Budget', key: 'budget_range', width: 16 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Message', key: 'message', width: 42 },
    { header: 'Created', key: 'created_at', width: 18 }
  ];

  const rows = await db.prepare('SELECT * FROM enquiries ORDER BY created_at DESC').all();
  sheet.addRows(rows.map((row) => ({
    ...row,
    property_name: row.property_name || '',
    package_name: row.package_name || '',
    message: String(row.message || '').replace(/\r?\n/g, ' '),
    created_at: row.created_at ? new Date(row.created_at) : ''
  })));

  sheet.getRow(1).font = { bold: true, color: { argb: 'FF14201B' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4A93C' } };
  sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  sheet.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="shivanda-enquiries.xlsx"');
  res.send(buffer);
});

// One-click proof that enquiry alerts reach the business WhatsApp number.
app.post('/admin/whatsapp/test', requireAdmin, csrfProtection, async (req, res) => {
  const settings = await siteSettings();
  const status = getWhatsAppStatus(settings);

  if (!status.provider) {
    req.session.adminNotice = {
      type: 'error',
      text: 'No WhatsApp provider is configured yet, so no alert could be sent. Add CALLMEBOT_APIKEY, WhatsApp Cloud API credentials or Twilio credentials to your environment, then try again.'
    };
    return res.redirect('/admin#enquiries');
  }

  if (!status.configured) {
    req.session.adminNotice = {
      type: 'error',
      text: 'A WhatsApp provider is configured, but there is no number to send to. Save your WhatsApp number under Settings, or set WHATSAPP_TO.'
    };
    return res.redirect('/admin#enquiries');
  }

  const result = await sendEnquiryAlert({
    buyer_name: 'Test alert',
    phone: settings.whatsapp || settings.phone || '',
    service_type: 'Enquiry alerts',
    property_name: 'Website test message',
    message: 'This is a test alert from your website. If you can read this on WhatsApp, every new enquiry will reach you here.',
    created_at: new Date().toISOString()
  }, settings);

  req.session.adminNotice = result.sent
    ? { type: 'success', text: `Test alert sent to ${status.recipient} via ${status.provider}. Check that WhatsApp account.` }
    : { type: 'error', text: `The test alert could not be sent via ${status.provider}: ${result.reason}` };

  return res.redirect('/admin#enquiries');
});

// Download a complete JSON snapshot straight from the admin dashboard. Works
// even where the file system is read-only, because nothing is written.
app.get('/admin/backup.json', requireAdmin, async (req, res) => {
  try {
    const snapshot = await collectSnapshot();
    const filename = `shivanda-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error('Backup export error:', error);
    res.status(500).send('Unable to build the backup right now.');
  }
});

app.get('/sitemap.xml', (req, res) => {
  const urls = [
    '/',
    '/properties',
    '/construction',
    '/contact'
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urls.map((url) => `<url><loc>https://shivanda.in${url}</loc></url>`).join('\n  ')}
</urlset>`;
  res.type('application/xml').send(xml);
});

app.get('/favicon.ico', (req, res) => {
  res.redirect(302, '/images/favicon-32.png');
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: https://shivanda.in/sitemap.xml\n');
});

app.use((req, res) => {
  res.status(404).render('404', { title: 'Page not found' });
});

app.use((error, req, res, next) => {
  const wantsJson = req.path.startsWith('/api/') || Boolean(req.is('application/json'));

  // A missing or stale CSRF token is a client error, not a server fault: it must
  // never surface as a 500 or be silently ignored.
  if (error && (error.code === 'EBADCSRFTOKEN' || error.name === 'ForbiddenError' || error.status === 403)) {
    const message = 'This form expired or was submitted from another site. Please reload the page and try again.';
    if (wantsJson) return res.status(403).json({ success: false, error: message });
    return res.status(403).type('text/plain').send(message);
  }

  // Reject oversized or malformed bodies with the right status code.
  if (error && (error.type === 'entity.too.large' || error.type === 'entity.parse.failed' || error.status === 413)) {
    const status = error.status || 413;
    const message = 'That request was too large or malformed.';
    if (wantsJson) return res.status(status).json({ success: false, error: message });
    return res.status(status).type('text/plain').send(message);
  }

  console.error('Unhandled error:', error);
  res.locals = res.locals || {};
  res.locals.siteSettings = res.locals.siteSettings || {};
  res.locals.csrfToken = res.locals.csrfToken || '';
  res.status(500).render('500', { title: 'Something went wrong' });
});

const server = http.createServer(app);
if (require.main === module) {
  server.listen(port, () => {
    console.log(`Shivanda app running on http://localhost:${port}`);
  });
}

module.exports = { app, server };
