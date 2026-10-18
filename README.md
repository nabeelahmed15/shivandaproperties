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

## Admin login

Use the values from ADMIN_EMAIL and ADMIN_PASSWORD to sign in at /admin/login.

## Dashboard usage

- Properties: add, toggle publish state, delete, and upload images
- Enquiries: review, update status, remove items and export to CSV or Excel
- Packages: edit rates, badges and specs
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
4. Add these Netlify environment variables: `DATABASE_URL`, `CLOUDINARY_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `SESSION_SECRET`. Set `NODE_ENV=production`; generate a unique session secret and admin password. Keep credentials in the Netlify dashboard, never in Git.
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

## NPM scripts

- npm start: start the production server
- npm run dev: watch mode
- npm run seed: initialize the seeded database
- npm run prepare-assets: generate logo and image assets
- npm test: run the end-to-end verification script

## Notes

- Static assets are served with caching and the public site uses responsive images.
- Sensitive errors are logged on the server and not exposed to users.
