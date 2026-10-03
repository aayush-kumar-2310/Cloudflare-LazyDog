import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart
} from "@ai-sdk/provider";

/**
 * A deterministic stand-in model for automated tests and offline runs.
 *
 * It exercises the real agent plumbing (tool execution, approvals, channel
 * delivery, persistence) without judging model quality:
 *   - `/tool <name> <json>`  → calls that tool with that input
 *   - `/script [{"tool","input"},…]` → calls the steps in order, one per
 *     model step (step n runs after n tool results have come back), then
 *     reports the results — a deterministic multi-tool agent turn
 *   - after tool results     → reports each result as text
 *   - anything else          → `echo: <text>`
 *
 * Only reachable when both MODEL_PROVIDER=mock and ALLOW_MOCK_MODEL=true.
 */
export function createMockModel(): LanguageModelV4 {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  };

  const toolCall = (toolName: string, input: unknown): LanguageModelV4StreamPart[] => [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call_${crypto.randomUUID().slice(0, 8)}`,
      toolName,
      input: typeof input === "string" ? input : JSON.stringify(input ?? {})
    },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } }
  ];

  const plan = (options: LanguageModelV4CallOptions): LanguageModelV4StreamPart[] => {
    const lastUserIndex = options.prompt.map((m) => m.role).lastIndexOf("user");
    const userText =
      lastUserIndex >= 0 && options.prompt[lastUserIndex].role === "user"
        ? (options.prompt[lastUserIndex].content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("")
            .trim()
        : "";
    const script = /^\/script\s+(\[[\s\S]*\])$/.exec(userText);
    if (script) {
      const steps = JSON.parse(script[1]) as Array<{ tool: string; input?: unknown }>;
      const done = options.prompt
        .slice(lastUserIndex + 1)
        .flatMap((m) => (m.role === "tool" ? m.content.filter((p) => p.type === "tool-result") : [])).length;
      if (done < steps.length) return toolCall(steps[done].tool, steps[done].input);
    }
    const last = options.prompt[options.prompt.length - 1];
    if (last?.role === "tool") {
      const summary = last.content
        .filter((p) => p.type === "tool-result")
        .map((p) => `${p.toolName} → ${JSON.stringify(p.output).slice(0, 400)}`)
        .join("\n");
      return textParts(`Tool results:\n${summary}`, "stop");
    }
    const text =
      last?.role === "user"
        ? last.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")
        : "";
    const command = /^\/tool\s+(\w+)\s*([\s\S]*)$/.exec(text.trim());
    if (command) return toolCall(command[1], command[2].trim() || "{}");
    return textParts(`echo: ${text}`, "stop");
  };

  const textParts = (text: string, reason: "stop"): LanguageModelV4StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: text },
    { type: "text-end", id: "t0" },
    { type: "finish", usage, finishReason: { unified: reason, raw: reason } }
  ];

  return {
    specificationVersion: "v4",
    provider: "lazydog-mock",
    modelId: "scripted",
    supportedUrls: {},
    async doGenerate(options) {
      const text = plan(options)
        .filter((p): p is Extract<LanguageModelV4StreamPart, { type: "text-delta" }> => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: []
      };
    },
    async doStream(options) {
      const parts = plan(options);
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          }
        })
      };
    }
  };
}
