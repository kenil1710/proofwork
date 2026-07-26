import Link from "next/link";
import { JobStatusBadge } from "@/components/StatusBadge";
import { Countdown } from "@/components/Countdown";
import { shortAddress } from "@/lib/address";
import { formatGen } from "@/lib/units";
import type { Job } from "@/types";

export function JobCard({ job, jobId }: { job: Job; jobId: number }) {
  return (
    <li>
      <Link
        href={`/job/${jobId}`}
        className="block panel p-6 transition-colors hover:border-orchid-400/50"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs tracking-[0.15em] text-surface-600 uppercase">
              Job {jobId}
            </p>
            <h3 className="mt-1.5 truncate text-lg font-medium text-surface-100">
              {job.title}
            </h3>
          </div>
          {/* Deadline sits beside the status, not in the stats row: on an
              open job it is the thing that decides whether taking it is
              realistic, and it is the only value here that changes on its
              own. Countdown renders nothing once a job has settled. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Countdown job={job} variant="badge" />
            <JobStatusBadge status={job.status} />
          </div>
        </div>

        <p className="mt-3 line-clamp-2 text-sm text-surface-400">
          {job.requirements}
        </p>

        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 border-t border-surface-800 pt-4 text-xs">
          <div className="flex items-baseline gap-2">
            <dt className="text-surface-600">Escrow</dt>
            <dd className="tabular-nums text-surface-200">
              {formatGen(job.total_amount)} GEN
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-surface-600">Milestones</dt>
            <dd className="tabular-nums text-surface-200">
              {job.completed_milestones}/{job.milestone_count} verified
            </dd>
          </div>
          {job.required_stake > 0n ? (
            <div className="flex items-baseline gap-2">
              <dt className="text-surface-600">Stake</dt>
              <dd className="tabular-nums text-surface-200">
                {formatGen(job.required_stake)} GEN
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline gap-2">
            <dt className="text-surface-600">Client</dt>
            <dd className="value-mono text-surface-200">{shortAddress(job.client)}</dd>
          </div>
        </dl>
      </Link>
    </li>
  );
}
