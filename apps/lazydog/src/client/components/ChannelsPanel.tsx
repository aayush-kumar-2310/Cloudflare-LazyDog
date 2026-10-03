import { useState } from "react";
import type { LazyDogState } from "../../shared/types";
import { api, type Me } from "../api";
import { Panel } from "./Panel";

const LABEL: Record<string, string> = { web: "GitHub (web)", slack: "Slack", email: "Email" };

/** Linked identities, channel status, and one-time link codes. */
export function ChannelsPanel({
  me,
  state,
  onLinked,
  onReconnectNotes
}: {
  me: Me;
  state: LazyDogState | null;
  onLinked: () => void;
  onReconnectNotes: () => void;
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [seed, setSeed] = useState<string | null>(null);

  const seedSearch = async () => {
    let offset: number | null = 0;
    let uploaded = 0;
    let failed = 0;
    try {
      while (offset !== null) {
        setSeed(`indexing docs… ${uploaded} uploaded`);
        const r = await api.seedSearch(offset);
        uploaded += r.uploaded.length;
        failed += r.failed.length;
        offset = r.nextOffset;
      }
      setSeed(`${uploaded} docs uploaded${failed ? `, ${failed} failed` : ""}; AI Search indexes them in the background.`);
    } catch (error) {
      setSeed((error as Error).message);
    }
  };
  const caps = state?.capabilities;

  return (
    <Panel title="Identity & channels">
      <ul className="space-y-0.5 text-xs">
        {me.profile.identities.map((i) => (
          <li key={`${i.channelKey}:${i.scope}:${i.subject}`}>
            ✅ {LABEL[i.channelKey] ?? i.channelKey}{" "}
            <span className="text-zinc-500">
              {i.scope && i.scope !== "default" ? `${i.scope}/` : ""}
              {i.subject}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-2 grid grid-cols-2 gap-x-2 text-[11px] text-zinc-500">
        <span>Slack: {me.channels.slack ? "configured" : "not configured"}</span>
        <span>Email: {me.channels.email ?? "not configured"}</span>
        <span>AI Search: {caps?.aiSearch ? "on" : "off"}</span>
        <span>Sandbox: {caps?.sandbox ? "on" : "off (free plan)"}</span>
        <span>Payments: {caps?.payments ? "x402 testnet" : "off"}</span>
        <span className="col-span-2">
          Notes MCP: {state?.mcp.notes ?? "…"}
          {state?.mcp.notes === "failed" && (
            <button onClick={onReconnectNotes} className="ml-1 underline">
              retry
            </button>
          )}
          {state?.mcp.error && <span className="block truncate" title={state.mcp.error}>{state.mcp.error}</span>}
        </span>
      </div>

      {me.isAdmin && (
        <div className="mt-2 text-[11px]">
          {me.searchIndex && (
            <span className="block text-zinc-500">
              Docs index:{" "}
              {me.searchIndex.status === "seeding"
                ? `seeding ${me.searchIndex.uploaded}/${me.searchIndex.total || "…"} pages (automatic)`
                : me.searchIndex.status === "ready"
                  ? `ready (${me.searchIndex.uploaded} pages)`
                  : `seeding failed: ${me.searchIndex.error ?? "unknown error"}`}
            </span>
          )}
          <button onClick={seedSearch} className="underline">
            Re-seed AI Search with the Cloudflare Agents docs
          </button>
          {seed && <span className="block text-zinc-500">{seed}</span>}
        </div>
      )}

      <div className="mt-3 space-y-1 text-xs">
        <button
          onClick={() => api.linkCode().then(setCode)}
          className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Link Slack / email
        </button>
        {code && (
          <div className="rounded bg-zinc-100 p-2 dark:bg-zinc-800">
            Send <code className="font-mono font-semibold">link {code.code}</code> to LazyDog as a Slack DM
            {me.channels.email ? ` or an email to ${me.channels.email}` : ""}. Expires{" "}
            {new Date(code.expiresAt).toLocaleTimeString()}.{" "}
            <button onClick={onLinked} className="underline">
              refresh
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
