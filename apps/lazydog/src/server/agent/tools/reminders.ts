import { tool } from "ai";
import { z } from "zod";
import type { ChannelId, ReminderSummary } from "../../../shared/types";

export type ReminderWhen =
  | { kind: "at"; date: Date }
  | { kind: "delay"; seconds: number }
  | { kind: "cron"; cron: string };

export interface ReminderHost {
  scheduleReminder(message: string, when: ReminderWhen): Promise<ReminderSummary>;
  listReminders(): ReminderSummary[];
  cancelReminder(id: string): Promise<boolean>;
  now(): Date;
}

const MAX_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
// Five-field cron; the Agents scheduler interprets it in UTC.
const CRON = /^(\S+\s+){4}\S+$/;

export const reminderInput = z
  .object({
    message: z.string().min(1).max(500).describe("What to remind the user about"),
    at: z
      .string()
      .optional()
      .describe("Absolute time as ISO-8601 with UTC offset, e.g. 2026-09-23T10:00:00-07:00"),
    inSeconds: z.number().int().min(10).optional().describe("Relative delay in seconds"),
    cron: z.string().optional().describe("Recurring five-field cron expression, evaluated in UTC")
  })
  .refine((v) => [v.at, v.inSeconds, v.cron].filter((x) => x !== undefined).length === 1, {
    message: "Provide exactly one of at, inSeconds or cron"
  });

/** Validate a model-supplied schedule before anything is persisted. */
export function parseWhen(input: z.infer<typeof reminderInput>, now: Date): ReminderWhen {
  if (input.cron !== undefined) {
    if (!CRON.test(input.cron.trim())) throw new Error(`Invalid cron expression: ${input.cron}`);
    return { kind: "cron", cron: input.cron.trim() };
  }
  if (input.inSeconds !== undefined) {
    if (input.inSeconds * 1000 > MAX_HORIZON_MS) throw new Error("Reminders are limited to one year ahead");
    return { kind: "delay", seconds: input.inSeconds };
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(input.at!)) {
    throw new Error("`at` must include a UTC offset (e.g. -07:00 or Z)");
  }
  const date = new Date(input.at!);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${input.at}`);
  if (date.getTime() <= now.getTime() + 5_000) throw new Error("That time is in the past");
  if (date.getTime() - now.getTime() > MAX_HORIZON_MS) {
    throw new Error("Reminders are limited to one year ahead");
  }
  return { kind: "at", date };
}

export function createReminderTools(host: ReminderHost) {
  return {
    schedule_reminder: tool({
      description:
        "Schedule a durable reminder. It is persisted in the agent and fires even if nobody is connected; " +
        "the user is notified in web chat and on the channel they asked from.",
      inputSchema: reminderInput,
      execute: async (input) => host.scheduleReminder(input.message, parseWhen(input, host.now()))
    }),
    list_reminders: tool({
      description: "List the user's pending reminders.",
      inputSchema: z.object({}),
      execute: async () => ({ reminders: host.listReminders() })
    }),
    cancel_reminder: tool({
      description: "Cancel a pending reminder by id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ cancelled: await host.cancelReminder(id) })
    })
  };
}

export type ReminderPayload = {
  message: string;
  origin: ChannelId;
  /** Where to also deliver the reminder when it was requested outside web chat. */
  replySurface?: unknown;
};
