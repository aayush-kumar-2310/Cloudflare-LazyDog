import {
  Think,
  type ChannelDefinition,
  type ThinkChannels,
  type ThinkSession,
  type ToolCallContext,
  type ToolCallResultContext,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
import type { Sandbox } from "@cloudflare/sandbox";
import { callable, type FiberContext, type FiberRecoveryContext, type Schedule } from "agents";
import { browserMarkdown } from "agents/browser";
import type { ChannelMessageSurface } from "agents/channels";
import { subscribe } from "agents/observability";
import { mintNotesToken } from "@lazydog/shared";
import { generateText, tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import type {
  ChannelId,
  LazyDogState,
  ReminderSummary,
  WebhookEvent
} from "../../shared/types";
import { createChannelHost } from "../channels/host";
import { config, slackConfigured } from "../config";
import {
  activityFromObservability,
  preview,
  upsertActivity,
  type ActivityInput,
  type ActivityPatch
} from "./activity";
import { createModel } from "./model";
import { friendlyErrorTransform, friendlyModelError } from "./model-errors";
import { repetitionGuard } from "./repetition-guard";
import { CHANNEL_INSTRUCTIONS, SOUL } from "./prompts";
import { createMcpServerTools, NOTES_TOOL_PREFIX } from "./tools/notes-mcp";
import {
  createReminderTools,
  type ReminderPayload,
  type ReminderWhen
} from "./tools/reminders";
import {
  aiSearch,
  assertBrowsableUrl,
  BROWSER_INTERVAL_MS,
  createResearchTools,
  htmlToText,
  RateGate,
  safeFetchText,
  withBrowserFallback
} from "./tools/research";
import {
  jobSummary,
  RESEARCH_STEPS,
  runResearchSteps,
  type ResearchSnapshot,
  type ResearchStep
} from "./research-job";
import { unwrapMcpResult } from "./tools/notes-mcp";
import { createSandboxTools } from "./tools/sandbox";

export type InboundChannel = "slack" | "email";

export type InboundMessage = {
  channel: InboundChannel;
  /** ChannelHost dispatch id: stable across provider redeliveries. */
  dispatchId: string;
  text: string;
  actor: string;
  replySurface: ChannelMessageSurface | null;
};

export type WebhookDelivery = {
  sourceId: string;
  sourceName: string;
  eventId: string;
  event: WebhookEvent;
};

const NOTES_SERVER = "notes";
const RESEARCH_FIBER = "research-job";
const MAX_WEBHOOK_PAYLOAD_CHARS = 8_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Tools a webhook-triggered turn may use. Everything else is filtered out. */
export const WEBHOOK_TOOL_ALLOWLIST = new Set([
  "ai_search",
  "browser_open",
  "browser_links",
  `${NOTES_TOOL_PREFIX}list_notes`,
  `${NOTES_TOOL_PREFIX}get_note`,
  `${NOTES_TOOL_PREFIX}create_note`,
  "schedule_reminder",
  "list_reminders"
]);

const textOf = (message: Pick<UIMessage, "parts"> | undefined) =>
  (message?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

type ToolPartLike = { type: string; state?: string; toolName?: string };
const pendingApprovals = (message: Pick<UIMessage, "parts">) =>
  (message.parts as ToolPartLike[])
    .filter((p) => (p.type.startsWith("tool-") || p.type === "dynamic-tool") && p.state === "approval-requested")
    .map((p) => p.toolName ?? p.type.replace(/^tool-/, ""));

async function shortHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Diagnostics-channel subscriptions are isolate-global and outlive a Durable
 * Object instance that is reset or evicted in the same isolate. So there is
 * exactly one subscription per channel per isolate, and it dispatches each
 * event to the *currently live* LazyDog with that name — never to a stale
 * instance captured in a closure.
 */
const liveAgents = new Map<string, WeakRef<LazyDog>>();
let observabilitySubscribed = false;

function ensureObservabilitySubscription() {
  if (observabilitySubscribed) return;
  observabilitySubscribed = true;
  const dispatch = (event: { name?: string; type: string; payload: unknown }) => {
    const agent = event.name ? liveAgents.get(event.name)?.deref() : undefined;
    if (!agent) return;
    const input = activityFromObservability({
      type: event.type,
      payload: (event.payload ?? {}) as Record<string, unknown>
    });
    if (!input) return;
    try {
      agent.record(input);
    } catch {
      // The instance may be mid-reset; observability must never break the agent.
    }
  };
  for (const channel of ["schedule", "fiber", "chat", "mcp", "message"] as const) {
    subscribe(channel, dispatch);
  }
}

/**
 * LazyDog: one durable agent per user.
 *
 * A Think agent on a SQLite-backed Durable Object. Think owns the agentic
 * loop, message persistence, resumable streaming, approvals and turn recovery.
 * LazyDog adds the tools, per-channel policy, the activity log, reminders, and
 * the entry points that every non-web channel (Slack, email, webhooks, voice)
 * uses to reach the same conversation.
 */
export class LazyDog extends Think<Env, LazyDogState> {
  // The client connects via basePath, so it learns its instance name (the
  // user's own id) from this handshake rather than from the URL.
  static options = { sendIdentityOnConnect: true };

  initialState: LazyDogState = {
    activity: [],
    reminders: [],
    jobs: [],
    timezone: "UTC",
    mcp: { notes: "not-configured" },
    capabilities: { aiSearch: false, browser: false, sandbox: false, slack: false, email: false }
  };

  // MCP tools are wrapped explicitly (notes_*) so destructive ones need approval.
  includeMcpTools = false;
  waitForMcpConnections = { timeout: 5_000 };
  maxSteps = 12;
  /** Shared by all browser tool calls on this agent (Workers Free: 1 Quick Action / 10s). */
  #browserGate = new RateGate(BROWSER_INTERVAL_MS);
  // Think disables its stream-stall watchdog by default; a hung model stream
  // (seen intermittently from Workers AI) would then block this user's turn
  // queue on every channel. 60s is above the slowest tool (paced browser call).
  chatStreamStallTimeoutMs = 60_000;
  chatRecovery = {
    maxAttempts: 6,
    terminalMessage: "LazyDog was interrupted and could not finish this reply. Please ask again."
  };

  /**
   * State is written only by the agent itself. Without this, a browser could
   * call `agent.setState()` and, for example, forge activity-log entries.
   */
  validateStateChange(_next: LazyDogState, source: unknown) {
    if (source !== "server") throw new Error("LazyDog state is read-only for clients");
  }

  // ── Model, prompt, channels ────────────────────────────────────────────

  getModel() {
    return createModel(this.env).model;
  }

  configureSession(session: ThinkSession) {
    return session
      .withContext("soul", { provider: { get: async () => SOUL } })
      .withContext("memory", {
        description:
          "Durable facts about the user (preferences, projects, people). Update when you learn something worth remembering across channels.",
        maxTokens: 1_500
      })
      .withCachedPrompt();
  }

  configureChannels(): ThinkChannels {
    // Slack, email and webhook turns arrive through LazyDog's own entry points
    // (receiveInbound / receiveWebhook), not a Think messenger, so they are
    // "custom" channels: Think applies their policy; LazyDog owns delivery.
    const custom = (instructions: string, extra: Partial<ChannelDefinition> = {}): ChannelDefinition => ({
      kind: "custom",
      ingress: { transport: "websocket" },
      instructions,
      ...extra
    });
    return {
      web: { kind: "web", ingress: { transport: "websocket" }, instructions: CHANNEL_INSTRUCTIONS.web },
      voice: {
        kind: "voice",
        ingress: { transport: "voice" },
        instructions: CHANNEL_INSTRUCTIONS.voice,
        maxTurns: 4
      },
      slack: custom(CHANNEL_INSTRUCTIONS.slack),
      email: custom(CHANNEL_INSTRUCTIONS.email),
      webhook: custom(CHANNEL_INSTRUCTIONS.webhook, {
        maxTurns: 6,
        tools: (all: ToolSet) =>
          Object.fromEntries(Object.entries(all).filter(([name]) => WEBHOOK_TOOL_ALLOWLIST.has(name)))
      })
    };
  }

  getTools(): ToolSet {
    const c = config(this.env);
    return {
      ...createResearchTools(this.env, c.aiSearchInstance, this.#browserGate),
      ...createSandboxTools(
        this.env.Sandbox as DurableObjectNamespace<Sandbox> | undefined,
        `py-${this.name}`.toLowerCase()
      ),
      ...createReminderTools({
        scheduleReminder: (message, when) => this.scheduleReminder(message, when),
        listReminders: () => this.reminderSummaries(),
        cancelReminder: (id) => this.cancelReminder(id),
        now: () => new Date()
      }),
      ...this.notesTools(),
      start_research_job: tool({
        description:
          "Start a durable background research job (search → read → summarize → save as a note). " +
          "It checkpoints after every step and survives restarts; the user is notified when it finishes.",
        inputSchema: z.object({ topic: z.string().min(3).max(200) }),
        execute: async ({ topic }) => this.startResearchJob(topic)
      })
    };
  }

  /** The notes server's id is assigned by addMcpServer; resolve it by name. */
  private notesServerId(): string | undefined {
    const servers = this.getMcpServers().servers;
    return Object.keys(servers).find((id) => servers[id].name === NOTES_SERVER);
  }

  private notesTools(): ToolSet {
    const id = this.notesServerId();
    return id ? createMcpServerTools(this.mcp, id) : {};
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS ld_inbound (
      message_id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      reply_surface TEXT,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS ld_deliveries (
      request_id TEXT PRIMARY KEY,
      delivered_at INTEGER NOT NULL
    )`;

    // Delivery bookkeeping only matters while a turn can still be recovered.
    const cutoff = Date.now() - RETENTION_MS;
    this.sql`DELETE FROM ld_inbound WHERE created_at < ${cutoff}`;
    this.sql`DELETE FROM ld_deliveries WHERE delivered_at < ${cutoff}`;

    liveAgents.set(this.name, new WeakRef(this));
    ensureObservabilitySubscription();

    const c = config(this.env);
    this.setState({
      ...this.state,
      capabilities: {
        aiSearch: Boolean(c.aiSearchInstance),
        browser: true,
        sandbox: Boolean(this.env.Sandbox),
        slack: slackConfigured(c),
        email: Boolean(c.emailFrom)
      }
    });
    this.reminderRefresh();
    // Connecting may take a moment; turns wait for it via waitForMcpConnections.
    this.ctx.waitUntil(this.connectNotesServer());
  }

  private async connectNotesServer() {
    const c = config(this.env);
    if (!c.notesMcpUrl || !c.notesMcpSecret) {
      this.setState({ ...this.state, mcp: { notes: "not-configured" } });
      return;
    }
    this.setState({ ...this.state, mcp: { notes: "connecting" } });
    try {
      const token = await mintNotesToken(c.notesMcpSecret, this.name);
      await this.addMcpServer(NOTES_SERVER, c.notesMcpUrl, {
        transport: { headers: { Authorization: `Bearer ${token}` }, type: "streamable-http" }
      });
      this.setState({ ...this.state, mcp: { notes: "connected" } });
    } catch (error) {
      this.setState({ ...this.state, mcp: { notes: "failed", error: (error as Error).message } });
    }
  }

  // ── Activity ───────────────────────────────────────────────────────────

  /** @internal used by the module-level observability dispatcher */
  record(input: ActivityInput | ActivityPatch) {
    this.setState({ ...this.state, activity: upsertActivity(this.state.activity, input) });
  }

  private get channelId(): ChannelId {
    return (this.activeChannel?.channelId ?? "web") as ChannelId;
  }

  beforeTurn(ctx: TurnContext): TurnConfig | void {
    const channel = this.channelId;
    if (!ctx.continuation) {
      const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
      this.record({
        kind: "message",
        status: "info",
        channel,
        title: `Received ${channel} message`,
        detail: preview(textOf(lastUser))
      });
    }
    const now = new Date();
    const tz = this.state.timezone;
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "long"
    }).format(now);
    return {
      // Workers AI applies a small default output cap when none is sent, which
      // cut answers off mid-sentence.
      maxOutputTokens: 4_096,
      experimental_transform: [repetitionGuard(), friendlyErrorTransform()],
      system:
        `${ctx.system}\n\n## Now\nCurrent time: ${local} (${tz}); UTC ${now.toISOString()}.` +
        `\nActive channel: ${channel}.` +
        (this.state.mcp.notes === "connected" ? "" : "\nThe notes MCP server is not connected; say so if asked to use notes.")
    };
  }

  beforeToolCall(ctx: ToolCallContext) {
    const isMcp = ctx.toolName.startsWith(NOTES_TOOL_PREFIX);
    this.record({
      id: `tool:${ctx.toolCallId}`,
      kind: isMcp ? "mcp" : "tool",
      status: "started",
      channel: this.channelId,
      title: isMcp
        ? `Called MCP notes.${ctx.toolName.slice(NOTES_TOOL_PREFIX.length)}`
        : `Called ${ctx.toolName}`,
      detail: preview(ctx.input)
    });
  }

  afterToolCall(ctx: ToolCallResultContext) {
    const output = ctx.success ? (ctx as { output?: unknown }).output : (ctx as { error?: unknown }).error;
    const failed =
      !ctx.success ||
      (typeof output === "object" && output !== null && ("error" in output || (output as { ok?: boolean }).ok === false));
    this.record({
      id: `tool:${ctx.toolCallId}`,
      kind: ctx.toolName.startsWith(NOTES_TOOL_PREFIX) ? "mcp" : "tool",
      status: failed ? "error" : "ok",
      durationMs: Math.round(ctx.durationMs),
      detail: preview(output)
    });
  }

  async onChatResponse(result: { message: UIMessage; requestId: string; status: string; error?: string }) {
    const channel = this.channelId;
    const waiting = pendingApprovals(result.message);
    if (waiting.length) {
      this.record({
        kind: "approval",
        status: "pending",
        channel,
        title: `Waiting for approval: ${waiting.join(", ")}`
      });
    }
    this.record({
      kind: "response",
      status: result.status === "completed" ? "ok" : "error",
      channel,
      title: result.status === "completed" ? "Generated response" : `Response ${result.status}`,
      detail: preview(result.error ?? textOf(result.message))
    });
    await this.deliverToOrigin(result, waiting);
  }

  onChatError(error: unknown) {
    const friendly = friendlyModelError(error);
    if (!friendly) return error;
    this.record({ kind: "error", status: "error", channel: this.channelId, title: "Model unavailable", detail: friendly });
    return new Error(friendly);
  }

  // ── Channel entry points (called over RPC by the Worker) ──────────────

  /** Slack / email: accept durably and return before inference runs. */
  async receiveInbound(input: InboundMessage) {
    const messageId = `in_${input.channel}_${await shortHash(input.dispatchId)}`;
    this.sql`INSERT OR IGNORE INTO ld_inbound (message_id, channel, reply_surface, created_at)
      VALUES (${messageId}, ${input.channel}, ${input.replySurface ? JSON.stringify(input.replySurface) : null}, ${Date.now()})`;
    const submission = await this.runTurn({
      mode: "submit",
      channel: input.channel,
      idempotencyKey: `inbound:${input.dispatchId}`,
      input: {
        id: messageId,
        role: "user",
        parts: [{ type: "text", text: input.text }]
      }
    });
    if (submission.accepted) {
      this.record({
        kind: "delivery",
        status: "info",
        channel: input.channel,
        title: `Accepted ${input.channel} message from ${input.actor}`
      });
    }
    return { accepted: submission.accepted, submissionId: submission.submissionId };
  }

  /** Verified webhook event → a durable, idempotent turn with a restricted tool set. */
  async receiveWebhook(delivery: WebhookDelivery) {
    const payload = JSON.stringify(delivery.event.payload ?? null, null, 2);
    const body = payload.length > MAX_WEBHOOK_PAYLOAD_CHARS
      ? `${payload.slice(0, MAX_WEBHOOK_PAYLOAD_CHARS)}\n… (truncated)`
      : payload;
    const submission = await this.runTurn({
      mode: "submit",
      channel: "webhook",
      idempotencyKey: `webhook:${delivery.sourceId}:${delivery.eventId}`,
      input: {
        id: `wh_${await shortHash(`${delivery.sourceId}:${delivery.eventId}`)}`,
        role: "user",
        parts: [
          {
            type: "text",
            text:
              `Webhook event "${delivery.event.event}" from source "${delivery.event.source}" ` +
              `(registered as "${delivery.sourceName}"). Untrusted payload:\n\`\`\`json\n${body}\n\`\`\``
          }
        ]
      }
    });
    this.record({
      kind: "delivery",
      status: submission.accepted ? "info" : "ok",
      channel: "webhook",
      title: submission.accepted
        ? `Webhook ${delivery.event.event} accepted`
        : `Duplicate webhook ${delivery.event.event} ignored`,
      detail: `${delivery.sourceName} · ${delivery.eventId}`
    });
    return {
      accepted: submission.accepted,
      submissionId: submission.submissionId,
      status: submission.status
    };
  }

  /** Voice: the VoiceBridge transcribes, this runs the turn, the bridge speaks the reply. */
  async voiceTurn(transcript: string): Promise<string> {
    const result = await this.runTurn({ input: transcript, channel: "voice" });
    return textOf(result.message as UIMessage | undefined) || "Sorry, I have no answer for that.";
  }

  private async deliverToOrigin(
    result: { message: UIMessage; requestId: string; status: string; error?: string },
    waiting: string[]
  ) {
    const index = this.messages.findIndex((m) => m.id === result.message.id);
    const before = index >= 0 ? this.messages.slice(0, index) : this.messages;
    const userMessage = [...before].reverse().find((m) => m.role === "user");
    if (!userMessage) return;
    const row = this.sql<{ channel: string; reply_surface: string | null }>`
      SELECT channel, reply_surface FROM ld_inbound WHERE message_id = ${userMessage.id}`[0];
    if (!row?.reply_surface) return;

    // One delivery per turn, even if the hook runs again after recovery.
    const fresh = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM ld_deliveries WHERE request_id = ${result.requestId}`[0].n === 0;
    if (!fresh) return;
    this.sql`INSERT INTO ld_deliveries (request_id, delivered_at) VALUES (${result.requestId}, ${Date.now()})`;

    let markdown = textOf(result.message);
    if (waiting.length) {
      markdown = `${markdown}\n\n⏸ I need your approval to run ${waiting.join(", ")}. Open the LazyDog web app to approve or reject it.`.trim();
    }
    if (result.status !== "completed") markdown ||= "Sorry — I couldn't complete that request.";
    if (!markdown) return;

    const delivery = await createChannelHost(this.env).deliver(
      JSON.parse(row.reply_surface) as ChannelMessageSurface,
      { markdown },
      { delivery: { deliveryId: result.requestId } }
    );
    this.record({
      kind: "delivery",
      status: delivery.status === "delivered" ? "ok" : "error",
      channel: row.channel as ChannelId,
      title: `Replied on ${row.channel}`,
      detail: delivery.status === "delivered" ? undefined : `${delivery.status}: ${delivery.error.message}`
    });
  }

  // ── Reminders (durable Agent schedules) ────────────────────────────────

  private currentReplySurface(): unknown {
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return undefined;
    const row = this.sql<{ reply_surface: string | null }>`
      SELECT reply_surface FROM ld_inbound WHERE message_id = ${lastUser.id}`[0];
    return row?.reply_surface ? JSON.parse(row.reply_surface) : undefined;
  }

  async scheduleReminder(message: string, when: ReminderWhen): Promise<ReminderSummary> {
    const payload: ReminderPayload = {
      message,
      origin: this.channelId,
      replySurface: this.currentReplySurface()
    };
    const at = when.kind === "at" ? when.date : when.kind === "delay" ? when.seconds : when.cron;
    const schedule = await this.schedule(at, "onReminder", payload);
    this.reminderRefresh();
    const summary = this.toReminderSummary(schedule);
    this.record({
      kind: "schedule",
      status: "ok",
      channel: payload.origin,
      title: "Scheduled reminder",
      detail: `${new Date(summary.nextRunAt * 1000).toISOString()} · ${preview(message, 60)}`
    });
    return summary;
  }

  async onReminder(payload: ReminderPayload, schedule: Schedule<ReminderPayload>) {
    this.record({
      kind: "schedule",
      status: "info",
      channel: payload.origin,
      title: "Reminder fired",
      detail: preview(payload.message)
    });
    await this.deliverNotice(`⏰ Reminder: ${payload.message}`, { channel: "web", informModel: true });
    if (payload.replySurface) {
      const result = await createChannelHost(this.env).deliver(
        payload.replySurface as ChannelMessageSurface,
        { title: "LazyDog reminder", markdown: `⏰ Reminder: ${payload.message}` },
        { delivery: { deliveryId: `reminder:${schedule.id}:${schedule.time}` } }
      );
      this.record({
        kind: "delivery",
        status: result.status === "delivered" ? "ok" : "error",
        channel: payload.origin,
        title: `Reminder sent on ${payload.origin}`
      });
    }
    this.reminderRefresh(schedule);
  }

  private toReminderSummary(s: Schedule<ReminderPayload>): ReminderSummary {
    return {
      id: s.id,
      message: s.payload.message,
      nextRunAt: s.time,
      cron: s.type === "cron" ? s.cron : undefined,
      origin: s.payload.origin
    };
  }

  /** @param firing a one-shot schedule whose callback is running now (its row is removed only afterwards) */
  private reminderSummaries(firing?: Schedule<ReminderPayload>): ReminderSummary[] {
    return this.getSchedules<ReminderPayload>()
      .filter((s) => s.callback === "onReminder")
      .filter((s) => !(firing && s.id === firing.id && firing.type !== "cron"))
      .map((s) => this.toReminderSummary(s))
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  private reminderRefresh(firing?: Schedule<ReminderPayload>) {
    this.setState({ ...this.state, reminders: this.reminderSummaries(firing) });
  }

  async cancelReminder(id: string): Promise<boolean> {
    const schedule = this.getSchedules<ReminderPayload>().find((s) => s.id === id && s.callback === "onReminder");
    if (!schedule) return false;
    const cancelled = await this.cancelSchedule(id);
    this.reminderRefresh();
    if (cancelled) this.record({ kind: "schedule", status: "ok", title: "Cancelled reminder", detail: preview(schedule.payload.message) });
    return cancelled;
  }

  // ── Durable research job (fibers) ─────────────────────────────────────

  /**
   * A multi-step background job that runs in a managed fiber. Each step's
   * result is checkpointed to SQLite before the next begins, so if the
   * Durable Object is evicted or crashes mid-job, `onFiberRecovered` resumes
   * from the last checkpoint instead of starting over.
   */
  async startResearchJob(topic: string, options: { crashAfter?: ResearchStep } = {}) {
    const snapshot: ResearchSnapshot = {
      jobId: `job_${crypto.randomUUID().slice(0, 8)}`,
      topic,
      completed: [],
      results: {},
      crashAfter: options.crashAfter,
      resumes: 0
    };
    this.upsertJob(jobSummary(snapshot, "running"));
    this.record({ kind: "fiber", status: "started", title: `Durable job started: ${topic}`, detail: snapshot.jobId });
    const receipt = await this.startFiber(RESEARCH_FIBER, (ctx) => this.runResearchJob(ctx, snapshot), {
      metadata: { jobId: snapshot.jobId, topic }
    });
    return { jobId: snapshot.jobId, fiberId: receipt.fiberId, status: "started" };
  }

  private async runResearchJob(ctx: FiberContext, start: ResearchSnapshot) {
    ctx.stash(start);
    const done = await runResearchSteps(start, {
      execute: (step, snapshot) => this.executeResearchStep(step, snapshot),
      checkpoint: (snapshot) => {
        ctx.stash(snapshot);
        this.upsertJob(jobSummary(snapshot, "running"));
      },
      onStep: (step, status, detail) =>
        this.record({
          id: `job:${start.jobId}:${step}:${start.resumes}`,
          kind: "fiber",
          status,
          title: `Job step: ${step}`,
          detail: detail ?? start.topic
        }),
      crash: () => {
        this.record({ kind: "fiber", status: "error", title: "Simulated crash: aborting Durable Object", detail: start.jobId });
        // Abort a moment later so the request that started the job can return;
        // the job stays parked here until the object dies.
        setTimeout(() => this.ctx.abort("LazyDog demo: simulated crash mid-job"), 500);
        return new Promise<never>(() => {});
      }
    });
    const summary = String(done.results.summarize ?? "").slice(0, 1_500);
    this.upsertJob(jobSummary(done, "completed"));
    this.record({ kind: "fiber", status: "ok", title: `Durable job completed: ${done.topic}`, detail: done.jobId });
    await this.deliverNotice(
      `Research job "${done.topic}" finished${done.resumes ? ` (resumed ${done.resumes}× after interruption)` : ""}.\n\n${summary}`,
      { channel: "web", informModel: true }
    );
  }

  private async executeResearchStep(step: ResearchStep, s: ResearchSnapshot): Promise<unknown> {
    const c = config(this.env);
    switch (step) {
      case "search": {
        const result = await aiSearch(this.env.AI_SEARCH, c.aiSearchInstance, s.topic, 4);
        if (!result.ok) throw new Error(result.error);
        return result.sources.map(({ title, url, snippet }) => ({ title, url, snippet: snippet.slice(0, 400) }));
      }
      case "read": {
        const sources = Array.isArray(s.results.search) ? (s.results.search as { url: string }[]) : [];
        const raw = sources.find((x) => /^https?:/.test(x.url))?.url;
        if (!raw) throw new Error("no source URL to read");
        const url = assertBrowsableUrl(raw).toString();
        const { value, via } = await withBrowserFallback(
          this.#browserGate,
          () => browserMarkdown(this.env.BROWSER, { url }),
          async () => htmlToText(await safeFetchText(new URL(url)))
        );
        return { url, via, markdown: value.slice(0, 6_000) };
      }
      case "summarize": {
        const { text } = await generateText({
          model: this.getModel(),
          system: "Write a concise research brief (under 200 words) with bullet points and source URLs. Use only the material given.",
          prompt: `Topic: ${s.topic}\n\nSearch results:\n${JSON.stringify(s.results.search ?? "none")}\n\nPage:\n${JSON.stringify(s.results.read ?? "none")}`
        });
        return text;
      }
      case "save": {
        const content = String(s.results.summarize ?? "");
        // After a restart, recovery can run before MCP connections are restored.
        await this.mcp.waitForConnections({ timeout: 5_000 });
        const notesId = this.state.mcp.notes === "failed" ? undefined : this.notesServerId();
        if (notesId) {
          return unwrapMcpResult(
            await this.mcp.callTool({
              serverId: notesId,
              name: "create_note",
              arguments: { title: `Research: ${s.topic}`, content }
            })
          );
        }
        const path = `/research/${s.jobId}.md`;
        await this.workspace.writeFile(path, `# ${s.topic}\n\n${content}\n`);
        return { savedTo: `workspace:${path}` };
      }
    }
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== RESEARCH_FIBER) return super.onFiberRecovered(ctx);
    const snapshot = ctx.snapshot as ResearchSnapshot | null;
    if (!snapshot) return { status: "error" as const, error: "no checkpoint" };

    const resumed: ResearchSnapshot = { ...snapshot, crashAfter: undefined, resumes: snapshot.resumes + 1 };
    this.upsertJob(jobSummary(resumed, "running"));
    this.record({
      kind: "recovery",
      status: "ok",
      title: `Resuming durable job after interruption`,
      detail: `${snapshot.topic} · done: ${snapshot.completed.join(", ") || "nothing"}`
    });
    await this.startFiber(RESEARCH_FIBER, (fiber) => this.runResearchJob(fiber, resumed), {
      metadata: { jobId: snapshot.jobId, topic: snapshot.topic, resumedFrom: ctx.id }
    });
    // The interrupted run is settled; its continuation is the new fiber.
    return { status: "completed" as const, snapshot: { ...snapshot, handedOffTo: "resumed-fiber" } };
  }

  private upsertJob(job: ReturnType<typeof jobSummary>) {
    const jobs = [...this.state.jobs.filter((j) => j.id !== job.id), job].slice(-10);
    this.setState({ ...this.state, jobs });
  }

  // ── Client-callable methods ────────────────────────────────────────────

  @callable()
  setTimezone(timezone: unknown) {
    if (typeof timezone !== "string" || timezone.length > 64) return { ok: false as const };
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return { ok: false as const };
    }
    if (timezone !== this.state.timezone) this.setState({ ...this.state, timezone });
    return { ok: true as const };
  }

  @callable()
  cancelReminderFromUi(id: unknown) {
    return typeof id === "string" ? this.cancelReminder(id) : false;
  }

  /** Demo control for the durability walkthrough: optionally crash after a step. */
  @callable()
  startResearchJobFromUi(topic: unknown, crashAfter?: unknown) {
    if (typeof topic !== "string" || topic.trim().length < 3 || topic.length > 200) {
      throw new Error("topic must be 3–200 characters");
    }
    if (crashAfter !== undefined && !RESEARCH_STEPS.includes(crashAfter as ResearchStep)) {
      throw new Error(`crashAfter must be one of ${RESEARCH_STEPS.join(", ")}`);
    }
    return this.startResearchJob(topic.trim(), { crashAfter: crashAfter as ResearchStep | undefined });
  }

  @callable()
  clearActivity() {
    this.setState({ ...this.state, activity: [] });
  }

  @callable()
  reconnectNotes() {
    return this.connectNotesServer();
  }
}

