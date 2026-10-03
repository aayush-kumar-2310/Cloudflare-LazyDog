import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { inAgent, ORIGIN, signedInUser, stateOf, waitFor } from "./helpers";

/**
 * The demo flow, end to end through the real runtime: a chat turn that
 * searches (AI Search fixture), reads a page (Browser Run fixture), and saves
 * a note through the real Notes MCP Worker over HTTP — pausing for human
 * approval before the write, approved over the same WebSocket protocol the
 * web UI uses. The model is scripted; everything else is production code.
 */
describe("research → read → save note (approval-gated)", () => {
  it("runs the multi-tool turn, waits for approval, then writes the note", async () => {
    const user = await signedInUser();
    const script = JSON.stringify([
      { tool: "ai_search", input: { query: "durable execution fibers", maxResults: 3 } },
      { tool: "browser_open", input: { url: "https://developers.cloudflare.com/agents/runtime/execution/durable-execution/" } },
      { tool: "notes_create_note", input: { title: "Durable execution", content: "Fibers checkpoint with ctx.stash; onFiberRecovered resumes." } }
    ]);

    // 1. The turn runs search and browse, then parks on the note write.
    await inAgent(user.userId, (a) => a.runTurn({ input: `/script ${script}` }));
    const pending = await inAgent(user.userId, (a) =>
      a.messages
        .flatMap((m) => m.parts as Array<{ type: string; state?: string; toolCallId?: string; output?: unknown }>)
        .filter((p) => p.type.startsWith("tool-"))
    );
    const search = pending.find((p) => p.type === "tool-ai_search");
    expect(JSON.stringify(search?.output)).toContain("Durable execution with fibers");
    expect(pending.find((p) => p.type === "tool-browser_open")?.state).toBe("output-available");
    const write = pending.find((p) => p.type === "tool-notes_create_note");
    expect(write?.state).toBe("approval-requested");
    expect((await stateOf(user.userId)).activity.map((e) => e.title)).toContain(
      "Waiting for approval: notes_create_note"
    );

    // 2. Nothing was written before approval.
    const before = await listNotes(user.userId);
    expect(before).not.toContain("Durable execution");

    // 3. Approve over the agent WebSocket, exactly as the UI does.
    const res = await exports.default.fetch(`${ORIGIN}/agent`, {
      headers: { Upgrade: "websocket", Cookie: user.cookie, Origin: ORIGIN }
    });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: write!.toolCallId, approved: true, autoContinue: true }));

    // 4. The write runs through the Notes MCP server and the turn completes.
    const written = await waitFor(async () =>
      (await stateOf(user.userId)).activity.find((e) => e.title === "Called MCP notes.create_note" && e.status === "ok")
    );
    expect(written.detail).toContain("note_");
    expect(await listNotes(user.userId)).toContain("Durable execution");
    ws.close();

    // The activity log tells the whole story, in order, from real events.
    const titles = (await stateOf(user.userId)).activity.map((e) => e.title);
    const order = ["Received web message", "Called ai_search", "Called browser_open", "Waiting for approval: notes_create_note", "Called MCP notes.create_note"];
    expect(order.map((t) => titles.indexOf(t))).toEqual([...order.map((t) => titles.indexOf(t))].sort((a, b) => a - b));
    expect(order.every((t) => titles.includes(t))).toBe(true);
  });
});

async function listNotes(userId: string): Promise<string> {
  return inAgent(userId, async (a) => {
    await a.mcp.waitForConnections({ timeout: 5_000 });
    const id = Object.entries(a.getMcpServers().servers).find(([, s]) => s.name === "notes")![0];
    return JSON.stringify(await a.mcp.callTool({ serverId: id, name: "list_notes", arguments: {} }));
  });
}
