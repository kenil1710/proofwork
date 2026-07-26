"use client";

import {
  EmptyState,
  MARK_NO_JOBS,
  MARK_NO_MATCH,
} from "@/components/EmptyState";
import { JobListSkeleton } from "@/components/Skeleton";
import { useEffect, useState } from "react";
import { JobCard } from "@/components/JobCard";
import { getJob, getJobCount } from "@/lib/contract";
import type { Job } from "@/types";

/** Most recent jobs to read. Each is its own RPC round-trip, so this is bounded. */
const PAGE_SIZE = 12;

type Entry = { jobId: number; job: Job };

type State =
  | { phase: "loading" }
  | { phase: "ready"; entries: Entry[]; total: number }
  | { phase: "error"; message: string };

type Filter = "all" | "open";

export function JobList() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const total = await getJobCount();
        // Ids are dense and 0-based, so the newest is count-1. Walk backwards.
        const ids = Array.from(
          { length: Math.min(total, PAGE_SIZE) },
          (_, index) => total - 1 - index,
        );

        // allSettled, not all: one unreadable job shouldn't blank the dashboard.
        const settled = await Promise.allSettled(ids.map((id) => getJob(id)));
        if (cancelled) return;

        const entries = settled.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [{ jobId: ids[index], job: result.value }]
            : [],
        );

        setState({ phase: "ready", entries, total });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: "error",
          message:
            error instanceof Error ? error.message : "Could not read jobs.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  if (state.phase === "loading") {
    return <JobListSkeleton />;
  }

  if (state.phase === "error") {
    return (
      <div>
        <p role="alert" className="text-sm text-status-rejected">
          {state.message}
        </p>
        <button
          type="button"
          onClick={() => {
            setState({ phase: "loading" });
            setReloadToken((token) => token + 1);
          }}
          className="btn btn-ghost btn-sm mt-3"
        >
          Try again
        </button>
      </div>
    );
  }

  if (state.total === 0) {
    return (
      <EmptyState
        mark={MARK_NO_JOBS}
        title="No jobs posted yet"
        body="Nothing has been escrowed on this contract so far. Post the first one and it shows up here the moment it is accepted on chain."
        action={{ label: "Post a job", href: "/create" }}
      />
    );
  }

  const visible =
    filter === "open"
      ? state.entries.filter((entry) => entry.job.status === "open")
      : state.entries;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="text-xs tracking-[0.2em] text-surface-400 uppercase">
          Recent jobs
        </h2>
        <div className="flex gap-2">
          {(["all", "open"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              aria-pressed={filter === option}
              className={`btn btn-sm ${
                filter === option ? "btn-primary" : "btn-ghost"
              }`}
            >
              {option === "all" ? "All" : "Open"}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            mark={MARK_NO_MATCH}
            title="Nothing open right now"
            body="Every recent job has been taken or closed. Switch to All to see them, or post one of your own."
            action={{ label: "Post a job", href: "/create" }}
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {visible.map((entry) => (
            <JobCard key={entry.jobId} job={entry.job} jobId={entry.jobId} />
          ))}
        </ul>
      )}

      {state.total > PAGE_SIZE ? (
        <p className="mt-6 text-xs text-surface-600">
          Showing the {PAGE_SIZE} most recent of {state.total} jobs.
        </p>
      ) : null}
    </div>
  );
}
