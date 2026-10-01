import type { StreamTextTransform, ToolSet } from "ai";

/**
 * Translate Workers AI failures a user can't act on from a stack trace into
 * plain messages. Returns null for anything unrecognised.
 */
export function friendlyModelError(error: unknown): string | null {
  const text = [
    (error as { message?: string })?.message,
    (error as { responseBody?: string })?.responseBody,
    String((error as { cause?: unknown })?.cause ?? "")
  ].join(" ");
  if (/\b4006\b|daily free allocation/i.test(text)) {
    return "LazyDog has used today's free Workers AI allowance (10,000 neurons). It resets at 00:00 UTC — or switch MODEL_PROVIDER, or upgrade to Workers Paid.";
  }
  if (/\b5035\b|not available on the Workers Free plan/i.test(text)) {
    return "The configured model isn't available on the Workers Free plan. Set MODEL_ID to a free-plan model such as @cf/qwen/qwen3.8-27b.";
  }
  return null;
}

/**
 * Provider failures arrive as `error` parts inside the stream (not thrown),
 * so `onChatError` never sees them. Rewrite recognised ones in the stream.
 */
export function friendlyErrorTransform(): StreamTextTransform<ToolSet> {
  return () =>
    new TransformStream({
      transform(part, controller) {
        if (part.type === "error") {
          const friendly = friendlyModelError(part.error);
          if (friendly) {
            controller.enqueue({ ...part, error: new Error(friendly) });
            return;
          }
        }
        controller.enqueue(part);
      }
    });
}
