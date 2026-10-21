// Sends one test alert through the configured WhatsApp provider and reports
// exactly what happened, so setup can be confirmed without waiting for a real
// visitor enquiry.
//
//   npm run whatsapp:test

require('dotenv').config();

const { getWhatsAppStatus, sendEnquiryAlert } = require('../lib/whatsapp-notify');
const { readSettings, db } = require('../lib/db');

const SETUP_HELP = `
No WhatsApp provider is configured, so no alert could be sent.

Pick one of these and add it to .env (or the hosting environment), then run
"npm run whatsapp:test" again:

  1. CallMeBot (free, no signup - recommended)
     On the phone that should receive alerts, save the bot number listed at
     https://www.callmebot.com/blog/free-api-whatsapp-messages/ as a contact,
     send it this message: I allow callmebot to send me messages
     It replies with a key. Put that key in .env:
       CALLMEBOT_APIKEY=<the key it sent you>

  2. WhatsApp Cloud API
       WHATSAPP_CLOUD_TOKEN=<token>  WHATSAPP_PHONE_NUMBER_ID=<id>

  3. Twilio WhatsApp
       TWILIO_ACCOUNT_SID=<sid>  TWILIO_AUTH_TOKEN=<token>  TWILIO_WHATSAPP_FROM=+14155238886

The alert is sent to the WhatsApp number saved in Admin > Settings unless
WHATSAPP_TO is set.
`;

async function main() {
  const settings = await readSettings();
  const status = getWhatsAppStatus(settings);

  console.log('');
  console.log(`Provider:   ${status.provider || 'none configured'}`);
  console.log(`Recipient:  ${status.recipient || 'not set'}`);
  console.log('');

  if (!status.provider) {
    console.error(SETUP_HELP);
    process.exitCode = 1;
    return;
  }

  if (!status.configured) {
    console.error('A provider is configured but there is no number to send to.');
    console.error('Save your WhatsApp number under Settings in the admin dashboard, or set WHATSAPP_TO.');
    process.exitCode = 1;
    return;
  }

  const result = await sendEnquiryAlert({
    buyer_name: 'Test alert',
    phone: settings.whatsapp || settings.phone || '',
    service_type: 'Enquiry alerts',
    property_name: 'Website test message',
    message: 'This is a test alert from your website. If you can read this on WhatsApp, every new enquiry will reach you here.',
    created_at: new Date().toISOString()
  }, settings);

  if (result.sent) {
    console.log(`PASS: test alert sent to ${status.recipient} via ${status.provider}.`);
    console.log('Check that WhatsApp account - new enquiries will arrive there automatically.');
    return;
  }

  console.error(`FAIL: ${status.provider} could not send the alert.`);
  console.error(`Reason: ${result.reason}`);
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('WhatsApp test failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db && db.pool && typeof db.pool.end === 'function') {
      await db.pool.end().catch(() => {});
    }
  });
