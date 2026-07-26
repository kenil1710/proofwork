import Link from "next/link";

export interface Crumb {
  label: string;
  /** Omitted on the current page, which is not a link. */
  href?: string;
}

/**
 * Trail back out of an internal page.
 *
 * The last crumb is rendered as plain text with `aria-current`, not a link to
 * where you already are.
 */
export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-8">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-2">
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="text-surface-500 transition-colors hover:text-orchid-400"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "text-surface-300" : "text-surface-500"}
                >
                  {crumb.label}
                </span>
              )}
              {last ? null : (
                <span aria-hidden className="text-surface-700">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
