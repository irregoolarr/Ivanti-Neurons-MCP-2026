# Ivanti Neurons MCP Gateway (Vercel)

**One MCP connector for all Ivanti Neurons MCP domains.**

Ivanti hosts a separate MCP server for each domain (`https://<tenant>/mcp/<domain>/v1`), so normally you add
7 connectors. This gateway runs on Vercel and puts them behind **one URL**:

```
https://<your-app>.vercel.app/mcp
```

It uses the **AI Agent** app registration (Neurons Auth URL + Client ID). You don't need a client secret.

## How it works

```
Claude ──► Vercel gateway /mcp ──► https://<tenant>/mcp/device/v1
              │                ├─► .../mcp/dataservices/v1
              │                ├─► .../mcp/patch/v1
              │                ├─► .../mcp/exposures/v1
              │                ├─► .../mcp/software-inventory/v1
              │                ├─► .../mcp/software-distribution/v1
              │                └─► .../mcp/reporting/v1
              │
              └─ sign-in: the browser goes to Ivanti's own login page (OAuth + PKCE)
```

- **Sign-in.** When you add the connector, Claude opens Ivanti's sign-in page. The gateway gives Claude your
  Client ID and passes the login steps through to Ivanti. Each person signs in with their own Ivanti account,
  so Ivanti's permissions apply as usual.
- **Tools.** The gateway lists the tools of every domain and adds a domain prefix to each name:

  | Prefix | Ivanti domain |
  |---|---|
  | `device__` | device |
  | `dataservices__` | dataservices |
  | `patch__` | patch |
  | `exposures__` | exposures |
  | `swinventory__` | software-inventory |
  | `swdist__` | software-distribution |
  | `reporting__` | reporting |

  Calls go to the right Ivanti server with the user's own token.
- **Missing domains.** A domain that isn't enabled or licensed on your tenant is skipped. The extra tool
  `ivanti_connection_status` shows which domains work.
- **Nothing stored.** The gateway keeps no tokens or data. Tool lists are cached in memory for 5 minutes.

## 1. Ivanti setup

1. Sign in to Neurons as an administrator.
2. Turn on **Admin > Settings > AI Settings > Enable Ivanti MCP servers**.
3. Go to **Admin > App Registrations > New Registration**, choose **AI Agent**, and click **Continue**.
4. Copy the **Neurons Auth Url** and **Client ID** before you click *Finish and close*. Ivanti shows them only once.

## 2. Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, click **Add New > Project** and import the repository. Choose the framework preset **Other**.
   No build settings are needed.
3. Under **Settings > Environment Variables**, add:

   | Variable | Value |
   |---|---|
   | `NEURONS_AUTH_URL` | the Neurons Auth Url |
   | `NEURONS_CLIENT_ID` | the Client ID |

4. Deploy. You can also deploy from the CLI:

   ```bash
   npx vercel --prod
   ```

5. Turn off **Vercel Deployment Protection** for Production (Settings > Deployment Protection). Otherwise
   Claude gets Vercel's login page instead of the gateway.

6. Open `https://<your-app>.vercel.app/health?probe=1` and check:
   - `ivanti.source` starts with `metadata:`. This means Ivanti's sign-in endpoints were found.
   - each entry in `ivanti.probes` has `unauthenticatedStatus: 401`. This means the domain URL is right and
     asks for sign-in.

   If the probes show `404`, the domain URLs are wrong. Set `NEURONS_MCP_BASE_URL` to your tenant host
   (`https://<tenant>.ivanticloud.com`) and redeploy.

## 3. Add it to Claude

**Claude.ai / Claude Desktop**

1. Go to **Settings > Connectors > Add custom connector**.
2. For the URL, enter `https://<your-app>.vercel.app/mcp`. The root URL `https://<your-app>.vercel.app/` also works.
3. Leave *Advanced settings* empty. The gateway supplies the Client ID.
4. Click **Connect** and sign in to Ivanti.

**Claude Code**

```bash
claude mcp add --transport http ivanti https://<your-app>.vercel.app/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate**.

**VS Code / Cursor (`mcp.json`)**

```json
{ "servers": { "ivanti": { "type": "http", "url": "https://<your-app>.vercel.app/mcp" } } }
```

## Run locally

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local`, then:

```bash
npm run dev
```

The gateway runs at `http://localhost:3000/mcp`. Open `http://localhost:3000/health?probe=1` to check discovery.

## Configuration reference

| Variable | Required | Purpose |
|---|---|---|
| `NEURONS_AUTH_URL` | yes | Neurons Auth Url from the AI Agent registration |
| `NEURONS_CLIENT_ID` | yes | Client ID from the AI Agent registration |
| `NEURONS_MCP_DOMAINS` | no | comma-separated subset of domains (default: all seven) |
| `NEURONS_MCP_BASE_URL` | no | base that `/mcp/<domain>/v1` is added to (default: the tenant host in the Auth URL, e.g. `https://nvuprd-sfc.ivanticloud.com/acme.ivanticloud.com` → `https://acme.ivanticloud.com`) |
| `NEURONS_AUTHORIZATION_ENDPOINT`, `NEURONS_TOKEN_ENDPOINT` | no | set these if Ivanti's sign-in endpoints can't be found automatically |
| `NEURONS_OAUTH_SCOPES` | no | scopes to request (default: the scopes Ivanti's servers advertise) |
| `NEURONS_OAUTH_RESOURCE` | no | OAuth `resource` sent to Ivanti: `none` (default), `auto`, or explicit values |
| `PUBLIC_BASE_URL` | no | public URL, if it isn't detected correctly (e.g. a custom domain behind a proxy) |

## Troubleshooting

| Symptom | What to check |
|---|---|
| Sign-in page shows "invalid redirect_uri" | Ivanti must allow the client's callback URL. For Claude.ai it is `https://claude.ai/api/mcp/auth_callback`. Ask Ivanti support if it isn't accepted. |
| Sign-in shows "invalid_target" / "invalid resource" | Set `NEURONS_OAUTH_RESOURCE=auto`. |
| Sign-in shows "invalid_scope" | Set `NEURONS_OAUTH_SCOPES` to the scopes Ivanti expects. |
| Signed in, but some tools are missing | Call `ivanti_connection_status`. Missing domains are usually not enabled or not licensed. |
| Every call asks you to sign in again | Ivanti may issue tokens for one domain only. Use `NEURONS_MCP_DOMAINS` to limit the gateway to the domains you need. |

## Project layout

```
api/index.ts       Vercel function (vercel.json routes every path here)
src/router.ts      routes: /mcp, /.well-known/*, /oauth/*, /health
src/mcp.ts         MCP endpoint: merges the domains' tools and forwards calls
src/upstream.ts    MCP client for Ivanti's hosted servers
src/oauth.ts       sign-in pass-through to Ivanti (register / authorize / token)
src/discovery.ts   finds Ivanti's OAuth endpoints and scopes automatically
src/config.ts      environment variables and domain list
dev/server.ts      local dev server
```
# Ivanti-Neurons-MCP-2026
