require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const { db, initializeDatabase, readSettings, setSetting } = require('./lib/db');

const runningInFunction = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);
if (runningInFunction) {
  const requiredEnvironment = ['DATABASE_URL', 'CLOUDINARY_URL', 'SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
  const missingEnvironment = requiredEnvironment.filter((key) => !process.env[key]);
  if (missingEnvironment.length) {
    throw new Error(`Missing Netlify environment variables: ${missingEnvironment.join(', ')}`);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = process.env.NETLIFY ? process.cwd() : __dirname;
const uploadsDir = process.env.UPLOADS_DIR || path.join(rootDir, 'public', 'uploads');

if (!process.env.CLOUDINARY_URL) fs.mkdirSync(uploadsDir, { recursive: true });
const dbReady = initializeDatabase();

const siteSettings = () => readSettings();

app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.set('trust proxy', 1);
app.use(cookieSession({
  name: 'shivanda.session',
  keys: [process.env.SESSION_SECRET || 'shivanda-development-secret'],
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

app.use(express.static(path.join(rootDir, 'public'), { maxAge: '30d' }));
if (!process.env.CLOUDINARY_URL) app.use('/uploads', express.static(uploadsDir));

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
  const packagesWithSpecs = await Promise.all(packages.map(async (pkg) => ({
    ...pkg,
    specs: await db.prepare('SELECT * FROM package_specs WHERE package_id = ? ORDER BY sort_order, id').all(pkg.id)
  })));
  const faqs = await db.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all();
  const testimonials = await db.prepare('SELECT * FROM testimonials ORDER BY id DESC').all();
  const gallery = await db.prepare('SELECT * FROM projects_gallery ORDER BY id DESC LIMIT 6').all();

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
  const packagesWithSpecs = await Promise.all(packages.map(async (pkg) => ({
    ...pkg,
    specs: await db.prepare('SELECT * FROM package_specs WHERE package_id = ? ORDER BY sort_order, id').all(pkg.id)
  })));
  const gallery = await db.prepare('SELECT * FROM projects_gallery ORDER BY id DESC LIMIT 6').all();

  res.render('construction', {
    title: 'Construction Packages',
    packages: packagesWithSpecs,
    gallery,
    formatPrice
  });
});

app.get('/contact', (req, res) => {
  res.render('contact', { title: 'Contact Shivanda' });
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

  const recentEnquiries = await db.prepare('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 10').all();
  const packages = await db.prepare('SELECT * FROM packages ORDER BY id').all();
  const packageRows = await Promise.all(packages.map(async (pkg) => ({
    ...pkg,
    specs: await db.prepare('SELECT * FROM package_specs WHERE package_id = ? ORDER BY sort_order, id').all(pkg.id)
  })));
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

  res.render('admin-dashboard', {
    title: 'Shivanda Admin',
    overview,
    properties: propertyList,
    enquiries: recentEnquiries,
    packages: packageRows,
    testimonials,
    faqs,
    gallery,
    settings,
    formatPrice
  });
});

app.post('/admin/properties', requireAdmin, uploadConfig.array('images', 8), csrfProtection, async (req, res) => {
  try {
    const schema = z.object({
      title: z.string().min(3),
      price: z.coerce.number().min(100000),
      type: z.enum(['Apartment', 'Villa', 'Plot', 'Commercial', 'Independent House']),
      status: z.enum(['Available', 'Sold', 'Rented']),
      locality: z.string().min(2),
      address: z.string().min(8),
      description: z.string().min(15),
      bedrooms: z.coerce.number().int().min(0).optional().default(0),
      bathrooms: z.coerce.number().int().min(0).optional().default(0),
      area: z.coerce.number().int().min(200).optional().default(0),
      facing: z.string().optional().default('East'),
      floor: z.string().optional().default('Ground'),
      possession_date: z.string().optional().default(''),
      rera_id: z.string().optional().default(''),
      latitude: z.coerce.number().optional().default(12.9716),
      longitude: z.coerce.number().optional().default(77.5946),
      is_published: z.coerce.number().optional().default(1),
      amenities: z.string().optional().default('')
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Please check the property form for missing or invalid fields.' });
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
  await db.prepare('UPDATE properties SET is_published = ?, updated_at = datetime("now") WHERE id = ?').run(nextValue, property.id);
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

    const schema = z.object({
      title: z.string().min(3),
      price: z.coerce.number().min(100000),
      type: z.enum(['Apartment', 'Villa', 'Plot', 'Commercial', 'Independent House']),
      status: z.enum(['Available', 'Sold', 'Rented']),
      locality: z.string().min(2),
      address: z.string().min(8),
      description: z.string().min(15),
      bedrooms: z.coerce.number().int().min(0).optional().default(0),
      bathrooms: z.coerce.number().int().min(0).optional().default(0),
      area: z.coerce.number().int().min(200).optional().default(0),
      facing: z.string().optional().default('East'),
      floor: z.string().optional().default('Ground'),
      possession_date: z.string().optional().default(''),
      rera_id: z.string().optional().default(''),
      latitude: z.coerce.number().optional().default(12.9716),
      longitude: z.coerce.number().optional().default(77.5946),
      is_published: z.coerce.number().optional().default(property.is_published),
      amenities: z.string().optional().default('')
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid property details.' });
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

  await db.prepare('UPDATE enquiries SET status = ?, updated_at = datetime("now") WHERE id = ?').run(status, req.params.id);
  res.redirect('/admin#enquiries');
});

app.post('/admin/enquiries/:id/delete', requireAdmin, csrfProtection, async (req, res) => {
  await db.prepare('DELETE FROM enquiries WHERE id = ?').run(req.params.id);
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
  await db.prepare('DELETE FROM package_specs WHERE package_id = ?').run(req.params.id);
  const entries = String(req.body.specs || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of entries.entries()) {
    const [label, ...rest] = line.split('|');
    const content = (rest.join('|') || 'Placeholder: add specification details').trim();
    await db.prepare('INSERT INTO package_specs (package_id, label, content, sort_order) VALUES (?, ?, ?, ?)')
      .run(req.params.id, (label || `Spec ${index + 1}`).trim(), content, index);
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
    ['stats_families', req.body.stats_families]
  ];

  await Promise.all(fields.map(([key, value]) => setSetting(key, value || '')));
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
    packageName: z.string().optional(),
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
    const propertyName = property ? property.title : (parsed.data.interestedProperty || 'General enquiry');

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

    return res.json({ success: true, message: 'Your enquiry has been sent successfully. We will contact you shortly.' });
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

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: https://shivanda.in/sitemap.xml\n');
});

app.use((req, res) => {
  res.status(404).render('404', { title: 'Page not found' });
});

app.use((error, req, res, next) => {
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
