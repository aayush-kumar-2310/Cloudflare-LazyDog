import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never touch real Cloudflare services.
      remoteBindings: false,
      miniflare: {
        bindings: {
          MODEL_PROVIDER: "mock",
          ALLOW_MOCK_MODEL: "true",
          SESSION_SECRET: "test-session-secret",
          NOTES_MCP_URL: "",
          AI_SEARCH_INSTANCE: "",
          NOTES_MCP_SECRET: "",
          SLACK_BOT_TOKEN: "",
          SLACK_SIGNING_SECRET: "",
          DEV_LOGIN: "false",
          EMAIL_FROM: "lazydog@example.com",
          PUBLIC_URL: "https://lazydog.test"
        }
      }
    })
  ],
  test: { testTimeout: 60_000, hookTimeout: 60_000 }
});
