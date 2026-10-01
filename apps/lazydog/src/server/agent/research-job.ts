import type { JobSummary } from "../../shared/types";

export const RESEARCH_STEPS = ["search", "read", "summarize", "save"] as const;
export type ResearchStep = (typeof RESEARCH_STEPS)[number];

/**
 * Everything needed to resume a research job, written to the fiber's
 * checkpoint (SQLite, synchronously) after every step.
 */
export type ResearchSnapshot = {
  jobId: string;
  topic: string;
  completed: ResearchStep[];
  results: Partial<Record<ResearchStep, unknown>>;
  /** Demo control: abort the Durable Object right after this step's checkpoint. */
  crashAfter?: ResearchStep;
  /** How many times this job has been resumed after an interruption. */
  resumes: number;
};

export interface ResearchJobDeps {
  execute(step: ResearchStep, snapshot: ResearchSnapshot): Promise<unknown>;
  checkpoint(snapshot: ResearchSnapshot): void;
  onStep(step: ResearchStep, status: "started" | "ok" | "error", detail?: string): void;
  /** Hard-kill the Durable Object (demo only). The returned promise never settles. */
  crash(): Promise<never>;
}

/**
 * Run the remaining steps of a job. Completed steps are skipped, so after an
 * eviction the job continues from its last checkpoint instead of redoing
 * work. A failing step is recorded and the job moves on with what it has.
 */
export async function runResearchSteps(start: ResearchSnapshot, deps: ResearchJobDeps): Promise<ResearchSnapshot> {
  let snapshot = start;
  for (const step of RESEARCH_STEPS) {
    if (snapshot.completed.includes(step)) continue;
    deps.onStep(step, "started");
    let result: unknown;
    try {
      result = await deps.execute(step, snapshot);
      deps.onStep(step, "ok");
    } catch (error) {
      result = { error: (error as Error).message };
      deps.onStep(step, "error", (error as Error).message);
    }
    snapshot = {
      ...snapshot,
      completed: [...snapshot.completed, step],
      results: { ...snapshot.results, [step]: result }
    };
    deps.checkpoint(snapshot);
    if (snapshot.crashAfter === step) await deps.crash();
  }
  return snapshot;
}

export const jobSummary = (
  s: ResearchSnapshot,
  status: JobSummary["status"]
): JobSummary => ({
  id: s.jobId,
  topic: s.topic,
  status,
  completed: [...s.completed],
  steps: [...RESEARCH_STEPS],
  resumes: s.resumes
});
