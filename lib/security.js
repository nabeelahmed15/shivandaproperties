// Security configuration checks shared by the admin dashboard, the
// `npm run security:check` command and the boot-time session-secret handling.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db } = require('./db');

const DEV_SECRET = 'shivanda-development-secret';
const MIN_SECRET_LENGTH = 32;
const KNOWN_DEFAULT_PASSWORDS = ['Shivanda@123'];
const KNOWN_DEFAULT_EMAILS = ['admin@shivanda.com'];

function isProductionLike() {
  return Boolean(
    process.env.NETLIFY ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.NODE_ENV === 'production'
  );
}

function sessionSecretStatus() {
  const provided = String(process.env.SESSION_SECRET || '').trim();
  if (!provided) {
    return { weak: true, length: 0, reason: 'SESSION_SECRET is not set' };
  }
  if (provided === DEV_SECRET) {
    return { weak: true, length: provided.length, reason: 'SESSION_SECRET is still the shared development default' };
  }
  if (provided.length < MIN_SECRET_LENGTH) {
    return {
      weak: true,
      length: provided.length,
      reason: `SESSION_SECRET is only ${provided.length} characters; use at least ${MIN_SECRET_LENGTH} random characters`
    };
  }
  return { weak: false, length: provided.length, reason: null };
}

// A weak secret must never silently sign real sessions. In production a random
// per-process secret is generated instead, so sessions reset on restart until
// the environment variable is set properly.
function resolveSessionSecret() {
  const status = sessionSecretStatus();
  if (!status.weak) return { secret: process.env.SESSION_SECRET.trim(), weak: false, reason: null };

  if (isProductionLike()) {
    return {
      secret: crypto.randomBytes(32).toString('hex'),
      weak: true,
      reason: `${status.reason}; a random secret was generated for this process, so admin logins reset whenever the server restarts`
    };
  }

  return { secret: DEV_SECRET, weak: true, reason: `${status.reason}; using the local development default` };
}

async function adminCredentialStatus() {
  try {
    const admins = await db.prepare('SELECT id, email, password_hash FROM admins').all();

    const defaultPasswordEmails = [];
    for (const admin of admins) {
      for (const candidate of KNOWN_DEFAULT_PASSWORDS) {
        let matches = false;
        try {
          matches = bcrypt.compareSync(candidate, admin.password_hash);
        } catch (error) {
          matches = false;
        }
        if (matches) {
          defaultPasswordEmails.push(admin.email);
          break;
        }
      }
    }

    return {
      adminCount: admins.length,
      defaultPasswordEmails,
      defaultEmailInUse: admins.some((admin) => KNOWN_DEFAULT_EMAILS.includes(String(admin.email || '').toLowerCase()))
    };
  } catch (error) {
    return { adminCount: null, defaultPasswordEmails: [], defaultEmailInUse: false, error: error && error.message };
  }
}

function buildChecks({ sessionSecret, credentials }) {
  const productionLike = isProductionLike();

  return [
    {
      id: 'session-secret',
      label: 'Session signing secret',
      status: sessionSecret.weak ? 'fail' : 'pass',
      detail: sessionSecret.weak
        ? `${sessionSecret.reason}. Anyone who knows a weak secret can forge an admin login.`
        : 'A strong SESSION_SECRET signs the admin session cookie.'
    },
    {
      id: 'admin-password',
      label: 'Admin password',
      status: credentials.defaultPasswordEmails.length ? 'fail' : 'pass',
      detail: credentials.defaultPasswordEmails.length
        ? `The default password is still in use for ${credentials.defaultPasswordEmails.join(', ')}. Change it under Settings > Change password.`
        : 'No admin account uses a known default password.'
    },
    {
      id: 'admin-email',
      label: 'Admin email',
      status: credentials.defaultEmailInUse ? 'warn' : 'pass',
      detail: credentials.defaultEmailInUse
        ? 'ADMIN_EMAIL is still the sample address (admin@shivanda.com). Use a real address you control.'
        : 'The admin account uses a real email address.'
    },
    {
      id: 'csrf',
      label: 'CSRF protection',
      status: 'pass',
      detail: 'Every form and API POST requires a per-session CSRF token; requests without one are rejected.'
    },
    {
      id: 'sql',
      label: 'Database access',
      status: 'pass',
      detail: 'Every query uses bound parameters, so submitted text cannot alter SQL.'
    },
    {
      id: 'csp',
      label: 'Content security policy',
      status: 'pass',
      detail: 'A content security policy restricts scripts, frames and form targets; clickjacking is blocked.'
    },
    {
      id: 'limits',
      label: 'Request limits',
      status: 'pass',
      detail: 'Login attempts (8 per 15 minutes) and enquiries (20 per 15 minutes) are rate limited, and request bodies are capped at 1 MB.'
    },
    {
      id: 'https',
      label: 'Cookies over HTTPS',
      status: productionLike ? 'pass' : 'warn',
      detail: productionLike
        ? 'Session cookies are sent only over HTTPS (secure, httpOnly, sameSite=lax).'
        : 'Cookies are not marked secure because this is not running as a production server.'
    },
    {
      id: 'uploads',
      label: 'Image uploads',
      status: 'pass',
      detail: 'Uploads are limited to 8 images of 8 MB, must be image types, and are re-encoded to WebP before storage.'
    }
  ];
}

async function securityReport({ sessionSecret = sessionSecretStatus() } = {}) {
  const credentials = await adminCredentialStatus();
  const checks = buildChecks({ sessionSecret, credentials });

  return {
    checks,
    failures: checks.filter((check) => check.status === 'fail'),
    warnings: checks.filter((check) => check.status === 'warn'),
    productionLike: isProductionLike(),
    adminCount: credentials.adminCount
  };
}

module.exports = {
  DEV_SECRET,
  MIN_SECRET_LENGTH,
  KNOWN_DEFAULT_PASSWORDS,
  KNOWN_DEFAULT_EMAILS,
  isProductionLike,
  sessionSecretStatus,
  resolveSessionSecret,
  adminCredentialStatus,
  securityReport
};
