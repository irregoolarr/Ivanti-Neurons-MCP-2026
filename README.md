# Ivanti Neurons Command Center (Vercel)

A live, password-protected **executive dashboard** for your Ivanti Neurons tenant, hosted on Vercel.
It reads its data from **Ivanti's own hosted MCP servers** (the same ones Claude uses), so it shows exactly
what the MCP tools provide:

| Tab | What it shows |
|---|---|
| **Environment Action** | DEX organization score and sub-scores; management gap; open exposures; expired warranties; EOL software; prioritized recommended actions with checklists |
| **Unified Endpoint** | discovered, managed and manageable devices; new and stale devices; restarts, disk space, antivirus and warranty; breakdowns by OS, manufacturer, type and discovery source |
| **Exposures / Patch Status / Software Inventory / Software Distribution / Reporting / Data Services** | every read-only summary tool each domain offers, rendered as KPIs, bar charts or tables |
| **Target State** | each KPI against its remediation target |

Data is cached for 15 minutes; **Refresh** fetches it again. A daily Vercel Cron job keeps the data and the
Ivanti sign-in fresh.

## How sign-in works

Your Ivanti **AI Agent** registration only lets Ivanti send a sign-in back to Claude or to `localhost`. So the
dashboard can't have its own "Sign in with Ivanti" button. Instead:

1. You run `npm run login` **once on your computer**. It opens Ivanti's sign-in page in your browser.
2. After you sign in, the script sends the long-lived Ivanti login token to your dashboard, protected by your
   dashboard password.
3. The dashboard stores it in **Upstash Redis** and uses it to call the Ivanti MCP servers. Ivanti issues a new
   token each time one is used, and the dashboard saves each new one.

> The dashboard sees Ivanti **with your account's permissions**. Anyone with the dashboard password can view
> that data, so treat the password accordingly.

If the sign-in ever expires (the dashboard tells you), run `npm run login` again.

## Setup

### 1. Ivanti

1. Turn on **Admin > Settings > AI Settings > Enable Ivanti MCP servers**.
2. Go to **Admin > App Registrations > New Registration**, choose **AI Agent**, and copy the **Neurons Auth Url**
   and **Client ID**.

### 2. Vercel

1. Import this GitHub repository as a new project with the framework preset **Other**.
2. **Storage**: open the project's **Storage** tab, add **Upstash for Redis** (the free plan is enough) and
   connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Environment Variables**: add these:

   | Variable | Value |
   |---|---|
   | `NEURONS_AUTH_URL` | Neurons Auth Url |
   | `NEURONS_CLIENT_ID` | Client ID |
   | `DASHBOARD_PASSWORD` | a strong password for the dashboard |
   | `CRON_SECRET` | any long random string (secures the daily refresh job) |

4. **Redeploy**, so the new variables take effect.
5. Turn off **Deployment Protection** for Production, or keep it on if only your Vercel team should reach the
   site.

### 3. Connect the dashboard to Ivanti (one time)

On your computer, in this project folder, install the dependencies:

```bash
npm install
```

Create a file named `.env.local` with:

```
NEURONS_AUTH_URL=<Neurons Auth Url>
NEURONS_CLIENT_ID=<Client ID>
```

Then run:

```bash
npm run login -- --app https://<your-app>.vercel.app
```

Then:
1. Sign in to Ivanti in the browser window that opens.
2. When the script asks, enter your dashboard password.

The script checks which MCP domains accept the sign-in. It also writes the tools each domain offers to
`ivanti-tools.local.json`; that file is git-ignored and contains no data or tokens.

Open `https://<your-app>.vercel.app` and sign in with the dashboard password.

## Run locally

Create `.env.local` from `.env.example` and fill it in, then:

```bash
npm run dev
```

Open `http://localhost:3000`. Then, in a second terminal:

```bash
npm run login -- --app http://localhost:3000
```

Without Upstash variables, the local server keeps the sign-in in memory until it restarts.

## Configuration reference

| Variable | Required | Purpose |
|---|---|---|
| `NEURONS_AUTH_URL` | yes | Neurons Auth Url (AI Agent registration) |
| `NEURONS_CLIENT_ID` | yes | Client ID (AI Agent registration) |
| `DASHBOARD_PASSWORD` | yes | dashboard login; also authorizes `npm run login` uploads |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | yes on Vercel | Upstash Redis (added by the Vercel integration). `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work |
| `CRON_SECRET` | recommended | protects `/api/cron/refresh` |
| `SNAPSHOT_TTL_MINUTES` | no | cache lifetime, default 15 |
| `SESSION_SECRET` | no | cookie signing key (default derived from the password) |
| `NEURONS_MCP_DOMAINS` | no | subset of domains to query |
| `NEURONS_MCP_BASE_URL` | no | MCP host (default: tenant host taken from the Auth URL) |

## Safety

- **Read-only.** The dashboard only calls Ivanti tools that read data:
  - the device domain uses a fixed list of count and breakdown tools;
  - other domains use argument-free tools whose names mark them as summaries (count, summary, groups, list,
    history and similar);
  - tools whose names contain action verbs (create, delete, deploy, run and similar) are never called.
- **Protected.** Every data endpoint needs the dashboard login, and the cron endpoint needs `CRON_SECRET`.
- **Contained.** The Ivanti token is stored only in your Upstash database and never reaches the browser.

## MCP gateway (`/mcp`)

The project also contains an MCP gateway at `/mcp` that merges all 7 Ivanti domains into one connector.
Claude currently **rejects** it at sign-in. Ivanti returns its own issuer (`iss`) to Claude, and Ivanti doesn't
allow the gateway's callback URL, so the gateway can't replace it. Use the 7 direct connectors in Claude
(`https://<tenant>.ivanticloud.com/mcp/<domain>/v1`) instead. If Ivanti support adds
`https://<your-app>.vercel.app/oauth/callback` as an allowed redirect URL, the gateway can be finished.

## Project layout

```
api/index.ts        the Vercel function (vercel.json routes every path here)
dashboard/          dashboard page, styles and client script
scripts/login.ts    one-time Ivanti sign-in (npm run login)
src/dashboard.ts    dashboard routes: login, data API, sign-in upload, cron
src/collector.ts    calls the Ivanti MCP tools and builds the data snapshot
src/ivantiAuth.ts   stores and refreshes the Ivanti token
src/store.ts        Upstash Redis (in memory when running locally)
src/session.ts      dashboard password and cookie
src/router.ts       routing
src/mcp.ts, src/oauth.ts, src/upstream.ts, src/discovery.ts   MCP gateway and Ivanti discovery
```
