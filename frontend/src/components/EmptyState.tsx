import Link from "next/link";

/**
 * An empty screen is an invitation to act, so every one of these says what to
 * do next rather than just reporting absence.
 *
 * The mark is drawn from the app's own vocabulary — a milestone rail, a score
 * bar, a page outline — rather than a generic magnifying glass. It is stroked
 * in surface tones so it reads as structure, not as an illustration competing
 * with the copy.
 */
export function EmptyState({
  mark,
  title,
  body,
  action,
}: {
  mark: React.ReactNode;
  title: string;
  body: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="border border-dashed border-surface-800 px-6 py-14 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center">
        <svg
          aria-hidden
          viewBox="0 0 48 48"
          fill="none"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-full w-full stroke-surface-700"
        >
          {mark}
        </svg>
      </div>
      <p className="mt-5 text-base text-surface-200">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-surface-500">
        {body}
      </p>
      {action ? (
        <Link
          href={action.href}
          className="mt-6 inline-block bg-orchid-600 px-5 py-2.5 text-sm text-white transition-colors hover:bg-orchid-500"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/** No jobs exist yet — an empty escrow. */
export const MARK_NO_JOBS = (
  <>
    <rect x="8" y="14" width="32" height="24" rx="2" />
    <path d="M18 14v-3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3" />
    <path d="M8 24h32" />
  </>
);

/** A search that matched nothing — an empty score sheet. */
export const MARK_NO_RECORD = (
  <>
    <path d="M12 8h24v32H12z" />
    <path d="M18 18h12" />
    <path d="M18 25h12" />
    <path d="M18 32h6" />
  </>
);

/** A filter with no results — the list exists, this slice of it does not. */
export const MARK_NO_MATCH = (
  <>
    <path d="M8 12h32" />
    <path d="M14 22h20" />
    <path d="M20 32h8" />
  </>
);
