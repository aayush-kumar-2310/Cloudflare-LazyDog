import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registry } from "../src/server/identity/client";
import { waitFor } from "./helpers";

describe("AI Search first-run seeding", () => {
  it("seeds an empty index from real alarms, one batch per alarm, then reports ready", async () => {
    const reg = registry(env);
    expect(await reg.ensureSearchSeeded("fresh-docs")).toMatchObject({ status: "seeding", uploaded: 0 });

    const done = await waitFor(async () => {
      const s = await reg.ensureSearchSeeded("fresh-docs");
      return s.status === "ready" ? s : undefined;
    });
    expect(done).toEqual({ status: "ready", uploaded: 3, total: 3 });

    // The pages are really in the index, citable by title and URL.
    const hits = await env.AI_SEARCH.get("fresh-docs").items.list({ per_page: 10 });
    expect(JSON.stringify(hits)).toContain("https://developers.cloudflare.com/agents/runtime/execution/durable-execution/");
  });

  it("leaves an index that already has content alone", async () => {
    const reg = registry(env);
    await env.AI_SEARCH.create({ id: "existing-docs" });
    await env.AI_SEARCH.get("existing-docs").items.upload("hand-made.md", "x", { metadata: { title: "Mine" } });
    expect(await reg.ensureSearchSeeded("existing-docs")).toEqual({ status: "ready", uploaded: 1, total: 1 });
    expect(await runDurableObjectAlarm(reg)).toBe(false);
  });
});
