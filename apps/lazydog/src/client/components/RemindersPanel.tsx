import type { ReminderSummary } from "../../shared/types";
import { Panel } from "./Panel";

export function RemindersPanel({
  reminders,
  timezone,
  onCancel
}: {
  reminders: ReminderSummary[];
  timezone?: string;
  onCancel: (id: string) => void;
}) {
  return (
    <Panel title="Scheduled reminders">
      {reminders.length === 0 ? (
        <p className="text-xs text-zinc-500">None. Try “remind me in 2 minutes to stretch”.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {reminders.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-2">
              <span>
                <span className="font-medium">{r.message}</span>
                <span className="block text-zinc-500">
                  {new Date(r.nextRunAt * 1000).toLocaleString([], { timeZone: timezone })}
                  {r.cron && ` · cron ${r.cron} (UTC)`} · from {r.origin}
                </span>
              </span>
              <button onClick={() => onCancel(r.id)} className="text-zinc-500 underline">
                cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
