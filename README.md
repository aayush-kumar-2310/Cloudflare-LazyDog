# 🐕 LazyDog

A persistent personal AI agent on Cloudflare. Each person gets **one durable
agent** — a [Think](https://developers.cloudflare.com/agents/harnesses/think/)
agent on a SQLite-backed Durable Object — that they reach from **web chat,
push-to-talk voice, Slack, email and signed webhooks**. Every channel lands in
the same conversation, memory, notes, reminders and activity log.

[Architecture](docs/ARCHITECTURE.md) · [Identity across channels](docs/IDENTITY.md) · [Webhooks](docs/WEBHOOKS.md) · [Deploy](docs/DEPLOY.md)

## What it does

| Capability | How | Status |
|---|---|---|
| Durable agent, state, history | `Think` + Session in DO SQLite, synced state via `useAgent` | ✅ tested |
| Streaming web chat | `useAgentChat` over the agent WebSocket | ✅ tested in browser |
| Configurable model | Workers AI Qwen 3.8 27B (default, benchmarked), Anthropic or OpenAI via `MODEL_PROVIDER` | ✅ tested on real Workers AI |
| AI Search research with sources | `ai_search` over a **Cloudflare Agents docs index** (not web search); the index is created and seeded automatically on the first admin visit | ✅ verified on real Workers AI + AI Search; research → read → save-note turn in CI |
| Browser | `browser_open` / `browser_links` (Browser Run Quick Actions, paced, fetch fallback) | ✅ tested on real Browser Run |
| Code execution | `run_python` in Cloudflare Sandbox *(Workers Paid only)*; Think's workspace `bash` on free | ⚠️ `run_python` written and type-checked but never run (no paid plan); `bash` is the free path |
| MCP | separate Notes MCP Worker (`createMcpHandler`, D1); agent is an MCP client | ✅ tested end to end |
| Scheduled tasks | `schedule_reminder` → Agent schedules (DO alarms) | ✅ tested (real alarm) |
| Webhooks | `POST /webhook`, per-source HMAC, idempotent durable turns, restricted tools | ✅ tested |
| Slack | `agents/channels` Slack adapter, code-based identity linking | ✅ in CI against a stubbed Slack API; not yet run against a real workspace |
| Email | `agents/channels` email adapter, DKIM/DMARC required, replies | ⚠️ inbound parsing + linking verified manually (local simulation); reply delivery in CI; never run on a real domain |
| Voice | push-to-talk (gated mic), `withVoice` bridge → turns on the user's LazyDog | ⚠️ verified on real Flux STT + Aura TTS with synthesized speech; not in CI; not tried on a live microphone |
| Human approval | `needsApproval` on every MCP write (`create_note`, `delete_note`) and on payments; approved **in the web app only** (Slack/email get a "pending" note) | ✅ in CI (approval over the agent WebSocket) and in the browser |
| Activity panel | Think hooks + `agents/observability` events, no synthetic entries | ✅ tested |
| Recoverability | checkpointed research-job fiber, crash-and-resume demo | ✅ tested (forced abort) |
| Cross-channel identity | GitHub sign-in + one-time link codes → `IdentityRegistry` | ✅ tested |
| Payments *(stretch, off by default)* | x402 on Base Sepolia: approval-gated `buy_premium_brief`, policy-checked signing, paid MCP server | ⚠️ in CI against a stub facilitator; never run live (needs a testnet wallet) |

✅ = covered by tests and/or verified against real Cloudflare services.
⚠️ = works as described but with the limits stated. The full list of gaps is in
[ARCHITECTURE.md → Not done / known gaps](docs/ARCHITECTURE.md#not-done--known-gaps).
Live deployment: <https://lazydog.kumar-aayush2310.workers.dev> — sign in
with any GitHub account; each account gets its own agent.

## Pitfalls

Things that will trip up a demo or a first deploy:

* **Shared free AI quota.** The live app runs on Workers Free: about a few
  dozen agent turns per day *in total*, shared by everyone who signs in. Once
  it's used, chat replies with a plain "allowance used" message. It nominally
  resets at 00:00 UTC, but was observed still refusing calls 1.5 hours later.
* **Slow answers.** Qwen 3.8 27B (the best free-plan tool-caller) took ~114 s
  for a full research answer, ~80 s of it writing. Browser Run on Free allows
  one page load every 10 s, so multi-page research waits or falls back to a
  plain fetch (labelled `via: "direct-fetch"`).
* **Note writes wait for you.** Saving or deleting a note pauses the turn
  until you approve it in the web app — including when the request came from
  Slack, email or a webhook.
* **Research needs the docs index.** On a fresh deploy the index is seeded on
  the first admin visit; until it shows "ready", answers have no sources.
* **One conversation everywhere.** Anything said on one channel is visible to
  the model on all of a user's channels.
* **The model can embellish.** Free-plan models sometimes add claims beyond
  what the cited page says; check the sources.
* **Local dev.** `npm run dev` needs `wrangler login` and a workers.dev
  subdomain on the account; offline mode has no AI Search or Browser Run.
  Tests pin `compatibility_date` to 2026-08-22, the newest the test runtime
  supports.
* **Config is this deployment's.** `wrangler.jsonc` holds this repo's URLs,
  GitHub login and D1 id; replace them to deploy your own
  ([DEPLOY.md](docs/DEPLOY.md)).

## Not covered

* **`run_python` on the free plan.** It needs Workers Paid (Containers); it's
  written but has never run. Free deployments get Think's network-less `bash`.
* **Web search.** `ai_search` searches an index of the Cloudflare Agents docs;
  other sites are reachable only by URL through `browser_open`.
* **Approving from Slack or email.** No buttons or approve links; approval is
  web-only.
* **Inbound email and voice in CI**, a real email domain, a real Slack
  workspace, and voice on a live microphone. Email was checked with local
  simulation, Slack against a stubbed API, voice with synthesized speech.
* **A live payment.** x402 is tested against a stub facilitator only; MPP and
  mainnet aren't wired.
* **Per-user limits on chat turns**, unlinking a channel identity, and docs
  seeding at deploy time (it starts on the first admin visit).

Details and reasoning: [ARCHITECTURE.md → Not done / known
gaps](docs/ARCHITECTURE.md#not-done--known-gaps).

## Quick start (no Cloudflare login needed)

```bash
npm install
cp apps/lazydog/.dev.vars.example apps/lazydog/.dev.vars       # local secrets + DEV_LOGIN=true
cp apps/notes-mcp/.dev.vars.example apps/notes-mcp/.dev.vars
npm run dev:notes                          # terminal 1: notes MCP on :8788
npm run dev:offline -w apps/lazydog        # terminal 2: LazyDog on :5173
```

Open <http://localhost:5173/auth/dev?login=demo>. Offline mode uses a scripted
model (no AI Search or Browser Run): plain messages are echoed,
`/tool <name> <json>` calls one tool, and `/script [...]` chains several, e.g.

```
/tool schedule_reminder {"message":"stretch","inSeconds":60}
/tool notes_create_note {"title":"Durable execution","content":"Fibers checkpoint work."}
```

The note write asks for approval first. With `npx wrangler login` (and a
workers.dev subdomain registered on the account), run `npm run dev` instead to
use Workers AI, AI Search and Browser Run.

## Layout

```
apps/lazydog/            the agent Worker + React UI
  src/server/agent/        LazyDog (Think), tools, prompts, durable research job, mock model
  src/server/channels/     Slack/email ChannelHost, webhook ingress
  src/server/identity/     IdentityRegistry Durable Object (identities, link codes, docs seeding)
  src/server/voice/        VoiceBridge (withVoice)
  src/server/payments/     x402 policy + paid PremiumMCP server (stretch)
  src/server/http/         JSON API, AI Search docs seeding
  src/server/auth/         GitHub OAuth, signed sessions
  src/client/              chat, approvals, activity, reminders, jobs, channels, webhooks, voice
  test/                    vitest-pool-workers suites; fixtures/ = AI Search, Browser Run, Notes doubles
apps/notes-mcp/          Notes MCP server Worker (D1)
packages/shared/         HMAC + notes capability tokens
scripts/send-webhook.mjs sign and send a webhook from a terminal
scripts/chat.mjs         chat with a running LazyDog from a terminal (dev login)
docs/                    architecture, identity, webhooks, deploy
```

## Tests

```bash
npm test          # both Workers, in the Workers runtime (vitest-pool-workers)
npm run typecheck
```

81 tests (78 LazyDog + 3 Notes MCP): a scripted multi-tool turn (search →
browse → approval → note saved through the real Notes MCP Worker over HTTP),
the agent loop through the real Think runtime, durable submissions and dedupe,
reminders firing from a real alarm, the crash-and-resume job, webhook
signing/replay/size/rate rules, identity linking and its abuse guards, Slack
ingress (stubbed Slack API), email *reply* delivery, auth/origin/state
hardening, docs-index seeding, the payment policy and x402 signing (stub
facilitator), and the Notes MCP server through a real MCP client. The model in
CI is scripted, so tests prove the plumbing, not the model's tool choices;
those were checked against real Workers AI (see ARCHITECTURE.md). Inbound
email parsing and voice are not in CI.
