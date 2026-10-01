import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { withX402 } from "agents/x402";
import { z } from "zod";
import { config } from "../config";
import { aiSearch } from "../agent/tools/research";
import { PAYMENT_NETWORK, PREMIUM_BRIEF_PRICE_USD } from "./policy";

/**
 * A paid MCP server: one x402-priced tool, settled in test USDC on Base
 * Sepolia through the public x402 facilitator.
 *
 * It uses the SDK's `withX402` + `McpAgent` path, which is what x402 supports
 * today (the stateless `createMcpHandler` path has no x402 wrapper yet).
 * LazyDog reaches it over the Agents RPC transport inside this Worker.
 */
export class PremiumMCP extends McpAgent<Env> {
  server = withX402(new McpServer({ name: "lazydog-premium", version: "1.0.0" }), {
    network: PAYMENT_NETWORK,
    recipient: (String((this.env as { X402_PAY_TO?: string }).X402_PAY_TO ?? "") ||
      "0x0000000000000000000000000000000000000000") as `0x${string}`,
    facilitator: { url: "https://x402.org/facilitator" }
  });

  async init() {
    this.server.paidTool(
      "premium_brief",
      "A sourced research brief on a topic from LazyDog's indexed docs (paid, x402).",
      PREMIUM_BRIEF_PRICE_USD,
      { topic: z.string().min(3).max(200) },
      { readOnlyHint: true },
      async ({ topic }) => {
        const result = await aiSearch(this.env.AI_SEARCH, config(this.env).aiSearchInstance, topic, 6);
        if (!result.ok) return { isError: true, content: [{ type: "text" as const, text: result.error }] };
        const brief = result.sources
          .map((s, i) => `${i + 1}. ${s.title} — ${s.url}\n   ${s.snippet.replace(/\s+/g, " ").slice(0, 300)}`)
          .join("\n");
        return { content: [{ type: "text" as const, text: `Premium brief: ${topic}\n\n${brief}` }] };
      }
    );
  }
}
