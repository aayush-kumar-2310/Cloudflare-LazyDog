# Webhooks

`POST /webhook` lets external systems (CI, GitHub, monitoring, your own
scripts) notify a user's LazyDog. It is authenticated, idempotent and durable,
and it is **not** a remote command channel: the payload is data the agent
reads, with a restricted tool set.

## 1. Register a source

In the web app, **Webhooks → Add** a source (e.g. `github-demo`). You get a
source id (`whs_…`) and a secret, shown once. The source belongs to you; any
event it sends goes to your LazyDog.

## 2. Send an event

```http
POST /webhook
Content-Type: application/json
X-LazyDog-Source: whs_4319d3240d0d479b
X-LazyDog-Timestamp: 1790877999
X-LazyDog-Signature: sha256=<hex>

{"id":"evt-123","event":"repository.push","source":"github","payload":{"ref":"main"}}
```

| Field | Rules |
|---|---|
| `event` | required, dotted identifier `^[\w.:-]+$`, ≤100 chars |
| `source` | required, free text ≤100 chars (informational) |
| `payload` | any JSON (shown to the model, truncated at 8 KB) |
| `id` | optional; used for de-duplication. If absent, a hash of the body is used |

**Signature**: `hex(HMAC-SHA256(secret, "<source>.<timestamp>.<raw body>"))`.
Binding the source id and timestamp into the signed bytes means a signature
can't be replayed for another source, another body, or after 5 minutes.

Responses: `202 {accepted, submissionId, status, eventId}`; `401` bad/missing
signature, unknown source, or stale timestamp (identical for all three, so
source ids can't be probed); `400` invalid JSON/schema; `413` body over 64 KB.

### From a terminal

```bash
npm run webhook:send -w apps/lazydog -- --url http://localhost:5173/webhook \
  --source whs_… --secret … --event ci.failed --payload '{"job":"test"}'
```

### From the UI

Each source has **send test**: the server signs a sample `repository.push`
event with that source's secret and sends it through the exact same
verification path.

## What the agent does

1. The Worker verifies the request and looks up the source's owner.
2. `LazyDog.receiveWebhook` calls Think's `runTurn({ mode: "submit" })` with
   `idempotencyKey = webhook:<source>:<eventId>` — the turn is persisted before
   inference, so a provider retry returns `accepted: false` instead of running
   twice, and the turn survives restarts.
3. The turn runs on the `webhook` channel:
   * instructions tell the model the payload is untrusted data, never commands;
   * tools are limited to `ai_search`, `browser_open`, `browser_links`,
     `notes_list_notes`, `notes_get_note`, `notes_create_note`,
     `schedule_reminder`, `list_reminders` — no code execution, no deletion,
     no memory writes, no outbound messages;
   * at most 6 model steps.
4. The result appears in the web transcript ("via webhook") and the activity
   log records receipt, tool calls and the response.
