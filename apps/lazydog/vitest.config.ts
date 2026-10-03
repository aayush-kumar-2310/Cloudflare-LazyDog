import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { buildSync } from "esbuild";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

const here = import.meta.dirname;
// Bundle the real Notes MCP Worker so LazyDog's MCP client talks to it over HTTP in tests.
const notesBundle = path.join(here, ".wrangler/test/notes-mcp.mjs");
buildSync({
  entryPoints: [path.join(here, "test/fixtures/notes-worker.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  outfile: notesBundle,
  define: {
    NOTES_SCHEMA: JSON.stringify(readFileSync(path.join(here, "../notes-mcp/migrations/0001_init.sql"), "utf8"))
  },
  logLevel: "error"
});
export const TEST_NOTES_SECRET = "test-notes-secret";

// The test pool uses wrangler.jsonc minus the remote-only AI Search and
// Browser Run bindings, which in-process fixtures (service bindings) replace. Derived at load
// time, so it can't drift from the real config.
const realConfig = JSON.parse(
  readFileSync(path.join(here, "wrangler.jsonc"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1")
);
delete realConfig.ai_search_namespaces;
delete realConfig.browser;
delete realConfig.$schema;
realConfig.main = path.join(here, realConfig.main);
const testConfigPath = path.join(here, ".wrangler/test/wrangler.test.json");
mkdirSync(path.dirname(testConfigPath), { recursive: true });
writeFileSync(testConfigPath, JSON.stringify(realConfig, null, 2));

// Stub for Slack's Web API: every outbound fetch from the Worker lands here.
// Tests read what LazyDog posted via GET https://slack-mock.test/__calls.
const slackCalls: Array<{ method: string; body: unknown }> = [];
const facilitatorCalls: unknown[] = [];
async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // A three-page miniature of the Cloudflare Agents docs for the seeding tests.
  if (url.hostname === "developers.cloudflare.com" && url.pathname === "/agents/llms.txt") {
    return new Response(
      ["harnesses/think", "runtime/execution/durable-execution", "runtime/execution/schedule-tasks"]
        .map((p) => `- https://developers.cloudflare.com/agents/${p}/index.md`)
        .join("\n")
    );
  }
  if (url.hostname === "developers.cloudflare.com" && url.pathname.endsWith("/index.md")) {
    const slug = url.pathname.split("/").at(-2);
    return new Response(`---\ntitle: ${slug}\n---\n\n# ${slug}\n\nFixture body for ${slug}.\n\nWas this helpful?\n`);
  }
  // x402 facilitator stub: advertises Base Sepolia "exact" (as the real one
  // does) and rejects every payment at /verify, so nothing can ever settle.
  if (url.hostname === "x402.org" && url.pathname === "/facilitator/supported") {
    return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
  }
  if (url.hostname === "x402.org" && url.pathname === "/facilitator/verify") {
    facilitatorCalls.push(JSON.parse(await request.text()));
    return Response.json({ isValid: false, invalidReason: "test_facilitator_rejects_all" });
  }
  if (url.hostname === "slack-mock.test" && url.pathname === "/__facilitator") {
    return Response.json(facilitatorCalls.splice(0));
  }
  // Public test pages for the browser fallback: one redirects to a local address.
  if (url.hostname === "redirect.example.com") {
    return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:8788/mcp" } });
  }
  if (url.hostname === "page.example.com") {
    return new Response("<h1>Public page</h1><p>Hello.</p>", { headers: { "Content-Type": "text/html" } });
  }
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
      wrangler: { configPath: testConfigPath },
      // Tests never touch real Cloudflare services.
      remoteBindings: false,
      miniflare: {
        // All outbound fetches go through the router: notes.test → the real
        // Notes MCP Worker; everything else → the stubs in `outbound` below.
        outboundService: "router",
        serviceBindings: { AI_SEARCH: "ai-search-fixture", BROWSER: "browser-fixture" },
        workers: [
          {
            name: "router",
            modules: true,
            script: `export default { fetch(req, env) {
              return new URL(req.url).hostname === "notes.test" ? env.NOTES.fetch(req) : fetch(req);
            } };`,
            compatibilityDate: "2026-08-22",
            serviceBindings: { NOTES: "notes-mcp" },
            outboundService: outbound
          },
          {
            name: "notes-mcp",
            modules: true,
            scriptPath: notesBundle,
            compatibilityDate: "2026-08-22",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: ["NOTES_DB"],
            bindings: { NOTES_MCP_SECRET: TEST_NOTES_SECRET }
          },
          {
            name: "browser-fixture",
            modules: true,
            scriptPath: path.join(here, "test/fixtures/browser.js"),
            compatibilityDate: "2026-08-22"
          },
          {
            name: "ai-search-fixture",
            modules: true,
            scriptPath: path.join(here, "test/fixtures/ai-search.js"),
            compatibilityDate: "2026-08-22"
          }
        ],
        bindings: {
          MODEL_PROVIDER: "mock",
          ALLOW_MOCK_MODEL: "true",
          SESSION_SECRET: "test-session-secret",
          NOTES_MCP_URL: "https://notes.test/mcp",
          AI_SEARCH_INSTANCE: "lazydog-docs",
          NOTES_MCP_SECRET: TEST_NOTES_SECRET,
          SLACK_BOT_TOKEN: "xoxb-test",
          SLACK_SIGNING_SECRET: "slack-test-secret",
          SLACK_BOT_USER_ID: "UBOT",
          DEV_LOGIN: "false",
          EMAIL_FROM: "lazydog@example.com",
          PUBLIC_URL: "https://lazydog.test",
          // Payments test fixtures. The key is Hardhat's published dev account #0
          // (no funds, documented publicly); nothing is ever settled in tests.
          X402_PAY_TO: "0x00000000000000000000000000000000000000A1",
          X402_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        }
      }
    })
  ],
  test: { testTimeout: 60_000, hookTimeout: 60_000 }
});
