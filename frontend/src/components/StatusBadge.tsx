import type { JobStatus, MilestoneStatus } from "@/types";

/**
 * Full class strings, not fragments. Tailwind scans source statically, so a
 * class assembled at runtime (`bg-status-${x}`) is never generated and the
 * badge silently loses its colour.
 */
const JOB_STYLE: Record<JobStatus, string> = {
  open: "border-status-open/30 bg-status-open/10 text-status-open",
  in_progress:
    "border-status-progress/30 bg-status-progress/10 text-status-progress",
  completed:
    "border-status-verified/30 bg-status-verified/10 text-status-verified",
  cancelled:
    "border-status-cancelled/30 bg-status-cancelled/10 text-status-cancelled",
  // Red, not the muted grey of a cancellation: an abandoned job means the
  // freelancer lost their stake, which is a materially different outcome.
  abandoned:
    "border-status-rejected/30 bg-status-rejected/10 text-status-rejected",
};

const JOB_LABEL: Record<JobStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
};

const MILESTONE_STYLE: Record<MilestoneStatus, string> = {
  pending: "border-surface-700 bg-surface-800 text-surface-400",
  submitted:
    "border-status-progress/30 bg-status-progress/10 text-status-progress",
  verified:
    "border-status-verified/30 bg-status-verified/10 text-status-verified",
  rejected:
    "border-status-rejected/30 bg-status-rejected/10 text-status-rejected",
};

const MILESTONE_LABEL: Record<MilestoneStatus, string> = {
  pending: "Awaiting work",
  submitted: "Awaiting review",
  verified: "Verified",
  rejected: "Rejected",
};

const BASE =
  "badge";

export function JobStatusBadge({ status }: { status: JobStatus }) {
  // An unrecognised status is a contract change, not a reason to crash.
  const style = JOB_STYLE[status] ?? JOB_STYLE.cancelled;
  return <span className={`${BASE} ${style}`}>{JOB_LABEL[status] ?? status}</span>;
}

export function MilestoneStatusBadge({ status }: { status: MilestoneStatus }) {
  const style = MILESTONE_STYLE[status] ?? MILESTONE_STYLE.pending;
  return (
    <span className={`${BASE} ${style}`}>{MILESTONE_LABEL[status] ?? status}</span>
  );
}
