# Kaban: personal finance journal

A monthly budgeting app with income, necessities, extra expenses, a play jar, savings goals, debts and loans, a financial calendar and an annual view. Each person signs up for their own private account, and their budget syncs across devices.

- **Frontend:** plain HTML/CSS/JS with no build step, hosted free on GitHub Pages.
- **Accounts and storage:** [Supabase](https://supabase.com) (free tier) for email/password sign-in and a Postgres database. Row Level Security limits each user to their own data.
- **No-account mode:** visitors can choose "Try it without an account". Their data then stays in their own browser. If they sign up later, they're offered the option to copy that data into their new account.

```
index.html            page shell
css/styles.css        all styles
js/config.js          ← your settings (app name, Supabase URL + key)
js/app.js             the budgeting app
js/cloud.js           sign-in, saving, and sync
vendor/chart.umd.min.js  Chart.js 4.4.4
supabase/schema.sql   database table + security rules (run once)
```

---

## 1. Set up Supabase (about 10 minutes)

1. Create a free account at https://supabase.com, then create a **New project**. Pick the region closest to your users, such as Singapore for the Philippines.
2. Open **SQL Editor → New query**, paste in all of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. Go to **Authentication → URL Configuration**:
   - **Site URL:** your live address, e.g. `https://YOUR-GITHUB-USERNAME.github.io/kaban/`
   - **Redirect URLs:** add that same address. To test locally, also add `http://localhost:8642/`.
4. Go to **Authentication → Sign In / Providers → Email**:
   - Keep **Confirm email** turned on.
   - Set the **minimum password length** to 8.
5. **Email sending (required before going public).** Supabase's built-in email service only delivers to your own team's addresses and has a very low hourly limit. Members of the public won't receive confirmation or password-reset emails until you connect a real email provider. Set this up in **Authentication → Emails → SMTP Settings**. Resend, Brevo and Postmark all have free tiers.
6. Go to **Project Settings → API** (or click **Connect**) and copy:
   - the **Project URL**
   - the **anon / publishable** key. Never use the `service_role` / secret key in this app.
7. Paste both into [`js/config.js`](js/config.js).

The anon key is designed to be public. It's visible to anyone who loads the site, and that's expected. What keeps each person's data private is the Row Level Security in `schema.sql`.

## 2. Publish on GitHub Pages

1. Create a new **public** repository on GitHub, e.g. `kaban`. GitHub Pages is free for public repositories.
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/YOUR-GITHUB-USERNAME/kaban.git
   ```
   ```bash
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, then **main**, then **/ (root)**, and click **Save**.
4. After a minute the site is live at `https://YOUR-GITHUB-USERNAME.github.io/kaban/`. Make sure this matches the Site URL you set in Supabase.

To update the site later, commit and push. GitHub Pages redeploys automatically.

**Custom domain (optional):** add it under **Settings → Pages → Custom domain**. Then update the Supabase Site URL and Redirect URLs to the new domain.

## 3. Move your existing data over

Your current data lives inside the old `C Financial Tracker.html` file's browser storage. To bring it over:

1. Open the old file and go to **Settings → Export data (.json)**.
2. Sign in to the new site and go to **Settings → Import data (.json)**.

The import converts the old fixed "Me" and "Chad" setup into editable people. Their pay schedules are kept, and all amounts stay in Philippine pesos.

## Test locally

Serve the folder with any static server instead of opening the file directly, e.g.:

```bash
npx serve -l 8642 .
```

Then open http://localhost:8642. If `js/config.js` has no Supabase details, the app runs in local-only mode, which is handy for trying changes.

## Before you share it widely

- **Privacy:** as the owner of the Supabase project, you can see every user's budget in the database. Tell users this plainly in a short privacy notice. The sign-in screen text is in `js/cloud.js` (search for `auth-foot`).
- **Free-tier limits:** Supabase pauses free projects after 7 days without activity, and the free tier has no point-in-time backups. A paused project means nobody can sign in until you un-pause it from the dashboard. For a site real people depend on, consider the Pro plan or regular backups.
- **Abuse protection:** consider turning on CAPTCHA (Authentication → Attack Protection) and leaked-password protection.
- **Renaming the app:** change `appName` in `js/config.js`. The browser-tab icon letter is in `index.html` (the `<link rel="icon">` SVG).

## How syncing works

Each user has one row in `finance_data`, holding their whole budget as JSON plus a revision number. Changes save about a second after each edit, and the sidebar shows the save status. If the same account was edited on another device or tab in the meantime, the app asks which version to keep instead of silently overwriting it. When you come back to a tab, it picks up changes saved elsewhere. Users can export a backup, change their password, or permanently delete their account from **Settings → Account**.

## Install on a phone

The site can be installed as an app. Open it in Chrome on Android or Safari on iPhone, then use **Install app** from the account menu or Settings → Appearance & App. Installing needs HTTPS, which GitHub Pages provides. `sw.js` keeps the app working offline. It fetches the newest version of your files first and only uses the saved copy when there's no connection. Your Supabase data is never stored in that offline copy.

The app icons are in `icons/`. If you rename the app, update `manifest.webmanifest` as well as `js/config.js`.
