import Link from "next/link";
import { JobDetail } from "@/components/JobDetail";

/**
 * Job detail route.
 *
 * A server component only for the params handling — `params` is a Promise in
 * this version of Next and has to be awaited. Everything below reads the chain
 * from the browser, so the work happens in <JobDetail>.
 */
export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Ids are dense, 0-based `u32`s. Anything else never reaches the contract.
  if (!/^\d+$/.test(id)) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-16">
        <h1 className="title-display text-surface-100">Not a job id</h1>
        <p className="mt-3 text-surface-400">
          Job ids are whole numbers starting at 0 — <code>{id}</code> is not one.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block btn btn-primary btn-sm"
        >
          Back to dashboard
        </Link>
      </main>
    );
  }

  return <JobDetail jobId={Number(id)} />;
}
