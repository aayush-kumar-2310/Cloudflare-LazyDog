import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// LAZYDOG_OFFLINE=1 runs without a Cloudflare login: remote bindings (Workers AI,
// Browser Run, AI Search, Email) are disabled and the scripted mock model answers.
const offline = process.env.LAZYDOG_OFFLINE === "1";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare({
      remoteBindings: !offline,
      ...(offline ? { config: { vars: { MODEL_PROVIDER: "mock", ALLOW_MOCK_MODEL: "true", AI_SEARCH_INSTANCE: "" } } } : {})
    }),
    tailwindcss()
  ]
});
