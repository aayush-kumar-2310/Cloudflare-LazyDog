import { describe, expect, it } from "vitest";
import { inAgent, stateOf, waitFor } from "./helpers";

const uid = () => `usr_${crypto.randomUUID().replace(/-/g, "")}`;

describe("durable research job", () => {
  it("runs all steps — search, browser read, summary — and saves the result as an MCP note", async () => {
    const userId = uid();
    await inAgent(userId, (a) => a.startResearchJob("durable execution fibers"));
    const job = await waitFor(async () => (await stateOf(userId)).jobs.find((j) => j.status === "completed"));
    expect(job.completed).toEqual(["search", "read", "summarize", "save"]);
    expect(job.resumes).toBe(0);

    const steps = (await stateOf(userId)).activity.filter((e) => e.title.startsWith("Job step:"));
    expect(steps.map((e) => `${e.title}:${e.status}`)).toEqual([
      "Job step: search:ok",
      "Job step: read:ok",
      "Job step: summarize:ok",
      "Job step: save:ok"
    ]);
    // The note really exists in the Notes MCP server (D1), read back over MCP.
    const notes = await inAgent(userId, async (a) => {
      const id = Object.entries(a.getMcpServers().servers).find(([, s]) => s.name === "notes")![0];
      return a.mcp.callTool({ serverId: id, name: "list_notes", arguments: {} });
    });
    expect(JSON.stringify(notes)).toContain("Research: durable execution fibers");
  });

  it("survives a crash mid-job and resumes from the last checkpoint", async () => {
    const userId = uid();
    await inAgent(userId, (a) => a.startResearchJob("fibers", { crashAfter: "search" }));

    // The Durable Object aborts itself right after checkpointing `search`.
    // The next request restarts it; recovery picks the job up from the checkpoint.
    const job = await waitFor(
      async () => {
        try {
          return (await stateOf(userId)).jobs.find((j) => j.status === "completed");
        } catch {
          return undefined; // the object is resetting
        }
      },
      { timeoutMs: 15_000, intervalMs: 200 }
    );
    expect(job.resumes).toBe(1);
    expect(job.completed).toEqual(["search", "read", "summarize", "save"]);

    const activity = (await stateOf(userId)).activity;
    const titles = activity.map((e) => e.title);
    expect(titles).toContain("Simulated crash: aborting Durable Object");
    expect(titles).toContain("Resuming durable job after interruption");
    // `search` ran exactly once: before the crash, never again after recovery.
    expect(activity.filter((e) => e.title === "Job step: search")).toHaveLength(1);
    expect(activity.filter((e) => e.title === "Job step: read")).toHaveLength(1);
  });
});
