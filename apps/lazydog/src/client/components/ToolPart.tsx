import { useState } from "react";

export type ToolPartShape = {
  type: string;
  toolName?: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

type Source = { title: string; url: string; score?: number };

const STATE_LABEL: Record<string, string> = {
  "input-streaming": "preparing",
  "input-available": "running",
  "approval-requested": "needs approval",
  "approval-responded": "approval sent",
  "output-available": "done",
  "output-error": "failed",
  "output-denied": "rejected"
};

function sourcesOf(output: unknown): Source[] {
  const o = output as { ok?: boolean; sources?: Source[] } | undefined;
  return o?.ok && Array.isArray(o.sources) ? o.sources : [];
}

export function ToolPart({
  part,
  onApprove
}: {
  part: ToolPartShape;
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = part.toolName ?? part.type.replace(/^tool-/, "");
  const label = name.startsWith("notes_") ? `MCP notes.${name.slice(6)}` : name;
  const sources = name === "ai_search" ? sourcesOf(part.output) : [];
  const needsApproval = part.state === "approval-requested" && part.approval;

  return (
    <div
      className={`rounded-lg border text-xs ${
        needsApproval
          ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/40"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left">
        <span className="font-mono font-medium">🔧 {label}</span>
        <span className={part.state === "output-error" ? "text-red-600" : "text-zinc-500"}>
          {STATE_LABEL[part.state] ?? part.state}
        </span>
      </button>

      {needsApproval && (
        <div className="space-y-2 border-t border-amber-300 px-3 py-2 dark:border-amber-700">
          <p>LazyDog wants to run this action:</p>
          {name === "buy_premium_brief" && (
            <p className="font-medium">
              💳 Payment: $0.01 in TEST USDC on Base Sepolia (testnet, x402). Policy cap $0.05; no real money.
            </p>
          )}
          <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-white/70 p-2 dark:bg-black/30">
            {JSON.stringify(part.input, null, 2)}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => onApprove(part.approval!.id, true)}
              className="rounded bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500"
            >
              Approve
            </button>
            <button
              onClick={() => onApprove(part.approval!.id, false)}
              className="rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {sources.length > 0 && (
        <ol className="list-decimal space-y-0.5 border-t border-zinc-200 py-1.5 pl-7 pr-3 dark:border-zinc-800">
          {sources.map((s, i) => (
            <li key={i}>
              <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 underline dark:text-blue-400">
                {s.title}
              </a>
              {s.score !== undefined && <span className="text-zinc-400"> · {s.score}</span>}
            </li>
          ))}
        </ol>
      )}

      {open && (
        <div className="space-y-1 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <div className="text-zinc-500">input</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(part.input, null, 2)}</pre>
          {(part.output !== undefined || part.errorText) && (
            <>
              <div className="text-zinc-500">{part.errorText ? "error" : "output"}</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                {part.errorText ?? JSON.stringify(part.output, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
