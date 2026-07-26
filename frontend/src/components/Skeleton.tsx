/**
 * Loading placeholders shaped like the content they stand in for.
 *
 * A skeleton is only worth more than a spinner if it predicts the real layout —
 * otherwise it is a spinner that also shifts the page when it resolves. These
 * mirror JobCard and JobDetail closely enough that nothing jumps.
 *
 * All of them carry `aria-hidden` and sit inside a container that announces the
 * loading state once, so a screen reader hears "loading jobs" rather than a
 * dozen meaningless boxes.
 */

function Bar({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block animate-pulse rounded bg-surface-800 ${className}`}
    />
  );
}

/** Stand-in for one JobCard. */
export function JobCardSkeleton() {
  return (
    <div aria-hidden className="border border-surface-800 p-6">
      <div className="flex items-center justify-between gap-4">
        <Bar className="h-3 w-16" />
        <Bar className="h-5 w-20" />
      </div>
      <Bar className="mt-4 h-6 w-2/3" />
      <Bar className="mt-3 h-4 w-full" />
      <Bar className="mt-2 h-4 w-4/5" />
      <div className="mt-6 flex gap-8">
        <Bar className="h-4 w-24" />
        <Bar className="h-4 w-24" />
        <Bar className="h-4 w-28" />
      </div>
    </div>
  );
}

export function JobListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">Loading jobs…</span>
      {Array.from({ length: count }, (_, index) => (
        <JobCardSkeleton key={index} />
      ))}
    </div>
  );
}

/** Stand-in for the job detail header plus one milestone. */
export function JobDetailSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading job…</span>
      <Bar className="h-3 w-20" />
      <Bar className="mt-4 h-9 w-3/5" />
      <div className="mt-8 grid gap-6 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index}>
            <Bar className="h-3 w-20" />
            <Bar className="mt-2 h-6 w-24" />
          </div>
        ))}
      </div>
      <Bar className="mt-10 h-3 w-28" />
      <Bar className="mt-3 h-4 w-full" />
      <Bar className="mt-2 h-4 w-11/12" />
      <div className="mt-10 border border-surface-800 p-6">
        <Bar className="h-3 w-24" />
        <Bar className="mt-4 h-5 w-1/2" />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Bar key={index} className="h-3 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Stand-in for the reputation result panel. */
export function ReputationSkeleton() {
  return (
    <div role="status" aria-live="polite" className="mt-10">
      <span className="sr-only">Looking up reputation…</span>
      <Bar className="h-4 w-96 max-w-full" />
      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index}>
            <Bar className="h-3 w-28" />
            <Bar className="mt-3 h-10 w-20" />
          </div>
        ))}
      </div>
      <Bar className="mt-10 h-3 w-32" />
      <div className="mt-4 flex gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          <Bar key={index} className="h-12 w-16" />
        ))}
      </div>
    </div>
  );
}
