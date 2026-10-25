# Coconut Plucking PWA

An installable, offline-first web app for tracking coconut plucking, dehusking and sales sessions. A Google Sheet stores the data.

- **Home**: shows the plucking session in progress, a button to start a new one, and all recently completed sessions.
- **Plucking session** (each one has a name, which defaults to the month, e.g. "October 2026 plucking", and you can change it):
  - **Workers**: each has a name and a type, *Climber* or *Collector*. A new session starts with the crew from the last session, so you only need to remove anyone who didn't come.
  - **Plots**: there is one by default and you can add as many as you need. Every plot uses the session's workers. Each climber has a **+1 counter**: tap it once per tree climbed. The plot's tree count is the total of these taps. You enter the coconut count by hand.
  - **Transport per plot**: the vehicle or driver name and the fee. You can add more than one vehicle.
  - **Workers fee**: each worker has their own fee. **Apply to climbers** sets each climber's fee to trees climbed × the rate per tree.
  - **Mark plucking as completed** moves the session to the "Recently completed" list. You can reopen it later.
- **Dehusking**: date, number of coconuts, and each worker's name and fee.
- **Sales session**: customers with KG, rate and total (total = KG × rate, and you can edit it). Mark each customer's payment as received or not.
- **Saving**: every change saves automatically. A **Save** button on each edit page saves straight away and shows whether everything has reached Google Sheets.
- **Dues**: every unpaid amount, grouped by customer.
- **Analytics**: compares the latest plucking with the previous one, including workers' fees, transport and dehusking. It also shows trends across sessions, plus tables for each plot, each worker (trees climbed, ₹ per tree, total paid) and each customer.

There is no build step. The app is plain HTML, CSS and JS.

## 1. Set up the Google Sheet backend

1. Create a new Google Sheet, for example "Coconut Plucking Data".
2. Open **Extensions → Apps Script**. Delete the sample code and paste in the contents of [apps-script/Code.gs](apps-script/Code.gs). Save.
3. Pick the `setup` function in the toolbar and click **Run**. Approve the permissions.
   This creates the sheets `PluckingSessions`, `Workers`, `Plots`, `ClimberTrees`, `Transport`, `Dehusking`, `DehuskWorkers`, `SalesSessions` and `SaleItems`, and generates an **API token**.
   The token appears in the execution log. You can also find it under Project Settings → Script Properties → `API_TOKEN`.
4. Click **Deploy → New deployment**, choose the type **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the **Web app URL**. It ends in `/exec`.

The web app rejects any request that doesn't carry the token, so keep the token private.
If you change `Code.gs` later, run `setup` again (it adds any new sheets and columns and keeps your data), then use **Deploy → Manage deployments → Edit → Version: New version**. The URL stays the same.

## 2. Host the app

A service worker needs HTTPS (or `localhost`). Any static host works:

- **GitHub Pages**: push this folder to a repository, then go to Settings → Pages → Deploy from branch.
- **Netlify / Cloudflare Pages**: drag and drop this folder.
- **Local testing**: run `python -m http.server 8080` in this folder and open http://localhost:8080.

## 3. Connect and install

1. Open the app and go to **Settings**. Paste the Web app URL and the API token, then tap **Save & connect**.
2. On your phone, use **Add to Home screen** (Chrome: menu → Install app).

## How syncing works

- Every edit saves to the device straight away, so the app works offline.
- Changes queue up and go to the Sheet about 2 seconds after you stop typing, when you come back online, or when you tap the sync pill in the header.
- After each sync, the app pulls the full Sheet. Edits made on another device, or straight in the Sheet, show up here.
- The client generates the IDs, so a retried sync never creates duplicate rows.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app (views, local store, sync, charts) |
| `sw.js` | Offline cache. Bump `CACHE` when you deploy changes. |
| `manifest.webmanifest`, `icons/` | Install metadata and icons |
| `apps-script/Code.gs` | The Google Sheets API (Apps Script web app) |
