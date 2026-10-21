// Sends a WhatsApp message to the business whenever a new enquiry is submitted.
//
// Nothing here may ever break an enquiry: every failure is caught and returned
// as data so the caller can log it while the visitor still gets a success reply.
//
// Supported providers (first configured one wins):
//   1. CallMeBot  -> CALLMEBOT_APIKEY (+ optional CALLMEBOT_PHONE)
//   2. WhatsApp Cloud API -> WHATSAPP_CLOUD_TOKEN + WHATSAPP_PHONE_NUMBER_ID
//   3. Twilio     -> TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM
//
// WHATSAPP_TO overrides the recipient; otherwise the WhatsApp number saved in
// the admin settings (falling back to the phone number) is used.

const REQUEST_TIMEOUT_MS = 8000;
const CLOUD_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v22.0';

function digitsOf(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
}

// Returns the number in international form without a plus, e.g. 919686001144.
function normalizePhone(value, countryCode = process.env.WHATSAPP_COUNTRY_CODE || '91') {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';

  const cc = digitsOf(countryCode) || '91';
  const international = raw.startsWith('+') || raw.startsWith('00');
  let digits = digitsOf(raw);

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return '';
  if (international) return digits;
  if (digits.length === 10) return `${cc}${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `${cc}${digits.slice(1)}`;
  return digits;
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return '';
  if (digits.length <= 6) return digits;
  return `+${digits.slice(0, 2)} ••••• ${digits.slice(-5)}`;
}

function formatReceived(value) {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  try {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata'
    }).format(safe);
  } catch (error) {
    return safe.toISOString();
  }
}

function buildEnquiryMessage(enquiry = {}, settings = {}) {
  const company = settings.company_name || 'Shivanda';
  const lines = [
    `🏡 *New website enquiry*`,
    '',
    `*Name:* ${enquiry.buyer_name || 'Not given'}`,
    `*Phone:* ${enquiry.phone || 'Not given'}`
  ];

  if (enquiry.email) lines.push(`*Email:* ${enquiry.email}`);
  if (enquiry.service_type) lines.push(`*Looking for:* ${enquiry.service_type}`);
  if (enquiry.property_name) lines.push(`*Property:* ${enquiry.property_name}`);
  if (enquiry.package_name) lines.push(`*Package:* ${enquiry.package_name}`);
  if (enquiry.budget_range) lines.push(`*Budget:* ${enquiry.budget_range}`);
  if (enquiry.message) lines.push('', enquiry.message);
  lines.push('', `Received ${formatReceived(enquiry.created_at)} • ${company}`);

  return lines.join('\n');
}

function buildVisitorMessage(enquiry = {}, settings = {}) {
  const company = settings.company_name || 'Shivanda';
  const lines = [
    `Hi ${company}, I just sent an enquiry through your website.`,
    '',
    `Name: ${enquiry.buyer_name || ''}`,
    `Phone: ${enquiry.phone || ''}`
  ];
  if (enquiry.service_type) lines.push(`Looking for: ${enquiry.service_type}`);
  if (enquiry.property_name) lines.push(`Property: ${enquiry.property_name}`);
  if (enquiry.budget_range) lines.push(`Budget: ${enquiry.budget_range}`);
  if (enquiry.message) lines.push('', enquiry.message);
  return lines.join('\n');
}

// Click-to-chat link from the visitor to the business number.
function whatsappChatUrl(phone, text) {
  const to = normalizePhone(phone);
  if (!to) return '';
  const base = `https://wa.me/${to}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function call(url, options = {}) {
  const timeout = withTimeout();
  try {
    return await fetch(url, { ...options, signal: timeout.signal });
  } finally {
    timeout.done();
  }
}

async function failureMessage(response, fallback) {
  const body = await response.text().catch(() => '');
  if (!body) return `${fallback} (${response.status})`;
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail = parsed.message || (parsed.error && (parsed.error.message || parsed.error)) || body;
  } catch (error) {
    // Plain text response.
  }
  return `${fallback}: ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}`;
}

async function sendViaCallMeBot(to, message) {
  const url = new URL('https://api.callmebot.com/whatsapp.php');
  url.searchParams.set('phone', `+${to}`);
  url.searchParams.set('text', message);
  url.searchParams.set('apikey', process.env.CALLMEBOT_APIKEY);

  const response = await call(url.toString());
  const body = await response.text().catch(() => '');
  if (!response.ok || !/queued|sent|success/i.test(body)) {
    throw new Error(`CallMeBot rejected the message: ${String(body).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

async function sendViaCloud(to, message) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const payload = process.env.WHATSAPP_TEMPLATE_NAME
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: process.env.WHATSAPP_TEMPLATE_NAME,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: message }] }]
        }
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: message }
      };

  const response = await call(
    `https://graph.facebook.com/${CLOUD_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) throw new Error(await failureMessage(response, 'WhatsApp Cloud API rejected the message'));
}

async function sendViaTwilio(to, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const rawFrom = String(process.env.TWILIO_WHATSAPP_FROM || '').trim();
  const from = `whatsapp:${rawFrom.startsWith('whatsapp:') ? rawFrom.slice('whatsapp:'.length) : rawFrom}`;
  const body = new URLSearchParams({
    To: `whatsapp:+${to}`,
    From: from,
    Body: message
  });

  const response = await call(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) throw new Error(await failureMessage(response, 'Twilio rejected the message'));
}

function activeProvider() {
  if (process.env.CALLMEBOT_APIKEY) {
    return { name: 'callmebot', label: 'CallMeBot', send: sendViaCallMeBot };
  }
  if (process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    return { name: 'cloud', label: 'WhatsApp Cloud API', send: sendViaCloud };
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM) {
    return { name: 'twilio', label: 'Twilio WhatsApp', send: sendViaTwilio };
  }
  return null;
}

function resolveRecipient(settings = {}, provider = activeProvider()) {
  const preferred = process.env.WHATSAPP_TO
    || (provider && provider.name === 'callmebot' ? process.env.CALLMEBOT_PHONE : '')
    || settings.whatsapp
    || settings.phone;
  return normalizePhone(preferred);
}

function getWhatsAppStatus(settings = {}) {
  const provider = activeProvider();
  // Report the number we would send to even before a provider is configured, so
  // setup output can show what is missing.
  const recipient = resolveRecipient(settings, provider);
  return {
    configured: Boolean(provider && recipient),
    provider: provider ? provider.label : null,
    label: provider
      ? (recipient ? `On — via ${provider.label}` : 'Needs a WhatsApp number')
      : 'Not connected',
    recipient: maskPhone(recipient)
  };
}

async function sendEnquiryAlert(enquiry, settings = {}) {
  const provider = activeProvider();
  if (!provider) return { sent: false, provider: null, reason: 'not-configured' };

  const recipient = resolveRecipient(settings, provider);
  if (!recipient) return { sent: false, provider: provider.name, reason: 'no-recipient' };

  try {
    await provider.send(recipient, buildEnquiryMessage(enquiry, settings));
    console.log(`[shivanda] WhatsApp enquiry alert sent via ${provider.label}.`);
    return { sent: true, provider: provider.name };
  } catch (error) {
    const reason = error && error.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : (error && error.message) || 'unknown error';
    console.error(`[shivanda] WhatsApp enquiry alert failed via ${provider.label}: ${reason}`);
    return { sent: false, provider: provider.name, reason };
  }
}

module.exports = {
  normalizePhone,
  maskPhone,
  buildEnquiryMessage,
  buildVisitorMessage,
  whatsappChatUrl,
  getWhatsAppStatus,
  sendEnquiryAlert
};
