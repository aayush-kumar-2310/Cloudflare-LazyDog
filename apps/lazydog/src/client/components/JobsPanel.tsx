import { useState } from "react";
import type { JobSummary } from "../../shared/types";
import { Panel } from "./Panel";

/**
 * Durability demo: start a checkpointed research job, optionally crashing the
 * Durable Object right after a step. Watch it resume from the checkpoint.
 */
export function JobsPanel({
  jobs,
  onStart
}: {
  jobs: JobSummary[];
  onStart: (topic: string, crashAfter?: string) => void;
}) {
  const [topic, setTopic] = useState("Cloudflare durable execution");
  const [crashAfter, setCrashAfter] = useState("search");

  return (
    <Panel title="Durable jobs">
      <div className="flex flex-col gap-1 text-xs">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
        />
        <div className="flex items-center gap-2">
          <label className="text-zinc-500">crash after</label>
          <select
            value={crashAfter}
            onChange={(e) => setCrashAfter(e.target.value)}
            className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
          >
            <option value="">never</option>
            <option value="search">search</option>
            <option value="read">read</option>
            <option value="summarize">summarize</option>
          </select>
          <button
            onClick={() => topic.trim() && onStart(topic.trim(), crashAfter || undefined)}
            className="ml-auto rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Start job
          </button>
        </div>
      </div>

      <ul className="mt-2 space-y-1.5 text-xs">
        {[...jobs].reverse().map((job) => (
          <li key={job.id}>
            <div className="flex justify-between">
              <span className="font-medium">{job.topic}</span>
              <span className={job.status === "completed" ? "text-emerald-600" : "text-zinc-500"}>
                {job.status}
                {job.resumes > 0 && ` · resumed ×${job.resumes}`}
              </span>
            </div>
            <div className="mt-0.5 flex gap-1">
              {job.steps.map((step) => (
                <span
                  key={step}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                    job.completed.includes(step)
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                      : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                  }`}
                >
                  {step}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
