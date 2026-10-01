import type { ActivityEvent } from "../../shared/types";

export const MAX_ACTIVITY = 150;

export type ActivityInput = Omit<ActivityEvent, "id" | "at"> & { id?: string; at?: number };
/** A later update to an entry recorded earlier under the same id. */
export type ActivityPatch = Partial<Omit<ActivityEvent, "id" | "at">> & { id: string };

/**
 * Insert or update (by id) an activity entry, keeping the log bounded.
 * Updating keeps the original timestamp so a tool call reads as one row that
 * moves from started to ok/error.
 */
export function upsertActivity(
  log: readonly ActivityEvent[],
  input: ActivityInput | ActivityPatch,
  now = Date.now()
): ActivityEvent[] {
  const id = input.id ?? crypto.randomUUID();
  const existing = log.find((e) => e.id === id);
  let event: ActivityEvent;
  if (existing) event = { ...existing, ...input, id, at: existing.at };
  else if ("title" in input && input.title && input.kind && input.status) {
    event = { ...(input as ActivityInput), id, at: (input as ActivityInput).at ?? now };
  } else return [...log]; // a patch for an entry that has already rotated out
  const rest = log.filter((e) => e.id !== id);
  return [...rest, event].slice(-MAX_ACTIVITY);
}

type ObservedEvent = { type: string; payload: Record<string, unknown> };

/**
 * Map Agents SDK diagnostics-channel events to activity entries. Only events
 * that tell the user something about durability or integrations are shown;
 * everything else returns null. Tool calls and turns are recorded from Think
 * lifecycle hooks instead, which carry richer context.
 */
export function activityFromObservability(event: ObservedEvent): ActivityInput | null {
  const p = event.payload;
  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  switch (event.type) {
    case "schedule:execute":
      return { kind: "schedule", status: "info", title: `Scheduled task fired: ${s(p.callback)}` };
    case "schedule:error":
      return { kind: "schedule", status: "error", title: `Scheduled task failed: ${s(p.callback)}`, detail: s(p.error) };
    case "fiber:run:interrupted":
      return { kind: "fiber", status: "error", title: `Durable job interrupted: ${s(p.fiberName)}`, detail: s(p.recoveryReason) };
    case "fiber:recovery:handled":
      return { kind: "recovery", status: "ok", title: `Recovered durable job: ${s(p.fiberName)}`, detail: s(p.status) };
    case "fiber:recovery:failed":
      return { kind: "recovery", status: "error", title: `Recovery failed: ${s(p.fiberName)}`, detail: s(p.error) };
    case "chat:recovery:detected":
      return { kind: "recovery", status: "pending", title: "Interrupted turn detected", detail: `${s(p.recoveryKind)} · attempt ${s(p.attempt)}` };
    case "chat:recovery:completed":
      return { kind: "recovery", status: "ok", title: "Interrupted turn recovered", detail: s(p.recoveryKind) };
    case "chat:recovery:exhausted":
      return { kind: "recovery", status: "error", title: "Turn recovery gave up", detail: s(p.reason) };
    case "chat:stream:stalled":
      return { kind: "recovery", status: "pending", title: "Model stream stalled; recovering" };
    case "mcp:client:connect":
      return p.error
        ? { kind: "mcp", status: "error", title: "MCP connection failed", detail: s(p.error) }
        : { kind: "mcp", status: "ok", title: `MCP connected (${s(p.transport)})`, detail: s(p.url) };
    case "tool:approval":
      return {
        kind: "approval",
        status: p.approved ? "ok" : "error",
        title: p.approved ? "Tool call approved" : "Tool call rejected",
        detail: s(p.toolCallId)
      };
    case "submission:error":
      return { kind: "error", status: "error", title: "Queued turn failed", detail: s(p.error) };
    default:
      return null;
  }
}

/** A short, single-line preview of arbitrary tool input for the activity log. */
export function preview(value: unknown, max = 120): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
