require('dotenv').config();

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { normalizePhone, whatsappChatUrl, buildEnquiryMessage } = require('../lib/whatsapp-notify');

// The server under test is always started with its own temporary SQLite
// database, so a local .env pointing at production is never written to.
let baseUrl = '';
const cookieJar = new Map();

// The isolated test database seeds this admin account, so the suite follows the
// configured credentials instead of hard-coding an address that may change.
const adminEmail = process.env.ADMIN_EMAIL || 'admin@shivanda.in';
const adminPassword = process.env.ADMIN_PASSWORD || 'Shivanda@123';

function parseCookies(headers) {
  const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
  if (!setCookies.length && headers.get('set-cookie')) {
    setCookies.push(headers.get('set-cookie'));
  }
  for (const raw of setCookies) {
    const first = raw.split(';')[0];
    if (!first.includes('=')) continue;
    const [name, ...rest] = first.split('=');
    cookieJar.set(name, rest.join('='));
  }
}

function buildCookieHeader() {
  return Array.from(cookieJar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

function parseCsrfToken(html) {
  const match = html.match(/name="csrf-token" content="([^"]+)"/);
  if (match) return match[1];
  const formMatch = html.match(/name="_csrf" value="([^"]+)"/);
  return formMatch ? formMatch[1] : null;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!headers.Cookie && cookieJar.size) {
    headers.Cookie = buildCookieHeader();
  }
  const resp = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    redirect: options.redirect || 'follow',
    body: options.body
  });
  parseCookies(resp.headers);
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, body: text, url: resp.url };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createPngBuffer() {
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 32, g: 122, b: 73, alpha: 1 }
    }
  }).png().toBuffer();
}

function generatePhone() {
  const randomTenDigits = String(6000000000 + Math.floor(Math.random() * 4000000000)).slice(0, 10);
  return `+91${randomTenDigits}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function main() {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shivanda-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      UPLOADS_DIR: path.join(dataDir, 'uploads'),
      BACKUP_DIR: path.join(dataDir, 'backups'),
      // Empty values win over .env (dotenv never overwrites existing keys), so
      // tests use a throwaway SQLite database, keep uploads local and never
      // send real WhatsApps or push test images to Cloudinary.
      DATABASE_URL: '',
      CLOUDINARY_URL: '',
      WHATSAPP_TO: '',
      CALLMEBOT_APIKEY: '',
      CALLMEBOT_PHONE: '',
      WHATSAPP_CLOUD_TOKEN: '',
      WHATSAPP_PHONE_NUMBER_ID: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_WHATSAPP_FROM: ''
    },
    stdio: ['ignore', 'inherit', 'inherit']
  });

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`, { method: 'GET' });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (error) {
      // Server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    server.kill('SIGTERM');
    throw new Error('Spawned server failed to start within timeout');
  }
  assert(fs.existsSync(path.join(dataDir, 'shivanda.db')), 'Test server should use an isolated temporary database');

  try {
    const home = await request('/');
    assert(home.status === 200, 'Homepage did not respond with 200');
    assert(home.body.includes('Shivanda'), 'Homepage content missing Shivanda branding');
    const csrfToken = parseCsrfToken(home.body);
    assert(csrfToken, 'Homepage did not render a CSRF token');

    const listing = await request('/properties?location=Whitefield&sort=price_low_high');
    assert(listing.status === 200, 'Property listing page failed');
    assert(listing.body.includes('Harbor Park Apartments'), 'Property filter page excludes expected property');

    // Turnkey package sheets: rates, accordion sections and spec details.
    const construction = await request('/construction');
    assert(construction.status === 200, 'Construction packages page failed');
    [
      ['Elegance Package', 'Rs 1,999'],
      ['Premium Package', 'Rs 2,149'],
      ['Elite Package', 'Rs 2,299'],
      ['Luxury Package', 'Rs 2,399']
    ].forEach(([name, rate]) => {
      assert(construction.body.includes(name), `Construction page is missing the ${name}`);
      assert(construction.body.includes(rate), `Construction page is missing the ${rate}/sq ft rate`);
    });
    assert(
      (construction.body.match(/class="pkg-group"/g) || []).length === 40,
      'Each of the four packages should show ten expandable specification sections'
    );
    ['Design &amp; Development', 'Kitchen', 'Plumbing &amp; Water', 'Doors &amp; Windows', 'Elevation &amp; Extras'].forEach(
      (section) => {
        assert(construction.body.includes(section), `Package sheets are missing the ${section} section`);
      }
    );
    assert(
      construction.body.includes('Granite up to ₹150/sq ft'),
      'Premium sheet should list its countertop allowance'
    );
    assert(
      construction.body.includes('pkg-item is-excluded'),
      'Specs that are not included should be marked so visitors can tell them apart'
    );
    assert(
      construction.body.includes('id="estimate-list"') && construction.body.includes('data-rate="2149"'),
      'Package page should carry the estimator and expose each rate for it'
    );
    assert(
      home.body.includes('See full Elegance sheet') && home.body.includes('Design &amp; Development</span>'),
      'Homepage package cards should summarise the sheet and link to the full details'
    );

    // Security: headers, authorization, CSRF and request limits.
    const cspHeader = home.headers.get('content-security-policy') || '';
    assert(
      cspHeader.includes('img-src') && cspHeader.includes('https://images.unsplash.com'),
      'Content security policy must allow the hosts serving the property photos'
    );
    assert(cspHeader.includes("default-src 'self'"), 'Homepage should send a content security policy');
    assert(cspHeader.includes("frame-ancestors 'none'"), 'Content security policy should block framing');
    assert(
      (home.headers.get('x-content-type-options') || '').includes('nosniff'),
      'Responses should set X-Content-Type-Options'
    );

    const anonymousAdmin = await request('/admin', { redirect: 'manual' });
    assert(anonymousAdmin.status === 302, 'Admin dashboard must redirect anonymous visitors');
    assert(
      (anonymousAdmin.headers.get('location') || '').includes('/admin/login'),
      'Anonymous admin visit should be sent to the login page'
    );

    const anonymousDelete = await request('/admin/enquiries/1/delete', { method: 'POST', redirect: 'manual' });
    assert(anonymousDelete.status === 302, 'Anonymous admin actions must be redirected, never executed');

    const missingCsrfEnquiry = await request('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'No Token',
        phone: generatePhone(),
        serviceType: 'Buy',
        message: 'Submitted without a CSRF token.'
      }),
      redirect: 'manual'
    });
    assert(
      missingCsrfEnquiry.status === 403,
      `Enquiry without a CSRF token must be rejected with 403 (got ${missingCsrfEnquiry.status})`
    );

    const missingCsrfLogin = await request('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      redirect: 'manual'
    });
    assert(
      missingCsrfLogin.status === 403,
      `Admin login without a CSRF token must be rejected with 403 (got ${missingCsrfLogin.status})`
    );

    const oversizedBody = await request('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        name: 'Oversized',
        phone: generatePhone(),
        serviceType: 'Buy',
        message: 'x'.repeat(1200 * 1024)
      }),
      redirect: 'manual'
    });
    assert(
      oversizedBody.status === 413,
      `Oversized request bodies must be rejected with 413 (got ${oversizedBody.status})`
    );

    const firstPhone = generatePhone();
    const enquiryResponse = await request('/api/enquiry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        name: 'Test Buyer',
        phone: firstPhone,
        email: 'buyer@example.com',
        interestedProperty: 'Sunrise Villas, Bommanahalli',
        serviceType: 'Buy',
        budgetRange: '₹50L - ₹1Cr',
        message: 'Interested in booking a visit for this property.',
        website: '',
        propertyId: 1,
        _csrf: csrfToken
      })
    });
    assert(enquiryResponse.status === 200, 'Enquiry endpoint should accept valid payloads');
    assert(enquiryResponse.body.includes('success'), 'Enquiry success response missing success field');
    const enquiryPayload = JSON.parse(enquiryResponse.body);
    assert(enquiryPayload.whatsappDelivered === false, 'Enquiry should report WhatsApp delivery state');
    assert(
      typeof enquiryPayload.whatsappUrl === 'string' && enquiryPayload.whatsappUrl.startsWith('https://wa.me/'),
      'Enquiry response should include a WhatsApp fallback link'
    );
    assert(
      enquiryPayload.whatsappUrl.includes(encodeURIComponent('Test Buyer')),
      'WhatsApp fallback link should be prefilled with the enquiry details'
    );

    assert(normalizePhone('+91 96860 01144') === '919686001144', 'normalizePhone should keep international numbers');
    assert(normalizePhone('96860 01144') === '919686001144', 'normalizePhone should add the country code');
    assert(normalizePhone('096860 01144') === '919686001144', 'normalizePhone should handle trunk prefixes');
    assert(whatsappChatUrl('').length === 0, 'whatsappChatUrl should be empty without a phone number');
    const sampleAlert = buildEnquiryMessage(
      { buyer_name: 'Asha Rao', phone: '+919686001144', service_type: 'Buy', property_name: 'Sunrise Villas', message: 'Please call me' },
      { company_name: 'Shivanda' }
    );
    assert(sampleAlert.includes('Asha Rao') && sampleAlert.includes('Sunrise Villas'), 'WhatsApp alert should include the enquiry details');

    // A package enquiry from the Construction page must keep the package name.
    const packageMessage = 'Please share the full specification sheet and a site visit slot.';
    const packageResponse = await request('/api/enquiry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        name: 'Package Buyer',
        phone: generatePhone(),
        serviceType: 'Construction',
        packageName: 'Premium',
        message: packageMessage,
        website: '',
        _csrf: csrfToken
      })
    });
    assert(packageResponse.status === 200, 'Package enquiries should be accepted');

    const duplicateResponse = await request('/api/enquiry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        name: 'Repeat Buyer',
        phone: firstPhone,
        email: 'repeat@example.com',
        interestedProperty: 'Sunrise Villas, Bommanahalli',
        serviceType: 'Buy',
        budgetRange: '₹50L - ₹1Cr',
        message: 'This should be rejected as a duplicate enquiry.',
        website: '',
        propertyId: 1,
        _csrf: csrfToken
      })
    });
    assert(duplicateResponse.status === 409, 'Duplicate enquiry should be rejected');

    const invalidResponse = await request('/api/enquiry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        name: 'X',
        phone: '123',
        serviceType: '',
        message: 'short',
        website: '',
        _csrf: csrfToken
      })
    });
    assert(invalidResponse.status === 400, 'Invalid payload should return 400');

    const adminLoginPage = await request('/admin/login');
    const adminToken = parseCsrfToken(adminLoginPage.body);
    assert(adminLoginPage.status === 200, 'Admin login page should render');
    assert(adminToken, 'Admin login page should contain a CSRF token');

    const loginResponse = await request('/admin/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': adminToken
      },
      body: JSON.stringify({
        email: adminEmail,
        password: adminPassword,
        _csrf: adminToken
      })
    });
    assert(loginResponse.status === 200 || loginResponse.status === 302, 'Admin login should succeed after valid credentials');

    const adminPage = await request('/admin');
    assert(adminPage.status === 200, 'Admin dashboard should render after login');
    assert(adminPage.body.includes('Shivanda Admin'), 'Admin dashboard missing title');
    assert(adminPage.body.includes('id="enquiries"'), 'Admin dashboard should render the enquiries section');
    assert(adminPage.body.includes('id="storage"'), 'Admin dashboard should render the data storage section');
    assert(adminPage.body.includes('Write access confirmed'), 'Admin dashboard should confirm database write access');
    assert(adminPage.body.includes('/admin/backup.json'), 'Admin dashboard should offer the JSON backup download');
    assert(adminPage.body.includes('WhatsApp alerts are off'), 'Admin dashboard should report missing WhatsApp alert configuration');

    const enquiryRow = adminPage.body.split(/<tr[\s>]/).find((chunk) => chunk.includes(firstPhone));
    assert(enquiryRow, 'Created enquiry should appear in the admin dashboard');

    const packageRow = adminPage.body.split(/<tr[\s>]/).find((chunk) => chunk.includes(packageMessage));
    assert(packageRow, 'Package enquiries should appear in the admin dashboard');
    assert(packageRow.includes('Premium'), 'The admin dashboard should show which package was enquired about');
    assert(packageRow.includes('Construction'), 'The admin dashboard should record the package enquiry type');

    assert(
      adminPage.body.includes('class="admin-package-editor"') && adminPage.body.includes('name="specs"'),
      'Admin dashboard should let the owner edit each package specification sheet'
    );
    assert(
      adminPage.body.includes('Design &amp; Development | 2D floor plan | Included (2 revisions)'),
      'Package editor should be prefilled with the seeded specification sheet'
    );
    const statusMatch = enquiryRow.match(/enquiries\/(\d+)\/status/);
    assert(statusMatch, 'Enquiry row should include a status form');
    const statusToken = parseCsrfToken(adminPage.body);
    assert(statusToken, 'Admin dashboard should expose a CSRF token for enquiry actions');
    const statusUpdate = await request(`/admin/enquiries/${statusMatch[1]}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `status=Contacted&_csrf=${encodeURIComponent(statusToken)}`
    });
    assert(statusUpdate.status === 200 || statusUpdate.status === 302, 'Enquiry status update should succeed');

    assert(adminPage.body.includes('id="security"'), 'Admin dashboard should render the security section');
    assert(adminPage.body.includes('Session signing secret'), 'Security section should list the session secret check');
    assert(adminPage.body.includes('CSRF protection'), 'Security section should list CSRF protection');
    assert(
      adminPage.body.includes('Interested in booking a visit for this property.'),
      'Enquiry table should show the full visitor message'
    );

    const invalidId = await request('/admin/enquiries/not-a-number/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${encodeURIComponent(statusToken)}`,
      redirect: 'manual'
    });
    assert(invalidId.status === 400, `Non-numeric record ids must be rejected with 400 (got ${invalidId.status})`);

    const updatePriceToken = parseCsrfToken(adminPage.body);
    const packageUpdate = await request('/admin/packages/1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `name=Premium&rate=2199&badge=Most+Chosen&_csrf=${encodeURIComponent(updatePriceToken)}`
    });
    assert(packageUpdate.status === 200 || packageUpdate.status === 302, 'Package price edit should succeed');

    const propertyToken = parseCsrfToken(adminPage.body);
    const uniquePropertyTitle = `Test Hills Villa ${Date.now()}`;
    const png = await createPngBuffer();
    const form = new FormData();
    form.append('_csrf', propertyToken);
    form.append('title', uniquePropertyTitle);
    form.append('price', '8500000');
    form.append('type', 'Villa');
    form.append('status', 'Available');
    form.append('locality', 'Hebbal');
    form.append('address', 'Test address 23, Hebbal, Bengaluru');
    form.append('description', 'A test villa for verification of the admin property creation flow.');
    form.append('bedrooms', '3');
    form.append('bathrooms', '2');
    form.append('area', '1200');
    form.append('facing', 'East');
    form.append('floor', 'Ground');
    form.append('possession_date', '2027-01-01');
    form.append('rera_id', 'RERA-TEST-1');
    form.append('latitude', '13.01');
    form.append('longitude', '77.60');
    form.append('is_published', '1');
    form.append('amenities', 'Parking,Security,Garden');
    form.append('images', new Blob([png], { type: 'image/png' }), 'front.png');
    form.append('images', new Blob([png], { type: 'image/png' }), 'inside.png');

    const propertyCreate = await request('/admin/properties', {
      method: 'POST',
      body: form
    });
    assert(propertyCreate.status === 200 || propertyCreate.status === 302, 'Property create flow should succeed');

    const publishedListing = await request('/properties');
    assert(publishedListing.status === 200, 'Property listing page failed after create');
    assert(publishedListing.body.includes(uniquePropertyTitle), 'Published property should appear on the public listing');

    const adminAfterCreate = await request('/admin');
    assert(adminAfterCreate.status === 200, 'Admin dashboard should render after property create');
    const createdRow = adminAfterCreate.body.split(/<tr[\s>]/).find((chunk) => chunk.includes(uniquePropertyTitle));
    assert(createdRow, 'Created property should appear in the admin table');
    const createdIdMatch = createdRow.match(/properties\/(\d+)\/toggle/);
    assert(createdIdMatch, 'Created property row should include a publish toggle form');
    const createdPropertyId = createdIdMatch[1];
    const toggleToken = parseCsrfToken(adminAfterCreate.body);
    assert(toggleToken, 'Admin dashboard should expose a CSRF token');

    const unpublish = await request(`/admin/properties/${createdPropertyId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${encodeURIComponent(toggleToken)}`
    });
    assert(unpublish.status === 200 || unpublish.status === 302, 'Publish toggle should succeed');
    const hiddenListing = await request('/properties');
    assert(!hiddenListing.body.includes(uniquePropertyTitle), 'Unpublished property should disappear from the public listing');

    const republish = await request(`/admin/properties/${createdPropertyId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${encodeURIComponent(toggleToken)}`
    });
    assert(republish.status === 200 || republish.status === 302, 'Republish toggle should succeed');
    const relistedListing = await request('/properties');
    assert(relistedListing.body.includes(uniquePropertyTitle), 'Republished property should reappear on the public listing');

    const csvResponse = await request('/admin/enquiries/export/csv');
    assert(csvResponse.status === 200, 'CSV export endpoint should respond');
    assert(csvResponse.body.includes('property_name'), 'CSV export missing headers');

    const xlsxResponse = await request('/admin/enquiries/export/xlsx');
    assert(xlsxResponse.status === 200, 'XLSX export endpoint should respond');
    assert(xlsxResponse.headers.get('content-type').includes('spreadsheetml'), 'XLSX export should return spreadsheet content type');

    const backupResponse = await request('/admin/backup.json');
    assert(backupResponse.status === 200, 'Backup download should respond');
    assert(backupResponse.headers.get('content-type').includes('json'), 'Backup download should be JSON');
    assert(
      (backupResponse.headers.get('content-disposition') || '').includes('attachment'),
      'Backup download should be sent as an attachment'
    );
    const backupSnapshot = JSON.parse(backupResponse.body);
    assert(backupSnapshot.tables && backupSnapshot.tables.enquiries, 'Backup should include the enquiries table');
    assert(
      backupSnapshot.tables.enquiries.some((row) => row.phone === firstPhone),
      'Backup should contain the enquiry created during the test run'
    );
    assert(backupSnapshot.counts.properties >= 1, 'Backup should count stored properties');

    const deleteProperty = await request(`/admin/properties/${createdPropertyId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${encodeURIComponent(toggleToken)}`
    });
    assert(deleteProperty.status === 200 || deleteProperty.status === 302, 'Property delete flow should succeed');
    const afterDeleteListing = await request('/properties');
    assert(!afterDeleteListing.body.includes(uniquePropertyTitle), 'Deleted property should disappear from the public listing');

    console.log('Verification checks passed');
  } finally {
    if (server) server.kill('SIGTERM');

    // Windows keeps the SQLite file locked for a moment after the process exits,
    // so retry briefly instead of leaving temp folders behind.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
