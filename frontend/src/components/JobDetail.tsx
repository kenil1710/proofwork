"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useContractWrite } from "@/hooks/useContractWrite";
import { useWallet } from "@/components/WalletProvider";
import { JobStatusBadge } from "@/components/StatusBadge";
import { MilestoneCard } from "@/components/MilestoneCard";
import { PayoutNotice } from "@/components/PayoutNotice";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ConfirmModal } from "@/components/ConfirmModal";
import { JobDetailSkeleton } from "@/components/Skeleton";
import { GLOSSARY, Tooltip } from "@/components/Tooltip";
import { TransactionStatus } from "@/components/TransactionStatus";
import { TxProgressModal } from "@/components/TxProgressModal";
import { Countdown } from "@/components/Countdown";
import { isUnassigned, sameAddress, shortAddress } from "@/lib/address";
import {
  abandonJob,
  acceptJob,
  cancelJob,
  getJob,
  getJobCount,
  getMilestones,
  waitForState,
} from "@/lib/contract";
import { explorerUrl } from "@/lib/genlayer";
import { formatGen } from "@/lib/units";
import { canAbandon } from "@/types";
import type { Job, Milestone } from "@/types";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; job: Job; milestones: Milestone[] }
  /** `missing` means the id is past the job count — a different thing from the
   * network being down, and it must not be reported as a connection problem. */
  | { phase: "error"; message: string; missing: boolean };

function AddressLine({ label, address }: { label: string; address: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs tracking-[0.15em] text-surface-600 uppercase">
        {label}
      </dt>
      <dd>
        <a
          href={explorerUrl("address", address)}
          target="_blank"
          rel="noreferrer"
          className="value-mono text-sm text-orchid-400 transition-colors hover:text-orchid-300"
        >
          {shortAddress(address)}
        </a>
      </dd>
    </div>
  );
}

export function JobDetail({ jobId }: { jobId: number }) {
  const { account } = useWallet();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  // Bumped to re-run the load effect; the retry button and post-write refreshes
  // both go through it.
  const [reloadToken, setReloadToken] = useState(0);

  const accept = useContractWrite();
  const cancel = useContractWrite();
  const abandon = useContractWrite();
  // Which action is awaiting confirmation. Both move money, so neither goes
  // straight to a signature prompt.
  const [confirming, setConfirming] = useState<
    "accept" | "cancel" | "abandon" | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    // setState sits behind an await, satisfying React 19's
    // set-state-in-effect rule.
    void (async () => {
      try {
        const job = await getJob(jobId);
        const milestones = await getMilestones(jobId, job.milestone_count);
        if (!cancelled) setState({ phase: "ready", job, milestones });
      } catch (error) {
        if (cancelled) return;

        // A read failure here is ambiguous: the contract raises the same way for
        // "job 5 does not exist" as for "the node is unreachable", and reporting
        // a missing job as a connection fault sends people to check their wifi.
        // The job count settles it — and if that read works, the network is fine.
        let missing = false;
        let message =
          error instanceof Error ? error.message : "Could not load this job.";
        try {
          const count = await getJobCount();
          if (jobId >= count) {
            missing = true;
            message =
              count === 0
                ? "No jobs have been posted to this escrow yet."
                : `There ${count === 1 ? "is" : "are"} only ${count} job${
                    count === 1 ? "" : "s"
                  } so far, numbered 0 to ${count - 1}.`;
          }
        } catch {
          // Count failed too, so this really does look like a network problem —
          // keep the original message.
        }
        if (cancelled) return;
        setState({ phase: "error", message, missing });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId, reloadToken]);

  const refresh = useCallback(async () => {
    setReloadToken((token) => token + 1);
  }, []);

  if (state.phase === "loading") {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <Breadcrumbs
          trail={[
            { label: "ProofWork", href: "/" },
            { label: `Job ${jobId}` },
          ]}
        />
        <JobDetailSkeleton />
      </main>
    );
  }

  if (state.phase === "error") {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <Breadcrumbs
          trail={[{ label: "ProofWork", href: "/" }, { label: `Job ${jobId}` }]}
        />
        <h1 className="title-display text-surface-100">
          {state.missing ? `No job ${jobId} yet` : `Job ${jobId} could not be loaded`}
        </h1>
        <p
          role="alert"
          className={`mt-3 text-sm ${
            state.missing ? "text-surface-400" : "text-status-rejected"
          }`}
        >
          {state.message}
        </p>
        <div className="mt-6 flex gap-3">
          {state.missing ? null : (
            <button
              type="button"
              onClick={() => {
                setState({ phase: "loading" });
                setReloadToken((token) => token + 1);
              }}
              className="btn btn-ghost btn-sm"
            >
              Try again
            </button>
          )}
          <Link
            href="/"
            className="btn btn-primary btn-sm"
          >
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  const { job, milestones } = state;
  const isClient = sameAddress(account, job.client);
  const isFreelancer = sameAddress(account, job.freelancer);

  const canAccept =
    Boolean(account) && job.status === "open" && !isClient && isUnassigned(job.freelancer);
  const canCancel = isClient && job.status === "open";
  // Mirrors the contract's guard exactly — see `canAbandon` in @/types. Any
  // looser condition offers a button whose transaction can only revert.
  const showAbandon = canAbandon(job, account);
  const settled =
    job.status === "completed" ||
    job.status === "cancelled" ||
    job.status === "abandoned";

  async function handleAccept() {
    // The job's own `required_stake`, never a figure recomputed from the
    // percentage: the contract truncates when deriving it and demands an exact
    // match, so a recomputed value can be off by base units and revert.
    await accept.run((account) => acceptJob(account, jobId, job.required_stake), {
      onAccepted: async () => {
        await waitForState(
          () => getJob(jobId),
          (next) => next.status === "in_progress",
          "the job to show as accepted",
        );
        await refresh();
      },
    });
  }

  async function handleCancel() {
    await cancel.run((account) => cancelJob(account, jobId), {
      onAccepted: async () => {
        await waitForState(
          () => getJob(jobId),
          (next) => next.status === "cancelled",
          "the job to show as cancelled",
        );
        await refresh();
      },
    });
  }

  async function handleAbandon() {
    await abandon.run((account) => abandonJob(account, jobId), {
      onAccepted: async () => {
        await waitForState(
          () => getJob(jobId),
          (next) => next.status === "abandoned",
          "the job to show as abandoned",
        );
        await refresh();
      },
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
      <Breadcrumbs
        trail={[{ label: "ProofWork", href: "/" }, { label: `Job ${jobId}` }]}
      />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow text-surface-600">
            Job {jobId}
          </p>
          <h1 className="title-display mt-2 text-surface-100">{job.title}</h1>
        </div>
        <JobStatusBadge status={job.status} />
      </div>

      <dl className="mt-8 grid gap-6 panel p-6 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="text-xs tracking-[0.15em] text-surface-600 uppercase">
            <Tooltip term="In escrow">{GLOSSARY.escrow}</Tooltip>
          </dt>
          <dd className="text-lg tabular-nums text-surface-100">
            {formatGen(job.total_amount)}{" "}
            <Tooltip term="GEN">{GLOSSARY.gen}</Tooltip>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs tracking-[0.15em] text-surface-600 uppercase">
            Progress
          </dt>
          <dd className="text-lg tabular-nums text-surface-100">
            {job.completed_milestones}
            <span className="text-surface-500">/{job.milestone_count}</span>
            <span className="ml-1 text-sm text-surface-500">verified</span>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs tracking-[0.15em] text-surface-600 uppercase">
            Deadline
          </dt>
          <dd className="text-lg text-surface-100">
            {settled ? (
              <span className="text-sm text-surface-500">
                {new Date(job.deadline * 1000).toLocaleDateString()}
              </span>
            ) : (
              <Countdown job={job} />
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs tracking-[0.15em] text-surface-600 uppercase">
            {job.freelancer_stake > 0n ? "Stake held" : "Stake to accept"}
          </dt>
          <dd className="text-lg tabular-nums text-surface-100">
            {job.required_stake > 0n ? (
              <>
                {formatGen(
                  job.freelancer_stake > 0n
                    ? job.freelancer_stake
                    : job.required_stake,
                )}{" "}
                <span className="text-sm text-surface-500">GEN</span>
              </>
            ) : (
              <span className="text-sm text-surface-500">None required</span>
            )}
          </dd>
        </div>
        <AddressLine label="Client" address={job.client} />
        {isUnassigned(job.freelancer) ? (
          <div className="flex flex-col gap-1">
            <dt className="text-xs tracking-[0.15em] text-surface-600 uppercase">
              Freelancer
            </dt>
            <dd className="text-sm text-surface-500">Unassigned</dd>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <dt className="text-xs tracking-[0.15em] text-surface-600 uppercase">
              Freelancer
            </dt>
            <dd className="flex flex-col gap-0.5">
              <a
                href={explorerUrl("address", job.freelancer)}
                target="_blank"
                rel="noreferrer"
                className="value-mono text-sm text-orchid-400 transition-colors hover:text-orchid-300"
              >
                {shortAddress(job.freelancer)}
              </a>
              <Link
                href={`/reputation?address=${job.freelancer}`}
                className="text-xs text-surface-500 transition-colors hover:text-surface-300"
              >
                View record →
              </Link>
            </dd>
          </div>
        )}
      </dl>

      <section className="mt-10">
        <h2 className="text-xs tracking-[0.2em] text-surface-400 uppercase">
          Requirements
        </h2>
        <p className="mt-3 leading-relaxed whitespace-pre-wrap text-surface-300">
          {job.requirements}
        </p>
        <p className="mt-3 text-sm text-surface-500">
          This is the text every validator scores the deliverable against.
        </p>
      </section>

      {(canAccept || canCancel) && (
        <section className="mt-10 panel p-6">
          {canAccept ? (
            <div>
              <h2 className="text-base font-medium text-surface-100">
                Take this job
              </h2>
              <p className="mt-2 text-sm text-surface-400">
                Accepting assigns it to your wallet. The escrow is already
                locked, and each milestone pays out to you as it is verified.
              </p>

              {job.required_stake > 0n ? (
                // Stated before the wallet opens, not just inside the confirm
                // dialog: this transaction takes the freelancer's own money,
                // which no other action on this page does.
                <p className="mt-3 border-l-2 border-status-progress/50 py-1 pl-3 text-sm text-surface-300">
                  Accepting requires a{" "}
                  <span className="tabular-nums text-surface-100">
                    {formatGen(job.required_stake)} GEN
                  </span>{" "}
                  stake from your wallet. You get it back once every milestone
                  is verified — but if the deadline passes with work
                  outstanding, the client can claim it.
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => setConfirming("accept")}
                disabled={accept.busy}
                className="mt-4 btn btn-primary btn-sm"
              >
                {accept.busy
                  ? "Accepting…"
                  : job.required_stake > 0n
                    ? `Accept and stake ${formatGen(job.required_stake)} GEN`
                    : "Accept job"}
              </button>
            </div>
          ) : null}

          {canCancel ? (
            <div className={canAccept ? "mt-6 border-t border-surface-800 pt-6" : ""}>
              <h2 className="text-base font-medium text-surface-100">
                Cancel and refund
              </h2>
              <p className="mt-2 text-sm text-surface-400">
                Only possible while nobody has accepted the job. The full{" "}
                {formatGen(job.total_amount)} GEN returns to you — on
                finalization, which lags acceptance considerably.
              </p>
              <button
                type="button"
                onClick={() => setConfirming("cancel")}
                disabled={cancel.busy}
                className="btn btn-danger btn-sm mt-4"
              >
                {cancel.busy ? "Cancelling…" : "Cancel job and refund escrow"}
              </button>
            </div>
          ) : null}
        </section>
      )}

      {showAbandon ? (
        <section className="mt-10 panel-live p-6">
          <h2 className="text-base font-medium text-surface-100">
            Deadline passed — reclaim your escrow
          </h2>
          <p className="mt-2 text-sm text-surface-400">
            This job is{" "}
            <span className="text-surface-200">
              <Countdown job={job} />
            </span>{" "}
            and {job.milestone_count - job.completed_milestones} of{" "}
            {job.milestone_count} milestones are still unverified. Abandoning
            returns the{" "}
            <span className="tabular-nums text-surface-200">
              {formatGen(job.total_amount - job.paid_out)} GEN
            </span>{" "}
            still in escrow
            {job.freelancer_stake > 0n ? (
              <>
                , plus the freelancer&rsquo;s{" "}
                <span className="tabular-nums text-surface-200">
                  {formatGen(job.freelancer_stake)} GEN
                </span>{" "}
                stake
              </>
            ) : null}
            . Milestones already verified stay paid — the freelancer keeps what
            they delivered.
          </p>
          <button
            type="button"
            onClick={() => setConfirming("abandon")}
            disabled={abandon.busy}
            className="btn btn-danger btn-sm mt-4"
          >
            {abandon.busy ? "Abandoning…" : "Abandon job and reclaim escrow"}
          </button>
          <TransactionStatus state={abandon.state} />
        </section>
      ) : null}

      {job.status === "abandoned" ? (
        <div className="mt-10">
          <PayoutNotice
            amountBaseUnits={job.total_amount - job.paid_out}
            recipient={isClient ? "you" : "the client"}
            hash={abandon.state.phase === "done" ? abandon.state.hash : undefined}
          />
        </div>
      ) : null}

      {job.status === "cancelled" ? (
        <div className="mt-10">
          <PayoutNotice
            amountBaseUnits={job.total_amount}
            recipient={isClient ? "you" : "the client"}
            hash={cancel.state.phase === "done" ? cancel.state.hash : undefined}
          />
        </div>
      ) : null}

      <section className="mt-12">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-xs tracking-[0.2em] text-surface-400 uppercase">
            Milestones
          </h2>
          {isFreelancer ? (
            <span className="text-xs text-accent-400">
              You are the freelancer
            </span>
          ) : isClient ? (
            <span className="text-xs text-orchid-400">
              You are the client
            </span>
          ) : null}
        </div>

        <ul className="mt-4 space-y-4">
          {milestones.map((milestone, index) => (
            <MilestoneCard
              key={index}
              job={job}
              jobId={jobId}
              milestoneId={index}
              milestone={milestone}
              onChanged={refresh}
            />
          ))}
        </ul>
      </section>

      <ConfirmModal
        open={confirming === "accept"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          void handleAccept();
        }}
        title="Take this job?"
        summary={
          job.required_stake > 0n
            ? `You become the assigned freelancer on "${job.title}", and ${formatGen(job.required_stake)} GEN leaves your wallet as a stake.`
            : `You become the assigned freelancer on "${job.title}" and no one else can take it.`
        }
        details={[
          {
            label: "You deposit now",
            value:
              job.required_stake > 0n
                ? `${formatGen(job.required_stake)} GEN`
                : "Nothing",
          },
          { label: "Escrow you can earn", value: `${formatGen(job.total_amount)} GEN` },
          { label: "Milestones", value: String(job.milestone_count) },
          {
            label: "Deadline",
            value: new Date(job.deadline * 1000).toLocaleString(),
          },
        ]}
        effects={[
          "Your wallet asks you to approve the transaction.",
          ...(job.required_stake > 0n
            ? [
                `${formatGen(job.required_stake)} GEN is held by the contract as your stake.`,
                "You get the stake back once every milestone is verified.",
              ]
            : []),
          "The job moves to in progress and is locked to your address.",
          "You submit evidence per milestone, and each is verified and paid on its own.",
        ]}
        irreversible={
          job.required_stake > 0n
            ? `There is no way to hand a job back once accepted. If the deadline passes with work outstanding, the client can claim your ${formatGen(job.required_stake)} GEN stake.`
            : "There is no way to hand a job back once you have accepted it."
        }
        confirmLabel={
          job.required_stake > 0n
            ? `Stake ${formatGen(job.required_stake)} GEN and accept`
            : "Accept job"
        }
      />

      <ConfirmModal
        open={confirming === "abandon"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          void handleAbandon();
        }}
        title="Abandon this job?"
        summary={`"${job.title}" missed its deadline. This closes it and returns what is left of the escrow, plus the freelancer's stake, to you.`}
        details={[
          {
            label: "Escrow returned",
            value: `${formatGen(job.total_amount - job.paid_out)} GEN`,
          },
          {
            label: "Stake forfeited to you",
            value:
              job.freelancer_stake > 0n
                ? `${formatGen(job.freelancer_stake)} GEN`
                : "None was staked",
          },
          {
            label: "Milestones unverified",
            value: `${job.milestone_count - job.completed_milestones} of ${job.milestone_count}`,
          },
        ]}
        effects={[
          "Your wallet asks you to approve the transaction.",
          "The job is closed as abandoned and the freelancer loses their stake.",
          "Milestones already verified stay paid — they keep what they delivered.",
          "Funds arrive on finalization, which lags acceptance considerably.",
        ]}
        irreversible="The job cannot be reopened, and the freelancer cannot recover their stake."
        confirmLabel="Abandon and reclaim"
      />

      <ConfirmModal
        open={confirming === "cancel"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          void handleCancel();
        }}
        title="Cancel and refund?"
        summary={`This withdraws "${job.title}" and returns the full escrow to you.`}
        details={[
          { label: "Refund", value: `${formatGen(job.total_amount)} GEN` },
        ]}
        effects={[
          "Your wallet asks you to approve the transaction.",
          "The job is marked cancelled and disappears from the open list.",
          "The escrow returns to your wallet when the transaction finalizes, which is later than acceptance.",
        ]}
        confirmLabel="Cancel job"
      />

      <TxProgressModal
        state={accept.state}
        onClose={accept.reset}
        title="Accepting the job"
        successTitle="Job accepted"
        successBody="It is assigned to you. Submit evidence for the first milestone whenever it is ready."
        errorHint="Nothing changed. If the job was taken by someone else in the meantime, it will now read as in progress."
        onRetry={() => {
          accept.reset();
          setConfirming("accept");
        }}
      />

      <TxProgressModal
        state={cancel.state}
        onClose={cancel.reset}
        title="Cancelling the job"
        successTitle="Job cancelled"
        successBody="The escrow is on its way back to you. Transfers apply on finalization, so your balance will not change immediately."
        errorHint="The job was not cancelled. A job can only be cancelled while it is still open — if a freelancer accepted it just now, it no longer can be."
        onRetry={() => {
          cancel.reset();
          setConfirming("cancel");
        }}
      />
    </main>
  );
}
