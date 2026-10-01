import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { useAgent } from "agents/react";
import type { LazyDogState } from "../../shared/types";
import type { UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { ToolPart, type ToolPartShape } from "./ToolPart";
import { VoiceButton } from "./VoiceButton";

type Agent = ReturnType<typeof useAgent<LazyDogState>>;

const EXAMPLES = [
  "Explain Cloudflare durable execution.",
  "Open the Cloudflare Agents documentation and summarize the available tools.",
  "Save this research as a note.",
  "Remind me tomorrow at 10 AM to review this."
];

/** Think stamps the originating channel on the user message's metadata. */
function channelOf(message: UIMessage): string | null {
  const meta = message.metadata as Record<string, unknown> | undefined;
  const value = meta?.channel ?? (meta?.turnMetadata as Record<string, unknown> | undefined)?.channel;
  return typeof value === "string" ? value : null;
}

export function Chat({ agent, userId }: { agent: Agent; userId: string }) {
  const { messages, sendMessage, status, stop, addToolApprovalResponse, clearHistory } = useAgentChat({ agent });
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";
  const send = (text: string) => {
    if (!text.trim() || busy) return;
    void sendMessage({ text });
    setInput("");
  };

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="mx-auto mt-10 max-w-lg space-y-3 text-sm text-zinc-500">
            <p>Ask LazyDog something. It keeps this conversation across web, voice, Slack, email and webhooks.</p>
            <div className="flex flex-col gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  onClick={() => send(example)}
                  className="rounded-md border border-zinc-200 px-3 py-2 text-left hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => {
          const channel = channelOf(message);
          return (
            <div key={message.id} className={message.role === "user" ? "flex justify-end" : ""}>
              <div
                className={
                  message.role === "user"
                    ? "max-w-[85%] rounded-2xl bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "max-w-[95%] space-y-2"
                }
              >
                {channel && channel !== "web" && (
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-60">via {channel}</div>
                )}
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    return message.role === "user" ? (
                      <p key={i} className="whitespace-pre-wrap">{part.text}</p>
                    ) : (
                      <Markdown key={i} text={part.text} />
                    );
                  }
                  if (part.type === "source-url") {
                    return (
                      <a key={i} href={part.url} target="_blank" rel="noreferrer" className="block text-xs text-blue-600 underline">
                        {part.title ?? part.url}
                      </a>
                    );
                  }
                  if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                    return (
                      <ToolPart
                        key={i}
                        part={part as unknown as ToolPartShape}
                        onApprove={(id, approved) => addToolApprovalResponse({ id, approved })}
                      />
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          );
        })}
        {status === "submitted" && <p className="text-sm text-zinc-500">LazyDog is thinking…</p>}
        <div ref={bottom} />
      </div>

      <form
        className="flex items-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <VoiceButton userId={userId} />
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={1}
          placeholder="Message LazyDog…"
          className="max-h-40 min-h-10 flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {busy ? (
          <button type="button" onClick={stop} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
            Stop
          </button>
        ) : (
          <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900" disabled={!input.trim()}>
            Send
          </button>
        )}
        <button
          type="button"
          title="Clear conversation"
          onClick={() => confirm("Clear the whole conversation? This cannot be undone.") && clearHistory()}
          className="rounded-lg px-2 py-2 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
        >
          Clear
        </button>
      </form>
    </section>
  );
}
