import type { ActivityEvent } from "../../shared/types";
import { Panel } from "./Panel";

const DOT: Record<ActivityEvent["status"], string> = {
  info: "bg-zinc-400",
  started: "bg-blue-500 animate-pulse",
  ok: "bg-emerald-500",
  error: "bg-red-500",
  pending: "bg-amber-500"
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Live view of the agent's activity log (synced agent state, newest first). */
export function ActivityPanel({ events, onClear }: { events: ActivityEvent[]; onClear: () => void }) {
  return (
    <Panel
      title="Activity"
      action={events.length > 0 ? <button onClick={onClear} className="text-xs text-zinc-500 underline">clear</button> : null}
    >
      {events.length === 0 ? (
        <p className="text-xs text-zinc-500">Tool calls, deliveries, schedules and recoveries appear here as they happen.</p>
      ) : (
        <ol className="max-h-80 space-y-1 overflow-y-auto font-mono text-[11px]">
          {[...events].reverse().map((e) => (
            <li key={e.id} className="flex gap-2" title={e.detail}>
              <span className="shrink-0 text-zinc-400">{time(e.at)}</span>
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[e.status]}`} />
              <span className="min-w-0">
                <span className="font-medium">{e.title}</span>
                {e.channel && e.channel !== "web" && <span className="text-zinc-400"> [{e.channel}]</span>}
                {e.durationMs !== undefined && <span className="text-zinc-400"> {e.durationMs}ms</span>}
                {e.detail && <span className="block truncate text-zinc-500">{e.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
