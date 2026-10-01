import { useAgent } from "agents/react";
import { useEffect, useState } from "react";
import type { LazyDogState } from "../shared/types";
import { api, type Me } from "./api";
import { ActivityPanel } from "./components/ActivityPanel";
import { Chat } from "./components/Chat";
import { ChannelsPanel } from "./components/ChannelsPanel";
import { JobsPanel } from "./components/JobsPanel";
import { RemindersPanel } from "./components/RemindersPanel";
import { WebhooksPanel } from "./components/WebhooksPanel";

export function App({ me, onProfileChange }: { me: Me; onProfileChange: (me: Me) => void }) {
  const [state, setState] = useState<LazyDogState | null>(null);
  // The Worker picks the Durable Object from the session cookie; the client
  // never names an instance.
  const agent = useAgent<LazyDogState>({
    agent: "LazyDog",
    basePath: "agent",
    onStateUpdate: setState
  });

  useEffect(() => {
    if (!agent.identified) return;
    void agent.call("setTimezone", [Intl.DateTimeFormat().resolvedOptions().timeZone]);
  }, [agent.identified]);

  const refreshProfile = () => api.me().then(onProfileChange);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">🐕 LazyDog</h1>
          <span className="text-xs text-zinc-500" title="Durable Object name">
            agent {me.profile.userId.slice(0, 12)}… · {agent.readyState === 1 ? "connected" : "connecting"}
          </span>
        </div>
        <form method="post" action="/auth/logout" className="flex items-center gap-3 text-sm">
          <span className="text-zinc-500">@{me.profile.login}</span>
          <button className="text-zinc-500 underline hover:text-zinc-900 dark:hover:text-white">Sign out</button>
        </form>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Chat agent={agent} userId={me.profile.userId} />
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <ActivityPanel events={state?.activity ?? []} onClear={() => agent.call("clearActivity")} />
          <RemindersPanel
            reminders={state?.reminders ?? []}
            timezone={state?.timezone}
            onCancel={(id) => agent.call("cancelReminderFromUi", [id])}
          />
          <JobsPanel
            jobs={state?.jobs ?? []}
            onStart={(topic, crashAfter) => agent.call("startResearchJobFromUi", [topic, crashAfter])}
          />
          <ChannelsPanel me={me} state={state} onLinked={refreshProfile} onReconnectNotes={() => agent.call("reconnectNotes")} />
          <WebhooksPanel />
        </aside>
      </div>
    </div>
  );
}
