# LazyDog architecture

LazyDog is a persistent personal agent. Every user gets one long-lived agent —
a [Think](https://developers.cloudflare.com/agents/harnesses/think/) agent on
a SQLite-backed Durable Object — and every channel (web, voice, Slack, email,
webhooks) reaches that same agent.

Versions: `agents@0.24`, `@cloudflare/think@0.19`, `ai@7`, Wrangler 4.

## Components

```
                     ┌──────────────────────── lazydog Worker ─────────────────────────┐
 Browser ── /agent ──►  session check ──► LazyDog DO (usr_…)  ◄── RPC ── VoiceBridge DO │
  (chat, state, WS)  │                     Think harness                (withVoice:   │
 Browser ── voice ───►  session check ──►  • agent loop / tools          STT + TTS)   │
 Slack ─ /webhooks/slack ─► ChannelHost ┐  • Session (SQLite)                         │
 Email ─ email() ──────────► ChannelHost ┼► IdentityRegistry DO ─► userId ─► LazyDog   │
 Systems ─ /webhook ─► HMAC verify ─────┘  • schedules, fibers, submissions           │
                     │                     • MCP client ──────────────┐               │
                     └────────────────────────────────────────────────┼───────────────┘
   Workers AI · AI Search · Browser Run · Sandbox (paid) · Email       │ Streamable HTTP
                                                                      ▼
                                          lazydog-notes-mcp Worker (createMcpHandler + D1)
```

| Piece | What it is | Why |
|---|---|---|
| `LazyDog` | `Think` subclass, one per user | Think owns the agent loop, message persistence, resumable streaming, approvals, durable submissions and turn recovery. LazyDog adds tools, channel policy, delivery, reminders and the activity log. |
| `IdentityRegistry` | Durable Object + `agents/channels` `UserIdentityStore` | The only place that maps channel identities to users. See [IDENTITY.md](IDENTITY.md). |
| `VoiceBridge` | `withVoice(Agent)` | Audio in/out only. Each finished utterance becomes a `voice` turn on the user's LazyDog, so voice shares history and tools. |
| `ChannelHost` | `agents/channels` with the Slack and email adapters | Verifies provider signatures, normalises events, routes by linked user, delivers replies (Slack messages, email replies). |
| `lazydog-notes-mcp` | Separate Worker, `createMcpHandler` (MCP SDK v2), D1 | A real MCP server with `create_note`, `list_notes`, `get_note`, `delete_note`; usable by other MCP clients too. |

## A turn, end to end

1. **Entry.** Web chat speaks the `cf_agent_chat_*` WebSocket protocol through
   `useAgentChat`. Other channels call RPC entry points on the agent:
   `receiveInbound` (Slack/email), `receiveWebhook`, `voiceTurn`.
2. **Admission.** Slack, email and webhooks use `runTurn({ mode: "submit" })`
   with an idempotency key, so the event is durably accepted before the
   provider is acknowledged, and redeliveries never create a second turn.
3. **Policy.** The turn is stamped with its channel; `configureChannels()`
   prepends channel instructions, caps steps, and (webhook) filters tools.
   `beforeTurn` adds the current time in the user's timezone.
4. **Loop.** Think runs the model with the merged tool set and continues until
   the model answers. Tools needing approval pause the turn until the user
   approves in the web UI.
5. **Persistence.** Messages live in Think's Session (DO SQLite). The web
   transcript is the union of all channels.
6. **Delivery.** `onChatResponse` replies on the origin channel when the turn
   came from Slack/email, using the reply surface recorded at intake, deduped
   per request id.

## Tools

| Tool | Backed by | Side effects / approval |
|---|---|---|
| `ai_search` | AI Search binding (`ai_search_namespaces`) | read-only; returns ranked sources rendered as citations |
| `browser_open`, `browser_links` | Browser Run Quick Actions (`agents/browser`) | read-only; public http(s) only (no localhost/private ranges) |
| `run_python` | `@cloudflare/sandbox` container | only when the Sandbox binding exists (`--env paid`) |
| `bash` + file tools | Think workspace (in-isolate, no network) | free-plan code execution fallback |
| `notes_*` | MCP client → notes Worker | `notes_delete_note` requires approval (server marks it `destructiveHint`) |
| `schedule_reminder`, `list_reminders`, `cancel_reminder` | Agent `schedule()` (DO alarms) | validated: explicit UTC offset, future, ≤1 year |
| `start_research_job` | managed fiber | durable background job (below) |
| `set_context` | Think Session memory block | not available to webhook turns |

## Durability

* **Turns**: Think wraps every turn in a recoverable fiber; an interrupted
  stream is resumed or retried (`chatRecovery`), and interrupted tool calls are
  repaired so they are not silently re-run.
* **Submissions**: Slack/email/webhook turns are rows in Think's submission
  ledger before they run.
* **Schedules**: reminders are Agent schedules backed by Durable Object alarms;
  they fire with no client connected.
* **Research job** (the explicit recoverability demo): a 4-step fiber
  (search → read → summarize → save). After each step the result is
  checkpointed with `ctx.stash()` (synchronous SQLite write). If the object
  dies, `onFiberRecovered` starts a continuation from the checkpoint; finished
  steps are not repeated. The UI's **Durable jobs** panel can deliberately
  `ctx.abort()` the Durable Object after a chosen step; the test suite does the
  same and asserts the first step ran exactly once.

## Observability

* **Activity panel** (agent state, synced to the browser). Entries come only
  from real events: Think hooks (`beforeTurn`, `beforeToolCall`,
  `afterToolCall`, `onChatResponse`), LazyDog's own channel/schedule/job code,
  and `agents/observability` diagnostics events (schedules, fibers, chat
  recovery, MCP). Diagnostics subscriptions are isolate-global, so one
  subscription per isolate dispatches to the *live* instance by name — a
  handler captured by a reset instance would otherwise write to a dead object.
* **Workers Observability** with traces enabled; Think emits `invoke_agent`,
  `chat`, `execute_tool` and `tool_approval` spans.

## Security model

* Web: GitHub OAuth, HMAC-signed HttpOnly SameSite=Lax cookie, Origin check on
  state-changing API calls; optional `ALLOWED_GITHUB_LOGINS` allowlist. The dev
  login exists only with `DEV_LOGIN=true` on a loopback host.
* Agents are selected from the session, never the URL.
* Slack: signing-secret verification with a 5-minute window; only DMs and
  mentions are answered; bot/self messages ignored.
* Email: DKIM/DMARC pass required; auto-replies ignored.
* Webhooks: per-source HMAC over `source.timestamp.body`, 5-minute window,
  64 KB cap, idempotent, restricted tools — see [WEBHOOKS.md](WEBHOOKS.md).
* Notes MCP: per-user capability token `userId.HMAC(secret, userId)`; the
  server derives the user only from a token it can verify.
* Side-effecting tools: destructive MCP tools need approval; code runs only in
  a container (paid) or the network-less workspace bash.

## Tradeoffs

* **Think over a hand-rolled loop.** Think gives recovery, approvals,
  submissions and channels for free; the cost is coupling to an experimental
  API (`runTurn`, channels) that may change before 1.0.
* **`agents/channels` (experimental) for Slack/email.** One normalised model
  for ingress, identity and delivery instead of three bespoke integrations.
  It holds no state, so durability is ours (submissions + delivery ledger).
* **Custom channels instead of Think messengers for Slack.** Messengers create
  one conversation per Slack thread by default; LazyDog deliberately routes
  every linked identity to the user's single agent.
* **One conversation for all channels.** Matches "same agent everywhere", but
  long histories rely on Think's compaction, and context crosses channels
  (documented in IDENTITY.md).
* **Notes MCP as a separate Worker.** Uses the current `createMcpHandler`
  path (the stateful `McpAgent` is deprecated) and is reusable by other MCP
  clients, at the cost of a second deployment.
* **Free plan first.** Sandbox and Dynamic Workers need Workers Paid, so they
  live behind `--env paid`; the default deploy uses Think's workspace bash.
* **Voice is push-to-talk and not streamed.** The bridge waits for the full
  LazyDog turn before speaking; simpler and consistent with other channels,
  slower to first audio.

## Not done / known gaps

* Payments (x402/MPP) were a stretch goal and are not implemented.
* No unlink for channel identities (no API in `agents@0.24`).
* Slack approval buttons: approvals happen in the web UI; Slack/email get a
  message saying approval is pending.
* Voice and the real-model paths need a Cloudflare login to exercise; they are
  type-checked and wired but were not run end to end locally.
