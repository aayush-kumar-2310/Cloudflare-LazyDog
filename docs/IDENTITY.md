# Identity: one person, one LazyDog, every channel

LazyDog's central promise is that the *same* durable agent — same conversation,
memory, notes, reminders and activity log — answers a person whether they use
web chat, voice, Slack, email or a webhook. This document explains how a
message on any channel is mapped to that agent, and why it is done this way.

## The model

```
               ┌──────────────── IdentityRegistry (1 Durable Object) ────────────────┐
               │  users:            usr_8f…  login=octocat                            │
               │  channel identity  ─────────────────────────────►  user             │
               │  web    github/583231                              usr_8f…          │
               │  slack  T024BE7LD/U0G9QF9C6                         usr_8f…          │
               │  email  default/octocat@example.org                 usr_8f…          │
               │  webhook sources:  whs_3c… (secret) ──────────────► usr_8f…          │
               └──────────────────────────────────────────────────────────────────────┘
                                                │ userId
                                                ▼
                               LazyDog Durable Object named "usr_8f…"
```

* **LazyDog user id** (`usr_…`): an opaque id created on first sign-in. It is
  also the **name of the user's LazyDog Durable Object**, so "which agent?" and
  "which user?" are the same question.
* **Channel identity**: `{ channelKey, scope, subject }` — the shape used by
  `agents/channels`. `scope` namespaces the subject (a GitHub account, a Slack
  workspace, …), so `U0G9QF9C6` in workspace A is never confused with the same
  id in workspace B.
* **Links** are stored with the Agents SDK's `createUserIdentityStore` over the
  registry's SQLite. A link is only ever created by an explicit action; the
  store never infers that two identities are the same person from names or
  email-looking strings.

## Per channel

| Channel | Who is speaking? | How it maps to a user | Trust anchor |
|---|---|---|---|
| **Web chat** | GitHub account | Sign-in creates/looks up `web/github/<githubId>` → user. A signed, HttpOnly session cookie carries the user id. | GitHub OAuth + HMAC-signed session |
| **Voice** | The signed-in web user | Same session. The voice bridge for a user is named after the user id and the Worker refuses any other name. | Session cookie |
| **Slack** | Slack user in a workspace | `slack/<team_id>/<user_id>` → user, **after** the user links it with a one-time code. | Slack request signature (signing secret, 5-min window) |
| **Email** | Sender address | `email/default/<from>` → user, after linking. Mail without a DKIM or DMARC pass is dropped. | Email Routing auth results |
| **Webhooks** | A registered *source* | Each source belongs to exactly one user. The body never chooses the user. | Per-source HMAC secret + timestamp |

### Linking Slack or email

1. Signed in on the web, the user clicks **Link Slack / email** and receives a
   code like `K7QX-3M2P` (32-character alphabet, 8 characters, 10-minute
   lifetime, single use, stored only as a SHA-256 hash).
2. They send `link K7QX-3M2P` to LazyDog as a Slack DM or an email.
3. The Worker verifies the provider signature, then calls
   `IdentityRegistry.redeemLinkCode(code, identity)` with the identity that the
   *verified* event carried.
4. From then on, messages from that identity route to the user's LazyDog.

Guards:

* **Brute force**: 5 attempts per channel identity per 10 minutes.
* **Hijack**: an identity already linked to a different user cannot be
  re-linked (`already-linked`); the existing link wins.
* **Unknown senders** get onboarding instructions and nothing else. No agent
  is created for them, so a stranger cannot spend your model budget.

### Why routing happens before the agent

The Worker resolves the user *before* any Durable Object is touched. A request
cannot name the agent it wants: the web client connects to `/agent` and the
Worker picks the instance from the session; Slack/email are routed by
`ChannelHost` using `routes`-style resolution against the registry; webhooks
are routed by their registered source. A forged URL, header or payload field
never selects an agent.

## One conversation, many channels

All channels feed the **same Think session**. Each turn is stamped with its
channel (`metadata.channel` on the user message), which:

* applies per-channel policy (`configureChannels`): voice answers in short
  spoken sentences; webhook turns get a restricted tool allowlist and are told
  the payload is untrusted data;
* lets the web UI show "via slack / via email / via webhook" badges;
* tells LazyDog where to deliver the reply: Slack and email replies go back to
  the exact reply surface recorded when the message arrived (looked up by the
  inbound message id, so a reply after a tool approval or a crash recovery
  still goes to the right place).

Example: ask in Slack *"remind me at 5pm to call Sam"* → the reminder is a
durable schedule on the user's LazyDog; at 5pm it appears in web chat **and**
is posted back to the Slack DM it came from.

## Tradeoffs and limits

* **Single registry instance.** One global Durable Object keeps the logic
  simple and transactional. At scale it would be sharded by identity key
  (lookups) with user records co-located with the user's LazyDog.
* **No unlink yet.** `UserIdentityStore` has no unlink operation in
  `agents@0.24`; unlinking would need a registry-side tombstone table.
* **Email trust is only as good as DKIM/DMARC.** Domains without DMARC can't
  reach LazyDog by email; that is deliberate.
* **Shared context is a feature and a risk.** Because Slack, email and web are
  one conversation, anything said on one channel is visible to the model on
  the others. Webhook content is fenced as untrusted data and cannot reach
  code execution, deletion, or memory writes; a note it proposes is only saved
  after you approve it in the web app.
* **Sessions are stateless cookies** (7 days). Revoking one before expiry
  would need a server-side session list; rotating `SESSION_SECRET` revokes all.
