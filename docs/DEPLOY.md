# Deploying LazyDog

Everything below works on the **Workers Free** plan unless marked *(paid)* or
*(needs a domain)*. Two Workers are deployed: `lazydog-notes-mcp` first, then
`lazydog`.

## 0. Prerequisites

* Node 24+ and `npm install` at the repo root.
* A Cloudflare account, then: `npx wrangler login`

## 1. Notes MCP server

```bash
cd apps/notes-mcp
npx wrangler d1 create lazydog-notes          # copy the printed database_id …
#   … into apps/notes-mcp/wrangler.jsonc → d1_databases[0].database_id
openssl rand -hex 32                          # this is NOTES_MCP_SECRET; keep it
npx wrangler secret put NOTES_MCP_SECRET
npm run deploy                                # applies D1 migrations, then deploys
```

Note the URL it prints, e.g. `https://lazydog-notes-mcp.<subdomain>.workers.dev`.

## 2. AI Search instance

AI Search crawls only websites you own, so LazyDog indexes uploaded copies of
the Cloudflare Agents docs instead. Create an upload-based instance with the
two metadata fields LazyDog uses for citations:

```bash
npx wrangler ai-search create lazydog-docs --type builtin \
  --custom-metadata title:text --custom-metadata url:text
```

You seed it from the app after deploying (step 5).

## 3. GitHub OAuth app

<https://github.com/settings/developers> → **New OAuth App**

* Homepage URL: `https://lazydog.<subdomain>.workers.dev`
* Authorization callback URL: `https://lazydog.<subdomain>.workers.dev/auth/callback`

Keep the client id and generate a client secret.

## 4. LazyDog Worker

Edit `apps/lazydog/wrangler.jsonc` → `vars`:

| Var | Value |
|---|---|
| `NOTES_MCP_URL` | `https://lazydog-notes-mcp.<subdomain>.workers.dev/mcp` |
| `ALLOWED_GITHUB_LOGINS` | your GitHub login (only these can sign in; they are also admins) |
| `PUBLIC_URL` | `https://lazydog.<subdomain>.workers.dev` (used in email replies) |
| `MODEL_PROVIDER` / `MODEL_ID` | default Workers AI `@cf/moonshotai/kimi-k2.6`; or `anthropic` / `openai` |

Secrets:

```bash
cd apps/lazydog
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put NOTES_MCP_SECRET        # same value as step 1
# only if MODEL_PROVIDER is anthropic / openai:
# npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy                                  # vite build && wrangler deploy
```

## 5. First run

1. Open the app and sign in with GitHub.
2. In **Identity & channels**, click **Seed AI Search with the Cloudflare
   Agents docs** (admins only). It uploads ~110 pages in batches of 20.
   Indexing continues in the background: `npx wrangler ai-search stats lazydog-docs`.
3. Try: *"Explain Cloudflare durable execution."* — it should call
   `ai_search`, then answer with source links.

## 6. Slack (optional, free)

1. <https://api.slack.com/apps> → **Create New App** (from scratch).
2. **OAuth & Permissions** → bot scopes: `chat:write`, `im:history`,
   `app_mentions:read`. Install to the workspace; copy the **Bot User OAuth
   Token** (`xoxb-…`).
3. **Basic Information** → copy the **Signing Secret**.
4. **App Home** → enable the Messages tab and allow users to message the app.
5. Set secrets and redeploy:
   ```bash
   npx wrangler secret put SLACK_BOT_TOKEN
   npx wrangler secret put SLACK_SIGNING_SECRET
   npx wrangler secret put SLACK_BOT_USER_ID     # the bot's user id, e.g. U07…
   ```
6. **Event Subscriptions** → Request URL
   `https://lazydog.<subdomain>.workers.dev/webhooks/slack`; subscribe to bot
   events `message.im` and `app_mention`.
7. In the web app click **Link Slack / email**, then DM the bot
   `link ABCD-1234`.

## 7. Email (optional, needs a domain on Cloudflare)

1. Dashboard → your domain → **Email Routing**: enable it and add a custom
   address, e.g. `lazydog@yourdomain.com`, with action **Send to a Worker →
   lazydog**.
2. Set `EMAIL_FROM` to that address and redeploy.
3. Outbound replies use the `send_email` binding; your domain must be
   permitted to send through Cloudflare Email Service.
4. Link your address: **Link Slack / email**, then email `link ABCD-1234`.

Mail must pass DKIM or DMARC to be accepted (see IDENTITY.md).

## 8. Sandbox / `run_python` *(paid)*

Requires Workers Paid and Docker (to build the container image).

```bash
cd apps/lazydog
npm run deploy:paid      # builds with CLOUDFLARE_ENV=paid: adds the Sandbox container
```

The paid environment deploys as a separate Worker (`lazydog-paid`) with its
own secrets — repeat the `secret put` commands with `--env paid`.

## Local development

```bash
npm run dev:notes                       # notes MCP on :8788 (local D1)
npm run dev                             # LazyDog on :5173 — needs `wrangler login`
npm run dev:offline -w apps/lazydog     # no login: scripted mock model, no remote bindings
```

With `DEV_LOGIN=true` in `apps/lazydog/.dev.vars`, sign in locally at
`/auth/dev?login=<name>`. Simulate inbound email:

```bash
curl -X POST "http://localhost:5173/cdn-cgi/handler/email?from=you@example.org&to=lazydog@example.com" \
  --data-binary @message.eml     # include an Authentication-Results: dkim=pass header
```
