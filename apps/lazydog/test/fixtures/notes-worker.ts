// The real Notes MCP Worker, bundled for the test pool. Creates its D1 schema
// on first request (the migration file, inlined at bundle time).
import notes from "../../../notes-mcp/src/index";

declare const NOTES_SCHEMA: string;
let ready: Promise<unknown> | null = null;

export default {
  async fetch(request: Request, env: { NOTES_DB: D1Database }, ctx: ExecutionContext) {
    ready ??= env.NOTES_DB.batch(
      NOTES_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean).map((s) => env.NOTES_DB.prepare(s))
    );
    await ready;
    return notes.fetch(request as never, env as never, ctx);
  }
};
