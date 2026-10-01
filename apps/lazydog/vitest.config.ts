import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

// Stub for Slack's Web API: every outbound fetch from the Worker lands here.
// Tests read what LazyDog posted via GET https://slack-mock.test/__calls.
const slackCalls: Array<{ method: string; body: unknown }> = [];
async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "slack-mock.test" && url.pathname === "/__calls") {
    return Response.json(slackCalls.splice(0));
  }
  if (url.hostname === "slack.com" && url.pathname.startsWith("/api/")) {
    const method = url.pathname.slice("/api/".length);
    const text = await request.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = Object.fromEntries(new URLSearchParams(text));
    }
    slackCalls.push({ method, body });
    return Response.json({ ok: true, ts: `${Date.now() / 1000}`, channel: "D1", stream_id: "s1" });
  }
  return new Response(`unexpected outbound fetch in tests: ${request.url}`, { status: 599 });
}

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never touch real Cloudflare services.
      remoteBindings: false,
      miniflare: {
        outboundService: outbound,
        bindings: {
          MODEL_PROVIDER: "mock",
          ALLOW_MOCK_MODEL: "true",
          SESSION_SECRET: "test-session-secret",
          NOTES_MCP_URL: "",
          AI_SEARCH_INSTANCE: "",
          NOTES_MCP_SECRET: "",
          SLACK_BOT_TOKEN: "xoxb-test",
          SLACK_SIGNING_SECRET: "slack-test-secret",
          SLACK_BOT_USER_ID: "UBOT",
          DEV_LOGIN: "false",
          EMAIL_FROM: "lazydog@example.com",
          PUBLIC_URL: "https://lazydog.test"
        }
      }
    })
  ],
  test: { testTimeout: 60_000, hookTimeout: 60_000 }
});
