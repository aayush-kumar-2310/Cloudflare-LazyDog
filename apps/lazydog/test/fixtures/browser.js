// Test double for the Browser Run binding (Quick Actions), served over RPC.
import { WorkerEntrypoint } from "cloudflare:workers";

const calls = [];

export default class BrowserFixture extends WorkerEntrypoint {
  async quickAction(action, options) {
    calls.push({ action, url: options?.url });
    if (action === "markdown") {
      return Response.json({
        success: true,
        result: `# Fixture page\n\nRendered ${options.url}. Durable execution checkpoints fibers with ctx.stash and resumes in onFiberRecovered.`
      });
    }
    if (action === "links") {
      return Response.json({ success: true, result: [`${new URL(options.url).origin}/agents/`] });
    }
    return Response.json({ success: false, errors: [{ message: `fixture does not implement ${action}` }] }, { status: 501 });
  }
  async __calls() {
    return calls.splice(0);
  }
}
