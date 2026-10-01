import type { StreamTextTransform, ToolSet } from "ai";

export const MAX_REPEAT_RUN = 40;
export const STOPPED_NOTE = "\n\n[Stopped: the model started repeating itself. Please ask again.]";

/**
 * Stops a generation that degenerates into one repeated character, in the
 * answer or the reasoning stream (observed from gpt-oss on Workers AI:
 * "!!!!!!…" until the token cap). Uses the AI SDK's
 * `stopStream`, so the turn ends cleanly with a visible note instead of
 * streaming thousands of junk tokens (and speaking them, on voice).
 */
export function repetitionGuard(maxRun = MAX_REPEAT_RUN): StreamTextTransform<ToolSet> {
  return ({ stopStream }) => {
    // Separate counters: a run must not straddle reasoning and answer text.
    const runs = { "text-delta": { last: "", run: 0 }, "reasoning-delta": { last: "", run: 0 } };
    let stopped = false;
    return new TransformStream({
      transform(part, controller) {
        if (stopped) return;
        if (part.type === "text-delta" || part.type === "reasoning-delta") {
          const r = runs[part.type];
          for (const ch of part.text) {
            if (ch === r.last && !/\s/.test(ch)) r.run++;
            else {
              r.last = ch;
              r.run = 1;
            }
          }
          if (r.run > maxRun) {
            stopped = true;
            controller.enqueue({ ...part, text: STOPPED_NOTE });
            stopStream();
            return;
          }
        }
        controller.enqueue(part);
      }
    });
  };
}
