import { describe, expect, it } from "vitest";
import { activityFromObservability, upsertActivity } from "../src/server/agent/activity";
import { createMcpServerTools, unwrapMcpResult } from "../src/server/agent/tools/notes-mcp";
import { parseWhen } from "../src/server/agent/tools/reminders";
import { assertBrowsableUrl } from "../src/server/agent/tools/research";
import { isAuthenticatedEmail, slackAddressed } from "../src/server/channels/host";

const NOW = new Date("2026-09-22T12:00:00Z");

describe("reminder schedule parsing", () => {
  it("accepts an absolute time with offset", () => {
    expect(parseWhen({ message: "x", at: "2026-09-23T10:00:00-07:00" }, NOW)).toEqual({
      kind: "at",
      date: new Date("2026-09-23T17:00:00Z")
    });
  });
  it("requires an explicit UTC offset so local times are never guessed", () => {
    expect(() => parseWhen({ message: "x", at: "2026-09-23T10:00:00" }, NOW)).toThrow(/offset/);
  });
  it("rejects past, far-future and malformed schedules", () => {
    expect(() => parseWhen({ message: "x", at: "2026-09-22T11:00:00Z" }, NOW)).toThrow(/past/);
    expect(() => parseWhen({ message: "x", at: "2028-01-01T00:00:00Z" }, NOW)).toThrow(/one year/);
    expect(() => parseWhen({ message: "x", cron: "every day" }, NOW)).toThrow(/cron/);
  });
  it("supports delays and cron", () => {
    expect(parseWhen({ message: "x", inSeconds: 90 }, NOW)).toEqual({ kind: "delay", seconds: 90 });
    expect(parseWhen({ message: "x", cron: "0 9 * * 1" }, NOW)).toEqual({ kind: "cron", cron: "0 9 * * 1" });
  });
});

describe("activity log", () => {
  it("updates a tool row in place and keeps its start time", () => {
    let log = upsertActivity([], { id: "tool:1", kind: "tool", status: "started", title: "Called ai_search" }, 1000);
    log = upsertActivity(log, { id: "tool:1", status: "ok", durationMs: 42 }, 5000);
    expect(log).toEqual([
      { id: "tool:1", kind: "tool", status: "ok", title: "Called ai_search", durationMs: 42, at: 1000 }
    ]);
  });
  it("is bounded", () => {
    let log: ReturnType<typeof upsertActivity> = [];
    for (let i = 0; i < 400; i++) log = upsertActivity(log, { kind: "message", status: "info", title: `m${i}` });
    expect(log).toHaveLength(150);
    expect(log.at(-1)?.title).toBe("m399");
  });
  it("maps only meaningful observability events", () => {
    expect(activityFromObservability({ type: "fiber:recovery:handled", payload: { fiberName: "job", status: "completed" } }))
      .toMatchObject({ kind: "recovery", status: "ok" });
    expect(activityFromObservability({ type: "state:update", payload: {} })).toBeNull();
  });
});

describe("MCP tool wrapping", () => {
  const source = {
    listTools: () => [
      { serverId: "notes", name: "create_note", inputSchema: { type: "object" }, annotations: {} },
      { serverId: "notes", name: "delete_note", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      { serverId: "other", name: "ignored", inputSchema: { type: "object" } }
    ],
    callTool: async (p: { name: string }) => ({ content: [{ type: "text", text: JSON.stringify({ called: p.name }) }] })
  };

  it("exposes one server's tools, and gates destructive ones behind approval", async () => {
    const tools = createMcpServerTools(source, "notes");
    expect(Object.keys(tools).sort()).toEqual(["notes_create_note", "notes_delete_note"]);
    expect(tools.notes_delete_note.needsApproval).toBe(true);
    expect(tools.notes_create_note.needsApproval).toBe(false);
    const out = await tools.notes_create_note.execute!({}, { toolCallId: "t", messages: [] } as never);
    expect(out).toEqual({ called: "create_note" });
  });

  it("unwraps MCP errors", () => {
    expect(unwrapMcpResult({ isError: true, content: [{ type: "text", text: "nope" }] })).toEqual({ error: "nope" });
  });
});

describe("channel guards", () => {
  it("only trusts email that passed DKIM or DMARC", () => {
    expect(isAuthenticatedEmail({ headers: [{ key: "authentication-results", value: "mx.cf; dkim=pass header.d=example.com" }] })).toBe(true);
    expect(isAuthenticatedEmail({ headers: [{ key: "authentication-results", value: "mx.cf; spf=pass; dkim=fail; dmarc=fail" }] })).toBe(false);
    expect(isAuthenticatedEmail({ headers: [] })).toBe(false);
  });

  it("answers Slack DMs and mentions, never bots or ambient channel chatter", () => {
    const base = { type: "message" as const, eventId: "e", message: { id: "m", text: "hi" } };
    expect(slackAddressed({ ...base, thread: { id: "t", isDirectMessage: true } })).toBe(true);
    expect(slackAddressed({ ...base, thread: { id: "t", isDirectMessage: false }, message: { id: "m", text: "hi", isMention: true } })).toBe(true);
    expect(slackAddressed({ ...base, thread: { id: "t", isDirectMessage: false } })).toBe(false);
    expect(slackAddressed({ ...base, thread: { id: "t", isDirectMessage: true }, actor: { id: "b", isBot: true } })).toBe(false);
  });

  it("keeps the browser tool on public web addresses", () => {
    expect(assertBrowsableUrl("https://developers.cloudflare.com/agents/").hostname).toBe("developers.cloudflare.com");
    for (const bad of ["file:///etc/passwd", "http://localhost:8787", "http://127.0.0.1", "http://10.0.0.5", "http://192.168.1.1", "http://169.254.169.254/latest"]) {
      expect(() => assertBrowsableUrl(bad)).toThrow();
    }
  });
});

import { cleanDocMarkdown, docUrlsFromIndex, itemKey, pageUrl } from "../src/server/http/seed-search";

describe("AI Search docs seeding", () => {
  it("extracts unique agents doc URLs from llms.txt", () => {
    const index = `- [Think](https://developers.cloudflare.com/agents/harnesses/think/index.md)
- https://developers.cloudflare.com/agents/index.md
- https://developers.cloudflare.com/agents/index.md
- https://developers.cloudflare.com/workers/index.md`;
    expect(docUrlsFromIndex(index)).toEqual([
      "https://developers.cloudflare.com/agents/harnesses/think/index.md",
      "https://developers.cloudflare.com/agents/index.md"
    ]);
  });

  it("keeps the article and drops chrome", () => {
    const raw = `---\ntitle: Think\ndescription: x\n---\n\n[Skip to content](#main-content)\n\n> Documentation Index\n\n# Think\n\nBody text.\n\nWas this helpful?\n\nYesNo\n\n## On this page\n{"@context":"x"}`;
    expect(cleanDocMarkdown(raw)).toEqual({ title: "Think", body: "# Think\n\nBody text." });
  });

  it("names items after the doc path", () => {
    const url = "https://developers.cloudflare.com/agents/harnesses/think/index.md";
    expect(itemKey(url)).toBe("agents/harnesses/think.md");
    expect(pageUrl(url)).toBe("https://developers.cloudflare.com/agents/harnesses/think/");
  });
});

import { htmlToText, linksFromHtml, RateGate, withBrowserFallback } from "../src/server/agent/tools/research";

describe("Browser Run pacing and fallback", () => {
  it("spaces reservations by the interval, including concurrent callers", () => {
    let now = 1_000;
    const gate = new RateGate(10_000, () => now);
    expect(gate.reserve()).toBe(0);
    expect(gate.reserve()).toBe(10_000);
    expect(gate.reserve()).toBe(20_000);
    now += 35_000;
    expect(gate.reserve()).toBe(0);
  });

  it("falls back to a direct fetch on 429 and says so", async () => {
    const gate = new RateGate(0);
    const limited = Object.assign(new Error("Browser Run markdown failed (429)"), { status: 429 });
    const result = await withBrowserFallback(gate, async () => { throw limited; }, async () => "plain text");
    expect(result).toMatchObject({ value: "plain text", via: "direct-fetch" });
    expect(result.note).toMatch(/429/);
  });

  it("does not hide other browser errors", async () => {
    const gate = new RateGate(0);
    const broken = Object.assign(new Error("boom"), { status: 500 });
    await expect(withBrowserFallback(gate, async () => { throw broken; }, async () => "x")).rejects.toThrow("boom");
  });

  it("skips the wait entirely when the queue is too long", async () => {
    let now = 0;
    const gate = new RateGate(15_000, () => now);
    gate.reserve();
    gate.reserve(); // next slot is 30s away
    const result = await withBrowserFallback(gate, async () => "browser", async () => "fetched");
    expect(result).toMatchObject({ value: "fetched", via: "direct-fetch" });
  });

  it("extracts readable text and absolute links from HTML", () => {
    const html = `<html><head><style>x{}</style><script>evil()</script></head><body><nav>menu</nav>
      <h1>Agents</h1><p>Build &amp; deploy.</p><ul><li>One</li></ul><a href="/agents/tools/">Tools</a><a href="#top">top</a></body></html>`;
    expect(htmlToText(html)).toBe("# Agents\nBuild & deploy.\n\n- One\nTools top");
    expect(linksFromHtml(html, new URL("https://developers.cloudflare.com/agents/"))).toEqual([
      "https://developers.cloudflare.com/agents/tools/"
    ]);
  });
});

import { toSpeech } from "../src/server/voice/speech";

describe("voice output", () => {
  it("strips markdown the TTS would read aloud", () => {
    expect(
      toSpeech("You have one pending reminder:\n\n- **Review the note “Tools.”** Scheduled for 2026‑10‑02 10:00 AM UTC.")
    ).toBe("You have one pending reminder: Review the note “Tools.” Scheduled for 2026-10-02 10:00 AM UTC.");
    expect(toSpeech("See [the docs](https://example.com) or `npm test`.\n```js\nx()\n```")).toBe(
      "See the docs or npm test. (code omitted)"
    );
  });
});

import { repetitionGuard, STOPPED_NOTE } from "../src/server/agent/repetition-guard";

describe("repetition guard", () => {
  const run = async (deltas: string[]) => {
    let stopped = false;
    const stream = new ReadableStream({
      start(c) {
        for (const text of deltas) c.enqueue({ type: "text-delta", id: "t", text });
        c.enqueue({ type: "finish" });
        c.close();
      }
    }).pipeThrough(repetitionGuard(10)({ tools: {}, stopStream: () => { stopped = true; } }) as never);
    const parts: Array<{ type: string; text?: string }> = [];
    for await (const p of stream as AsyncIterable<{ type: string; text?: string }>) parts.push(p);
    return { stopped, text: parts.map((p) => p.text ?? "").join(""), types: parts.map((p) => p.type) };
  };

  it("passes normal text through", async () => {
    const r = await run(["Hello ", "world!! ", "Fine...."]);
    expect(r).toMatchObject({ stopped: false, text: "Hello world!! Fine...." });
  });

  it("stops a run of one repeated character across chunks", async () => {
    const r = await run(["Sure", "!!!!!!", "!!!!!!", "!!!!!!!!", "more"]);
    expect(r.stopped).toBe(true);
    expect(r.text).toBe(`Sure!!!!!!${STOPPED_NOTE}`); // the chunk that crosses the limit is dropped
    expect(r.types).not.toContain("finish");
  });

  it("ignores long whitespace runs", async () => {
    expect((await run([" ".repeat(50), "ok"])).stopped).toBe(false);
  });
});
