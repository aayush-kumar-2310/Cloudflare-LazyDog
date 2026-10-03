import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";

/** The subset of the Agents MCP client manager this module needs. */
export interface McpToolSource {
  listTools(): Array<{
    serverId: string;
    name: string;
    description?: string;
    inputSchema: unknown;
    annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
  }>;
  callTool(params: {
    serverId: string;
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
}

export const NOTES_TOOL_PREFIX = "notes_";

/** Unwrap an MCP CallToolResult into something compact for the model. */
export function unwrapMcpResult(result: unknown): unknown {
  const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // plain-text result
  }
  return r.isError ? { error: value } : value;
}

/**
 * Expose one MCP server's tools to the model as `notes_<tool>`.
 *
 * Tools come from live MCP discovery, not a hard-coded list, and every call
 * goes through the MCP client connection. Anything the server does not mark
 * `readOnlyHint` (create_note, delete_note) changes the user's data, so it
 * requires human approval before it runs; reads (list/get) do not.
 */
export function createMcpServerTools(mcp: McpToolSource, serverId: string): ToolSet {
  const tools: ToolSet = {};
  for (const t of mcp.listTools()) {
    if (t.serverId !== serverId) continue;
    tools[`${NOTES_TOOL_PREFIX}${t.name}`] = tool({
      description: `[MCP notes server] ${t.description ?? t.name}`,
      inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
      needsApproval: t.annotations?.readOnlyHint !== true,
      execute: async (args) =>
        unwrapMcpResult(
          await mcp.callTool({
            serverId,
            name: t.name,
            arguments: args as Record<string, unknown>
          })
        )
    });
  }
  return tools;
}
