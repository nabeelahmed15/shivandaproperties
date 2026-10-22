# Shivanda Properties & Construction

A full-stack real estate and construction website for Shivanda, built with Express, SQLite, EJS templates and server-side validation.

## Local setup

1. Install dependencies:
   npm install
2. Copy environment values:
   cp .env.example .env
3. Generate website image assets:
   npm run prepare-assets
4. Seed the SQLite database and create the default admin user:
   npm run seed
5. Start the app:
   npm start

Then open http://localhost:3000.

## Environment variables

- PORT: server port (default 3000)
- NODE_ENV: development or production
- SESSION_SECRET: random secure string
- ADMIN_EMAIL: first admin email
- ADMIN_PASSWORD: first admin password
- GOOGLE_MAPS_API_KEY: optional Google Maps key for the property detail map
- WHATSAPP_TO: optional override for the number that receives enquiry alerts (defaults to the WhatsApp number in Admin > Settings)
- CALLMEBOT_APIKEY / CALLMEBOT_PHONE, WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID, or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM: pick one provider to receive every enquiry on WhatsApp (see below)

## Where your data is stored

Records live in **one** database, chosen by the `DATABASE_URL` environment variable:

| `DATABASE_URL` | Storage | Keeps data? |
| --- | --- | --- |
| set (for example a free Supabase Postgres project) | Hosted PostgreSQL | Yes - permanent and shared by every device and the live site |
| not set, run locally | `data/shivanda.db` file on this computer | Yes, but only on this computer - the live site cannot see it |
| not set, running inside the Netlify function | SQLite in the sandbox, mirrored to Netlify Blobs | **Yes** - every write is copied to Netlify Blobs and restored after a cold start, redeploy or new deploy |

The hosted site therefore keeps its data without any hosting configuration. Adding `DATABASE_URL` later upgrades it to PostgreSQL; the app switches automatically on the next deploy.

Check which one is active at any time:

```
npm run db:check
```

It prints the storage engine and host, the row count for every table, and whether the app still has write access. It exits with code 1 when storage is temporary, a table is missing or writes are refused, so it can be used in a deploy step. `npm run db:check` is read-only: it never creates a schema, an admin user or any other row.

The admin dashboard shows the same information under **Where your data is stored**, and shows a red warning when records are not being kept permanently.

### Keeping a free Supabase database alive

1. Keep `DATABASE_URL` set in every environment that runs the site (locally in `.env`, and in Netlify under Site configuration > Environment variables). Never commit it.
2. Supabase pauses free projects after about a week without activity, which looks like lost data. Open the Supabase dashboard and restore the project, then run `npm run db:check` to confirm it is reachable again.
3. Export a copy from the admin dashboard (Export CSV / Export Excel) whenever you want an offline snapshot of the enquiries.

## WhatsApp enquiry alerts

Every enquiry is saved in the dashboard **and** sent to your WhatsApp automatically.

**Turn it on from the website itself (recommended):** sign in at `/admin`, open **Settings > WhatsApp alerts**, paste your CallMeBot key and the number that should receive alerts, then press **Save settings**. No hosting or `.env` access is needed, and the settings survive redeploys.

To get the free key: save **+34 644 51 95 23** as a contact, send it `I allow callmebot to send me messages` on WhatsApp, and paste the key it replies with. The bot occasionally stops accepting new numbers; try again later if it does not reply.

The provider can also be configured through environment variables instead; the dashboard values win when both are present:

1. **CallMeBot** (fastest, free, personal use): `CALLMEBOT_APIKEY` and optionally `CALLMEBOT_PHONE`. The bot occasionally stops accepting new numbers; try again later if it does not reply.
2. **Meta WhatsApp Cloud API** (official): create a Meta app with the WhatsApp product, then set `WHATSAPP_CLOUD_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`. Free-form text is only allowed within 24 hours of the owner's last message to your business number; outside that window set `WHATSAPP_TEMPLATE_NAME` (and `WHATSAPP_TEMPLATE_LANG`) to an approved template with a single body variable.
3. **Twilio WhatsApp**: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_WHATSAPP_FROM` (for example `+14155238886` for the sandbox); the owner joins the sandbox once from their phone.

The recipient is the number saved under **Settings > WhatsApp alerts** (falling back to the site's WhatsApp number), unless `WHATSAPP_TO` is set. The dashboard shows whether alerts are on, and every enquiry phone number links straight to a WhatsApp chat. When no provider is configured, the enquiry form still shows the visitor a one-tap **Send this enquiry on WhatsApp as well** link so the message reaches you either way. Notification failures are logged on the server and never block or fail the visitor's enquiry.

### Confirming the setup

```
npm run whatsapp:test
```

Sends one test alert and prints the provider, the recipient and the result. It exits with code 1 and lists the setup steps when nothing is configured. The admin dashboard has the same thing as a **Send a test WhatsApp alert** button under Enquiries, which reports the outcome as a notice.

## Security

Run the checks at any time:

```
npm run security:check
```

It exits non-zero when something real needs fixing. The admin dashboard shows the same list under **Security**, with a red banner naming anything outstanding. What is protected:

- **Admin login**: bcrypt password hashing, 8 attempts per 15 minutes per IP, HTTPS-only `httpOnly` session cookies, and a redirect to the login page for every admin route when signed out.
- **Cross-site request forgery**: every form and API POST needs a per-session CSRF token. A missing or stale token returns 403, never a silent success or a 500.
- **Injection**: all database access uses bound parameters; record ids must be numeric before they reach a query; enquiry statuses are restricted to the four allowed values.
- **Headers**: a content security policy (no framing, no external scripts, restricted form targets), `X-Content-Type-Options: nosniff`, HSTS and a strict referrer policy.
- **Abuse limits**: request bodies are capped at 1 MB, enquiries at 20 per 15 minutes per IP, login attempts at 8 per 15 minutes.
- **Uploads**: image types only, 8 files of 8 MB maximum, re-encoded to WebP before being stored.

Two settings are yours to change and are reported as failures until you do:

1. **`SESSION_SECRET`** - use at least 32 random characters. Without it the app generates a random secret at start-up, so admin logins reset on every restart (never a shared default).
2. **The admin password** - change it from the default under **Settings > Change password**. The dashboard keeps warning until no admin account uses a known default.

`ADMIN_EMAIL` and `ADMIN_PASSWORD` only seed the first admin account. Once the account exists, a password changed in the dashboard is never overwritten by the built-in default; set a non-empty `ADMIN_PASSWORD` only when you deliberately want to reset it.

## Admin login

Use the values from ADMIN_EMAIL and ADMIN_PASSWORD to sign in at /admin/login.

## Dashboard usage

- Properties: add, toggle publish state, delete, and upload images
- Enquiries: review, update status, remove items and export to CSV or Excel
- Packages: edit rates, badges and the full specification sheet that visitors expand on the Construction page (one line per spec, written as `Section | Item | Detail`)
- Testimonials / FAQ / gallery: add content blocks
- Settings: edit contact fields, company info and stats

## Exporting enquiries

From the admin dashboard, use the Export CSV and Export Excel buttons. CSV files are BOM-prefixed for Excel compatibility and dangerous formula prefixes are escaped with an apostrophe.

When the site runs on Netlify without `DATABASE_URL`, every enquiry is also archived to Netlify Blobs and restored into the database on cold starts and after deploys, so submissions are never lost; admin status changes and deletions are mirrored to the archive. With `DATABASE_URL` configured, the persistent database is the single source of truth and blob archiving stays off. Download an Excel or CSV copy of all enquiries from the admin dashboard at any time.

## Google Maps API key

1. Open Google Cloud Console.
2. Create a project and enable Maps JavaScript API.
3. Create an API key and restrict it to your domain.
4. Set GOOGLE_MAPS_API_KEY in .env.

## Deployment notes

### Netlify, Supabase and Cloudinary

Netlify runs the Express app as a function. Supabase stores app records and Cloudinary stores uploaded images; SQLite and local uploads remain the local-development defaults.

1. Create free accounts/projects in Supabase and Cloudinary. In Supabase, use the **Session pooler** connection string for `DATABASE_URL`.
2. Create a new GitHub repository for this project and push only these project files. Do not use the unrelated Desktop repository as the deployment source.
3. Connect that repository in Netlify. The included `netlify.toml` builds generated image assets and routes application requests through the Netlify function.
4. Add these Netlify environment variables: `DATABASE_URL`, `CLOUDINARY_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `SESSION_SECRET`. Set `NODE_ENV=production`; generate a unique session secret and admin password. Keep credentials in the Netlify dashboard, never in Git. `DATABASE_URL` is the one that decides whether records are kept - without it the deployed site stores everything in a temporary sandbox that is wiped on every cold start.
5. Before opening the deployed site to visitors, put `DATABASE_URL` and `CLOUDINARY_URL` in your ignored local `.env` file and run the migration from this project folder:

   ```powershell
   npm run migrate:cloud
   ```

   It copies all SQLite tables and uploads local property/gallery images to Cloudinary. It updates matching IDs, so it can be rerun if a deployment initialized default records first.

The free-tier limits and availability of Netlify, Supabase and Cloudinary can change. Back up the Supabase database and review each provider's current limits before launch.

### VPS with nginx + PM2 + HTTPS

1. Install Node.js, nginx and certbot.
2. Install PM2 globally: npm install -g pm2
3. Set up a reverse proxy in nginx to localhost:3000.
4. Configure HTTPS with Let's Encrypt.
5. Start the app with PM2: pm2 start server.js --name shivanda
6. Create a cron job for certificate renewal.

### Database backup advice

- Schedule daily SQLite backups from the data directory with `cp` or `sqlite3 .backup`.
- Keep backups off the same disk as the app database.
- Store encrypted snapshots in a cloud backup service.

## Backups

`DATABASE_URL` (the hosted database) is the primary store, so nothing needs to be copied anywhere. As a second copy, the app also writes a JSON snapshot of every table to the local `backups/` folder:

- automatically, once a day, while the site is running locally (the last 14 daily snapshots are kept);
- on demand with `npm run db:backup`;
- or any time from **Download JSON backup** on the admin dashboard, which works even where the file system is read-only.

Snapshots contain customer names and phone numbers, so `backups/` is listed in `.gitignore` and must never be committed or pushed - the GitHub repository is public. The project folder sits inside OneDrive, so these files are already copied off the machine by OneDrive; no extra account or payment is needed.

## NPM scripts

- npm start: start the production server
- npm run dev: watch mode
- npm run seed: initialize the seeded database
- npm run prepare-assets: generate logo and image assets
- npm test: run the end-to-end verification script against a throwaway local database (it never touches `DATABASE_URL`)
- npm run db:check: report where records are stored and fail when storage is not permanent
- npm run db:backup: write a JSON snapshot of every table to `backups/`
- npm run packages:sync: push the package rates and specification sheets from `lib/package-specs.js` into the active database (safe to repeat; also hides duplicate package rows)
- npm run whatsapp:test: send a test WhatsApp alert and report the result
- npm run security:check: report the security configuration and fail on anything outstanding

## Notes

- Static assets are served with caching and the public site uses responsive images.
- Sensitive errors are logged on the server and not exposed to users.
