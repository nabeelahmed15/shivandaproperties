const { spawn } = require('child_process');
const sharp = require('sharp');

const baseUrl = 'http://localhost:3000';
const cookieJar = new Map();

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

async function waitForServer() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`, { method: 'GET' });
      if (response.ok) return false;
    } catch (error) {
      // Server not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return true;
}

async function main() {
  let server = null;
  const shouldStartServer = await waitForServer();

  if (shouldStartServer) {
    server = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '3000' },
      stdio: 'inherit'
    });
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
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
    if (!ready) throw new Error('Spawned server failed to start within timeout');
  }

  try {
    const home = await request('/');
    assert(home.status === 200, 'Homepage did not respond with 200');
    assert(home.body.includes('Shivanda'), 'Homepage content missing Shivanda branding');
    const csrfToken = parseCsrfToken(home.body);
    assert(csrfToken, 'Homepage did not render a CSRF token');

    const listing = await request('/properties?location=Whitefield&sort=price_low_high');
    assert(listing.status === 200, 'Property listing page failed');
    assert(listing.body.includes('Harbor Park Apartments'), 'Property filter page excludes expected property');

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
        email: 'admin@shivanda.in',
        password: 'Shivanda@123',
        _csrf: adminToken
      })
    });
    assert(loginResponse.status === 200 || loginResponse.status === 302, 'Admin login should succeed after valid credentials');

    const adminPage = await request('/admin');
    assert(adminPage.status === 200, 'Admin dashboard should render after login');
    assert(adminPage.body.includes('Shivanda Admin'), 'Admin dashboard missing title');

    const enquiryRow = adminPage.body.split(/<tr[\s>]/).find((chunk) => chunk.includes(firstPhone));
    assert(enquiryRow, 'Created enquiry should appear in the admin dashboard');
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
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
