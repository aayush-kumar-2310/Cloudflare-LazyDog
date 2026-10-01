import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

const MAX_OUTPUT_CHARS = 8_000;
const RUN_TIMEOUT_MS = 30_000;

const clip = (text: string) =>
  text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [${text.length - MAX_OUTPUT_CHARS} more chars]`
    : text;

/**
 * `run_python` executes model-written code in a Cloudflare Sandbox container,
 * never in the agent's own isolate. Each user gets one sandbox, so files
 * written in one call are visible in the next.
 *
 * Returns an empty tool set when the Sandbox binding is absent (free plan);
 * the agent then only has Think's in-isolate `bash` workspace tool.
 */
export function createSandboxTools(
  binding: DurableObjectNamespace<Sandbox> | undefined,
  sandboxId: string
): ToolSet {
  if (!binding) return {};
  return {
    run_python: tool({
      description:
        "Run a Python 3 script in an isolated Cloudflare Sandbox container and return stdout, stderr and the exit code. " +
        "Use for calculations, data processing, or checking code. State persists between calls in /workspace.",
      inputSchema: z.object({
        code: z.string().min(1).max(100_000).describe("Complete Python 3 source to run")
      }),
      execute: async ({ code }) => {
        const sandbox = getSandbox(binding, sandboxId);
        const path = `/workspace/run_${Date.now()}.py`;
        await sandbox.writeFile(path, code);
        const result = await sandbox.exec(`python3 ${path}`, { timeout: RUN_TIMEOUT_MS });
        return {
          exitCode: result.exitCode,
          success: result.success,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr)
        };
      }
    })
  };
}
