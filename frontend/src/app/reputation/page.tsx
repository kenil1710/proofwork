import { Suspense } from "react";
import { ReputationLookup } from "@/components/ReputationLookup";

/**
 * Reputation route.
 *
 * The lookup reads `?address=` so a record can be linked to directly, and
 * `useSearchParams` needs a Suspense boundary above it or the whole route is
 * forced out of static rendering.
 */
export default function ReputationPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16 sm:py-24">
          <p className="text-sm text-surface-400">Loading…</p>
        </main>
      }
    >
      <ReputationLookup />
    </Suspense>
  );
}
