import { useEffect, useState } from "react";
import type { WebhookSourceSummary } from "../../shared/types";
import { api } from "../api";
import { Panel } from "./Panel";

/** Register signed webhook sources and fire a signed test event. */
export function WebhooksPanel() {
  const [sources, setSources] = useState<WebhookSourceSummary[]>([]);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const load = () => api.webhookSources().then((r) => setSources(r.sources));
  useEffect(() => {
    void load();
  }, []);

  return (
    <Panel title="Webhooks">
      <form
        className="flex gap-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const source = await api.createWebhookSource(name.trim());
          setCreated({ id: source.id, secret: source.secret });
          setName("");
          await load();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="source name, e.g. github-demo"
          className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
        />
        <button className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Add</button>
      </form>

      {created && (
        <div className="mt-2 break-all rounded bg-amber-50 p-2 text-[11px] dark:bg-amber-950/40">
          Secret for <code>{created.id}</code> (shown once):
          <code className="mt-1 block font-mono">{created.secret}</code>
          <span className="mt-1 block text-zinc-500">
            npm run webhook:send -w apps/lazydog -- --url {location.origin}/webhook --source {created.id} --secret …
          </span>
        </div>
      )}

      <ul className="mt-2 space-y-1 text-xs">
        {sources.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2">
            <span>
              <span className="font-medium">{s.name}</span> <span className="font-mono text-zinc-500">{s.id}</span>
            </span>
            <span className="flex gap-2">
              <button
                className="underline"
                onClick={async () => {
                  setStatus("sending…");
                  try {
                    const r = await api.testWebhook(s.id);
                    setStatus(`${r.accepted ? "accepted" : "duplicate"} · event ${r.eventId.slice(0, 18)}`);
                  } catch (error) {
                    setStatus((error as Error).message);
                  }
                }}
              >
                send test
              </button>
              <button
                className="text-zinc-500 underline"
                onClick={() => api.deleteWebhookSource(s.id).then(load)}
              >
                delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {status && <p className="mt-1 text-[11px] text-zinc-500">{status}</p>}
    </Panel>
  );
}
