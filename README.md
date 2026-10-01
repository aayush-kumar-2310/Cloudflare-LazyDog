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
| AI Search research with sources | `ai_search` tool on an `ai_search_namespaces` binding; admin seeding creates + fills the instance | ✅ instance created and searched on real AI Search |
| Browser | `browser_open` / `browser_links` (Browser Run Quick Actions, paced, fetch fallback) | ✅ tested on real Browser Run |
| Code execution | `run_python` in Cloudflare Sandbox *(paid)*; workspace `bash` on free | ✅ wired |
| MCP | separate Notes MCP Worker (`createMcpHandler`, D1); agent is an MCP client | ✅ tested end to end |
| Scheduled tasks | `schedule_reminder` → Agent schedules (DO alarms) | ✅ tested (real alarm) |
| Webhooks | `POST /webhook`, per-source HMAC, idempotent durable turns, restricted tools | ✅ tested |
| Slack | `agents/channels` Slack adapter, code-based identity linking | ✅ tested (stubbed Slack API) |
| Email | `agents/channels` email adapter, DKIM/DMARC required, replies | ✅ verified manually (local email simulation) |
| Voice | push-to-talk (gated mic), `withVoice` bridge → turns on the user's LazyDog | ✅ tested on real Flux STT + Aura TTS (synthesized speech) |
| Human approval | `needsApproval` on destructive MCP tools; approve in the web UI | ✅ tested in browser |
| Activity panel | Think hooks + `agents/observability` events, no synthetic entries | ✅ tested |
| Recoverability | checkpointed research-job fiber, crash-and-resume demo | ✅ tested (forced abort) |
| Cross-channel identity | GitHub sign-in + one-time link codes → `IdentityRegistry` | ✅ tested |
| Payments | x402 on Base Sepolia: approval-gated `buy_premium_brief`, policy-checked signing, paid MCP server | ✅ tested end to end against a stub facilitator · live run needs your testnet wallet |

"Needs account" items call real Cloudflare services; they are type-checked and
wired but must be exercised after `wrangler login` (see [DEPLOY.md](docs/DEPLOY.md)).

## Quick start (no Cloudflare login needed)

```bash
npm install
npm run dev:notes                          # terminal 1: notes MCP on :8788
npm run dev:offline -w apps/lazydog        # terminal 2: LazyDog on :5173
```

Open <http://localhost:5173/auth/dev?login=demo>. Offline mode uses a scripted
model: plain messages are echoed, and `/tool <name> <json>` calls a tool, e.g.

```
/tool notes_create_note {"title":"Durable execution","content":"Fibers checkpoint work."}
/tool schedule_reminder {"message":"stretch","inSeconds":60}
```

With `npx wrangler login`, run `npm run dev` instead to use Workers AI, AI
Search and Browser Run.

## Layout

```
apps/lazydog/            the agent Worker + React UI
  src/server/agent/        LazyDog (Think), tools, prompts, durable research job
  src/server/channels/     Slack/email ChannelHost, webhook ingress
  src/server/identity/     IdentityRegistry Durable Object
  src/server/voice/        VoiceBridge (withVoice)
  src/server/auth/         GitHub OAuth, signed sessions
  src/client/              chat, approvals, activity, reminders, jobs, channels, webhooks
apps/notes-mcp/          Notes MCP server Worker (D1)
packages/shared/         HMAC + notes capability tokens
scripts/send-webhook.mjs sign and send a webhook from a terminal
docs/                    architecture, identity, webhooks, deploy
```

## Tests

```bash
npm test          # both Workers, in the Workers runtime (vitest-pool-workers)
npm run typecheck
```

78 tests: the agent loop with a scripted model through the real Think runtime,
durable submissions and dedupe, reminders firing from a real alarm, the
crash-and-resume job, webhook signing/replay/size rules, identity linking and
its abuse guards, Slack and email routing, auth and routing, and the notes MCP
server through a real MCP client.
