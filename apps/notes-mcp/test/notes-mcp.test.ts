import { exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mintNotesToken } from "@lazydog/shared";
import { describe, expect, it } from "vitest";

const MCP_URL = new URL("https://notes.test/mcp");

async function connect(token: string | null) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    fetch: (input, init) => exports.default.fetch(new Request(input, init)),
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {}
  });
  await client.connect(transport);
  return client;
}

const textOf = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe("notes MCP server", () => {
  it("rejects requests without a valid capability token", async () => {
    const res = await exports.default.fetch(
      new Request(MCP_URL, { method: "POST", body: "{}" })
    );
    expect(res.status).toBe(401);

    const forged = await exports.default.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { Authorization: "Bearer usr_a.deadbeef" },
        body: "{}"
      })
    );
    expect(forged.status).toBe(401);
  });

  it("exposes the four notes tools", async () => {
    const client = await connect(await mintNotesToken("test-secret", "usr_a"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_note",
      "delete_note",
      "get_note",
      "list_notes"
    ]);
  });

  it("creates, lists, reads and deletes notes scoped to the token's user", async () => {
    const alice = await connect(await mintNotesToken("test-secret", "usr_alice"));
    const bob = await connect(await mintNotesToken("test-secret", "usr_bob"));

    const created = textOf(
      await alice.callTool({
        name: "create_note",
        arguments: { title: "Durable execution", content: "Fibers checkpoint work." }
      })
    );
    expect(created.id).toMatch(/^note_/);

    expect(textOf(await alice.callTool({ name: "list_notes", arguments: {} }))).toHaveLength(1);
    expect(textOf(await bob.callTool({ name: "list_notes", arguments: {} }))).toHaveLength(0);

    const fromBob = await bob.callTool({ name: "get_note", arguments: { id: created.id } });
    expect(fromBob.isError).toBe(true);

    const got = textOf(await alice.callTool({ name: "get_note", arguments: { id: created.id } }));
    expect(got.content).toBe("Fibers checkpoint work.");

    await alice.callTool({ name: "delete_note", arguments: { id: created.id } });
    expect(textOf(await alice.callTool({ name: "list_notes", arguments: {} }))).toHaveLength(0);
  });
});
