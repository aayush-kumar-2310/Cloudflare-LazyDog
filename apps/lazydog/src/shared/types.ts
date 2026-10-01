/**
 * Types shared by the Worker and the browser client. Keep this file free of
 * runtime imports so both bundles can use it.
 */

/** Surfaces LazyDog can be reached on. Each maps to a Think channel id. */
export type ChannelId = "web" | "voice" | "slack" | "email" | "webhook";

export type ActivityKind =
  | "message"
  | "tool"
  | "response"
  | "approval"
  | "schedule"
  | "delivery"
  | "fiber"
  | "mcp"
  | "recovery"
  | "error";

export type ActivityStatus = "info" | "started" | "ok" | "error" | "pending";

/**
 * One entry in the activity log. Every entry is produced by a real runtime
 * event (a Think lifecycle hook, an observability event, or LazyDog's own
 * channel/schedule code) — never synthesised for display.
 */
export type ActivityEvent = {
  id: string;
  at: number;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  detail?: string;
  channel?: ChannelId;
  durationMs?: number;
};

export type ReminderSummary = {
  id: string;
  message: string;
  /** Epoch seconds of the next run. */
  nextRunAt: number;
  cron?: string;
  origin: ChannelId;
};

export type LinkedIdentity = {
  channelKey: string;
  scope?: string;
  subject: string;
};

export type JobSummary = {
  id: string;
  topic: string;
  status: "running" | "interrupted" | "completed" | "failed";
  steps: string[];
  completed: string[];
  resumes: number;
};

export type LazyDogState = {
  activity: ActivityEvent[];
  reminders: ReminderSummary[];
  jobs: JobSummary[];
  timezone: string;
  mcp: { notes: "connected" | "connecting" | "failed" | "not-configured"; error?: string };
  capabilities: {
    aiSearch: boolean;
    browser: boolean;
    sandbox: boolean;
    slack: boolean;
    email: boolean;
    payments: boolean;
  };
};

export type Profile = {
  userId: string;
  login: string;
  identities: LinkedIdentity[];
};

export type WebhookSourceSummary = {
  id: string;
  name: string;
  createdAt: string;
};

/** Schema documented in docs/WEBHOOKS.md. */
export type WebhookEvent = {
  id?: string;
  event: string;
  source: string;
  payload: unknown;
};
