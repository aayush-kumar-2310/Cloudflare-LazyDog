import { describe, expect, it } from "vitest";
import { inAgent, stateOf, waitFor } from "./helpers";

const uid = () => `usr_${crypto.randomUUID().replace(/-/g, "")}`;

describe("durable research job", () => {
  it("runs all steps and saves the result", async () => {
    const userId = uid();
    await inAgent(userId, (a) => a.startResearchJob("durable execution"));
    const job = await waitFor(async () => (await stateOf(userId)).jobs.find((j) => j.status === "completed"));
    expect(job.completed).toEqual(["search", "read", "summarize", "save"]);
    expect(job.resumes).toBe(0);

    const files = await inAgent(userId, (a) => a.workspace.glob("/research/*.md"));
    expect(files).toHaveLength(1);
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
