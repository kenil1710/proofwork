import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { JobList } from "@/components/JobList";
import { NetworkReadout } from "@/components/NetworkReadout";

export const metadata: Metadata = {
  title: "Explore jobs — ProofWork",
  description:
    "Live jobs, escrow state, and network status read directly from the ProofWork contract on GenLayer.",
};

/**
 * The product surface. Everything that touches the chain lives here, which
 * keeps the landing page fully static and means a slow or unreachable node
 * degrades one page instead of the front door.
 */
export default function AppPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
      <Breadcrumbs trail={[{ label: "ProofWork", href: "/" }, { label: "Explore" }]} />

      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="eyebrow text-orchid-400">
            Live on chain
          </p>
          <h1 className="title-display mt-4 text-surface-100">Explore jobs</h1>
          <p className="mt-4 max-w-xl leading-relaxed text-surface-400">
            Every job below is read from the contract. Connect a wallet to post
            one, accept one, or trigger verification on a submitted milestone.
          </p>
        </div>

        <Link href="/create" className="btn btn-primary">
          Post a job
        </Link>
      </div>

      {/* NetworkReadout carries the job count, the network and the contract
          address together, so this page needs no separate count panel. */}
      <div className="mt-12">
        <NetworkReadout />
      </div>

      <div className="mt-14">
        <JobList />
      </div>
    </main>
  );
}
