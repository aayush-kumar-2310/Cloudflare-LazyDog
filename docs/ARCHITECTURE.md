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
| `browser_open`, `browser_links` | Browser Run Quick Actions (`agents/browser`) | read-only; public http(s) only; paced, with a labelled direct-fetch fallback (below) |
| `run_python` | `@cloudflare/sandbox` container | only when the Sandbox binding exists (`--env paid`) |
| `bash` + file tools | Think workspace (in-isolate, no network) | free-plan code execution fallback |
| `notes_*` | MCP client → notes Worker | every write (`create_note`, `delete_note`) requires approval; reads (`list`, `get`, marked `readOnlyHint`) don't |
| `schedule_reminder`, `list_reminders`, `cancel_reminder` | Agent `schedule()` (DO alarms) | validated: explicit UTC offset, future, ≤1 year |
| `start_research_job` | managed fiber | durable background job (below) |
| `buy_premium_brief` | x402 client → paid MCP server | **always** needs approval; testnet-only payment policy (below) |
| `set_context` | Think Session memory block | not available to webhook turns |

## Payments (x402, testnet)

`Agent → payment tool → human approval → payment provider`:

1. The model calls `buy_premium_brief` ($0.01). The tool has `needsApproval`,
   so the turn pauses and the web UI shows an approval card with the price.
2. On approval, LazyDog calls the paid MCP server (`PremiumMCP`, an
   `McpAgent` wrapped with the SDK's `withX402`, reached over the Agents RPC
   transport inside this Worker) through `withX402Client`.
3. The server answers with x402 payment requirements. The client's
   confirmation callback is `choosePayment`, a machine-side policy: Base
   Sepolia only, Circle test USDC only, our configured recipient only, at most
   $0.05. Anything else is refused and logged.
4. The client signs an EIP-3009 authorization with the agent's testnet key;
   the server verifies and settles it through the public x402 facilitator and
   returns the brief. Every decision lands in the activity log.

Off unless `X402_PAY_TO` and the `X402_PRIVATE_KEY` secret are both set.
Tests run the whole flow against a stub facilitator that rejects every
payment, so nothing can settle. Tradeoff: `withX402` currently supports the
deprecated `McpAgent` server path, not `createMcpHandler`.

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
  state-changing API calls and on agent/voice WebSockets (cookies alone would
  admit other Workers on the same workers.dev subdomain). Sign-in is
  **deny-by-default**: only `ALLOWED_GITHUB_LOGINS`, unless `OPEN_SIGNUP=true`
  — every turn spends the account's AI budget. The dev login exists only with
  `DEV_LOGIN=true` on a loopback host.
* Agents are selected from the session, never the URL. Agent state is
  read-only for clients (`validateStateChange` rejects browser writes, so the
  activity log can't be forged); `@callable` inputs are validated.
* Slack: signing-secret verification with a 5-minute window; only DMs and
  mentions are answered; bot/self messages ignored.
* Email: DKIM/DMARC pass required; auto-replies ignored.
* Webhooks: per-source HMAC over `source.timestamp.body`, 5-minute window,
  64 KB cap, idempotent, restricted tools, 60 authenticated events per source
  per hour — see [WEBHOOKS.md](WEBHOOKS.md).
* Browser: public http(s) only (private, loopback, link-local, CGNAT, decimal
  and hex IPs, `.local`, credentials in URLs are refused); the direct-fetch
  fallback follows redirects by hand and re-checks every hop.
* Notes MCP: per-user capability token `userId.HMAC(secret, userId)`; the
  server derives the user only from a token it can verify. Tokens don't
  expire; rotating `NOTES_MCP_SECRET` (on both Workers) revokes all of them.
* Bookkeeping tables (`ld_inbound`, `ld_deliveries`) keep 30 days.
* Side-effecting tools: every MCP write and every payment needs approval;
  code runs only in a container (paid) or the network-less workspace bash.
  Reminders are not gated (they only notify the user themselves).

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
  LazyDog turn before speaking (capped at 45 s); simpler and consistent with
  other channels, slower to first audio.

## What testing against real services changed

Everything below was found by running LazyDog against real Workers AI,
Browser Run, the Notes MCP server and the voice pipeline on a Workers Free
account (`scripts/chat.mjs` drives the chat protocol from a terminal):

| Finding | Fix |
|---|---|
| The docs' default model (`@cf/moonshotai/kimi-k2.6`, also GLM-5.3, DeepSeek V4) returns **5035: not available on Workers Free**. | Benchmarked free-plan tool-calling models; Qwen 3.8 27B passed 4/4 and is the default (DEPLOY.md). |
| The daily 10,000-neuron allowance runs out after a few dozen agent turns; the raw `4006` error reached the chat. | Provider errors arrive as stream parts (not thrown, so `onChatError` misses them); a stream transform rewrites quota/plan errors into plain messages. |
| Answers were **cut off mid-sentence**: Workers AI applies a small output cap when none is sent. | `maxOutputTokens: 4096` per turn. |
| Browser Run Free allows **one Quick Action every 10 s**; the model fired several and got 429s. | Per-agent pacing gate; if a call would wait >20 s or still gets 429, fall back to a plain HTTP fetch, labelled `via: "direct-fetch"`. |
| gpt-oss occasionally **degenerates into `!!!!…`** (in the answer or the reasoning stream) until the token cap. | Stream transform watches both and stops it via the AI SDK's `stopStream`; default model switched to Qwen. |
| Think's **stream-stall watchdog is off by default**, so a hung stream blocks the user's turn queue on every channel. | `chatStreamStallTimeoutMs = 60_000` (bounded recovery). |
| Voice: the client **stops sending audio when muted**; Flux STT then drops after ~5 s, which ends the call and **cuts off reply playback**. | Push-to-talk gate implemented as a custom `audioInput` that sends silence between presses, so the session stays alive. |
| gpt-oss emits markdown even on the voice channel. | `beforeSynthesize` strips markdown before TTS. |

Verified end to end on real services: streaming chat, browser research,
MCP note create/list, reminder parsing ("tomorrow at 10 AM" → exact UTC
time), durable job crash/resume, Think chat recovery of an interrupted turn,
and voice (Flux STT → LazyDog turn → Aura TTS) using synthesized speech.

## Not done / known gaps

* Payments are x402 on **testnet** only (Base Sepolia test USDC); MPP and
  mainnet are deliberately not wired.
* No unlink for channel identities (no API in `agents@0.24`).
* Slack approval buttons: approvals happen in the web UI; Slack/email get a
  message saying approval is pending.
* AI Search is wired and tested in isolation but the `lazydog-docs` instance
  must be created on the account before the research path returns results.
* Voice was verified with synthesized speech over the real WebSocket protocol,
  not yet with a person holding a microphone in a browser.
* Model quality is limited to Workers Free models; the agent occasionally
  embellishes beyond what a page says.
