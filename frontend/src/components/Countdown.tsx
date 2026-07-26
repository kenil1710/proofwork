"use client";

import { useEffect, useState } from "react";
import {
  deadlineTone,
  formatCountdown,
  secondsLeft,
  type DeadlineTone,
  type Job,
} from "@/types";

const TONE_TEXT: Record<DeadlineTone, string> = {
  expired: "text-status-rejected",
  urgent: "text-status-progress",
  soon: "text-surface-300",
  ok: "text-surface-400",
};

const TONE_BADGE: Record<DeadlineTone, string> = {
  expired: "border-status-rejected/30 bg-status-rejected/10 text-status-rejected",
  urgent: "border-status-progress/30 bg-status-progress/10 text-status-progress",
  soon: "border-surface-700 text-surface-300",
  ok: "border-surface-800 text-surface-400",
};

/**
 * Live deadline countdown.
 *
 * Ticks locally but is anchored to the CHAIN's clock: `job.now` is the
 * contract's own time at the moment of the read, and this only adds the wall
 * time elapsed since the component mounted. Reading `Date.now()` against the
 * deadline directly would let a viewer with a skewed system clock see a job as
 * expired that the contract still considers live — and be offered an abandon
 * button that can only revert.
 */
export function Countdown({
  job,
  variant = "text",
}: {
  job: Job;
  /** `badge` for job cards, `text` for the detail page. */
  variant?: "text" | "badge";
}) {
  // Seconds since this component mounted, not since the read — the difference
  // is bounded by render time and is irrelevant at day scale.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = secondsLeft(job, elapsed);
  const tone = deadlineTone(remaining);
  const label = formatCountdown(remaining);

  // A settled job's deadline is history — showing "overdue by 9d" on a job that
  // completed on time reads as a failure that never happened.
  const settled =
    job.status === "completed" ||
    job.status === "cancelled" ||
    job.status === "abandoned";
  if (settled) return null;

  if (variant === "badge") {
    return (
      <span className={`badge ${TONE_BADGE[tone]}`} title={deadlineTitle(job)}>
        {label}
      </span>
    );
  }

  return (
    <span className={TONE_TEXT[tone]} title={deadlineTitle(job)}>
      {label}
    </span>
  );
}

/** Absolute deadline in the viewer's locale, for the hover title. */
function deadlineTitle(job: Job): string {
  return `Deadline: ${new Date(job.deadline * 1000).toLocaleString()}`;
}
