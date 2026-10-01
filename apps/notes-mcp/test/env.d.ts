declare namespace Cloudflare {
  interface Env {
    NOTES_MCP_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
