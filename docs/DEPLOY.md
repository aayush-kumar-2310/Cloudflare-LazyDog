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

## 2. AI Search

Nothing to do now. AI Search crawls only websites you own, so LazyDog indexes
uploaded copies of the Cloudflare Agents docs instead: the admin **Seed AI
Search** action (step 5) creates the `lazydog-docs` instance through the
Worker's binding if it doesn't exist, with the `title` and `url` metadata
fields used for citations, then uploads the pages. (Creating it with
`wrangler ai-search create` instead requires an AI Search service token.)

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
| `ALLOWED_GITHUB_LOGINS` | your GitHub login. Only these can sign in, and they are admins. Empty means **nobody** can sign in unless `OPEN_SIGNUP="true"` |
| `PUBLIC_URL` | `https://lazydog.<subdomain>.workers.dev` (used in email replies) |
| `MODEL_PROVIDER` / `MODEL_ID` | default Workers AI `@cf/qwen/qwen3.8-27b` (see below); or `anthropic` / `openai` |

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
   Indexing continues in the background; search returns results while it runs.
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

## Payments demo (optional, testnet, no real money)

LazyDog can pay for a "premium brief" with x402 on Base Sepolia. You need two
testnet wallets (or one, paying itself) — do this yourself; never reuse a key
that holds real funds:

1. Create a **new** EVM wallet for the agent to pay from, and note a
   recipient address (any address you control).
2. Fund the payer with test USDC on **Base Sepolia** from
   <https://faucet.circle.com/>. The payer needs no ETH: the x402 facilitator
   submits the transfer.
3. Configure and redeploy:
   ```bash
   cd apps/lazydog
   npx wrangler secret put X402_PRIVATE_KEY      # the payer's private key (0x…)
   # set "X402_PAY_TO": "0x<recipient>" in wrangler.jsonc vars, then:
   npm run deploy
   ```
4. Ask LazyDog for "a premium brief on durable execution". Approve the card
   (it shows the $0.01 price); the activity log records the policy decision
   and the brief arrives. Check the transfer on <https://sepolia.basescan.org>.

## Model choice and the free-plan budget

Many Workers AI models (Kimi K2.6, GLM-5.3, DeepSeek V4) return **5035: not
available on the Workers Free plan**. Free-plan tool-calling models were
benchmarked on four LazyDog turns (browse a page, save it as a note, "remind
me tomorrow at 10 AM", recall notes and reminders):

| Model | Passed | Avg latency | Notes |
|---|---|---|---|
| `@cf/qwen/qwen3.8-27b` | 4/4 | 18.6 s | correct tools and arguments every time — **default** |
| `@cf/openai/gpt-oss-120b` | 2/4 | 26.5 s | twice degenerated into repeated `!` with no tool call |
| `@cf/zai-org/glm-4.7-flash` | 1/1 run | 22.0 s | remaining runs hit the daily quota |

Workers Free includes **10,000 Neurons per day**. An agent turn sends ~20 tool
schemas plus history, so expect a few dozen turns per day; after that every
turn fails with error 4006 (shown to the user as a plain message) until 00:00
UTC. For more, use Workers Paid or `MODEL_PROVIDER=anthropic|openai`.

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
