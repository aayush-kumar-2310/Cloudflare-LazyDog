import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { verifyNotesToken } from "@lazydog/shared";
import { z } from "zod";
import { LIMITS, NotesRepository } from "./notes";

type Env = Cloudflare.Env & { NOTES_MCP_SECRET: string };

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
});

const notFound = (id: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: `No note with id ${id}` }]
});

export function createNotesServer(notes: NotesRepository): McpServer {
  const server = new McpServer({ name: "lazydog-notes", version: "1.0.0" });

  server.registerTool(
    "create_note",
    {
      description: "Save a note (for example research findings) for the current user.",
      inputSchema: z.object({
        title: z.string().min(1).max(LIMITS.titleChars),
        content: z.string().min(1).max(LIMITS.contentChars)
      }),
      annotations: { destructiveHint: false, idempotentHint: false }
    },
    async ({ title, content }) => json(await notes.create(title, content))
  );

  server.registerTool(
    "list_notes",
    {
      description: "List the current user's notes, newest first (titles only).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(LIMITS.listMax).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ limit }) => json(await notes.list(limit))
  );

  server.registerTool(
    "get_note",
    {
      description: "Read one note, including its full content.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    async ({ id }) => {
      const note = await notes.get(id);
      return note ? json(note) : notFound(id);
    }
  );

  server.registerTool(
    "delete_note",
    {
      description: "Permanently delete one note.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { destructiveHint: true }
    },
    async ({ id }) =>
      (await notes.delete(id)) ? json({ deleted: id }) : notFound(id)
  );

  return server;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const userId = token ? await verifyNotesToken(env.NOTES_MCP_SECRET, token) : null;
    if (!userId) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
      );
    }

    // A fresh server per request, bound to the verified user.
    const notes = new NotesRepository(env.NOTES_DB, userId);
    return createMcpHandler(() => createNotesServer(notes), { route: "/mcp" })(
      request,
      env,
      ctx
    );
  }
} satisfies ExportedHandler<Env>;
