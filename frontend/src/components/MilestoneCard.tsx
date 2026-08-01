"use client";

import { useState } from "react";
import { useContractWrite } from "@/hooks/useContractWrite";
import { useWallet } from "@/components/WalletProvider";
import { MilestoneStatusBadge } from "@/components/StatusBadge";
import { PayoutNotice } from "@/components/PayoutNotice";
import { ScoreDisplay } from "@/components/ScoreDisplay";
import { ConfirmModal } from "@/components/ConfirmModal";
import { TransactionStatus } from "@/components/TransactionStatus";
import { TxProgressModal } from "@/components/TxProgressModal";
import { sameAddress } from "@/lib/address";
import {
  VERIFY_TIMEOUT_MS,
  getMilestone,
  submitMilestone,
  verifyMilestone,
  waitForState,
} from "@/lib/contract";
import { formatGen } from "@/lib/units";
import {
  hasEvidence,
  milestonePayout,
  milestoneShare,
  REVIEW_DEPTHS,
  type Job,
  type Milestone,
} from "@/types";

const inputClass =
  "input w-full";

const labelClass =
  "text-xs tracking-[0.15em] text-surface-400 uppercase";

function EvidenceLink({ label, url }: { label: string; url: string }) {
  if (!hasEvidence(url)) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs tracking-[0.15em] text-surface-600 uppercase">
        {label}
      </span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-sm break-all text-orchid-400 transition-colors hover:text-orchid-300"
      >
        {url}
      </a>
    </div>
  );
}

/**
 * Evidence form. Which URLs are supplied decides which criteria run at all, so
 * the copy explains the trade rather than treating the fields as optional trivia.
 */
function SubmitForm({
  jobId,
  milestoneId,
  onChanged,
  isResubmission,
}: {
  jobId: number;
  milestoneId: number;
  onChanged: () => Promise<void>;
  isResubmission: boolean;
}) {
  const [githubUrl, setGithubUrl] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [mockupUrl, setMockupUrl] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const { state, run, busy } = useContractWrite();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);

    // `verify_milestone` refuses to run with neither repo nor site, which would
    // strand the milestone as submitted. Catch it before it costs a transaction.
    if (!githubUrl.trim() && !siteUrl.trim()) {
      setLocalError(
        "Give at least a repository or a deployed site — validators need something to assess.",
      );
      return;
    }

    await run(
      (account) =>
        submitMilestone({
          account,
          jobId,
          milestoneId,
          githubUrl,
          siteUrl,
          mockupUrl,
        }),
      {
        onAccepted: async () => {
          await waitForState(
            () => getMilestone(jobId, milestoneId),
            (m) => m.status === "submitted",
            "the submission to appear on chain",
          );
          await onChanged();
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
      <p className="text-sm text-surface-400">
        {isResubmission
          ? "Address the gaps and submit again — a rejected milestone can be resubmitted as many times as you need."
          : "What you attach decides what gets scored."}{" "}
        A repo alone is scored on code and completeness; adding a deployed site
        brings in functionality; adding a mockup brings in design match.
      </p>

      <div>
        <label htmlFor={`gh-${jobId}-${milestoneId}`} className={labelClass}>
          Repository
        </label>
        <input
          id={`gh-${jobId}-${milestoneId}`}
          value={githubUrl}
          onChange={(event) => setGithubUrl(event.target.value)}
          placeholder="https://github.com/you/project"
          className={`mt-2 ${inputClass}`}
        />
      </div>

      <div>
        <label htmlFor={`site-${jobId}-${milestoneId}`} className={labelClass}>
          Deployed site
        </label>
        <input
          id={`site-${jobId}-${milestoneId}`}
          value={siteUrl}
          onChange={(event) => setSiteUrl(event.target.value)}
          placeholder="https://project.vercel.app"
          className={`mt-2 ${inputClass}`}
        />
      </div>

      <div>
        <label htmlFor={`mock-${jobId}-${milestoneId}`} className={labelClass}>
          Mockup <span className="text-surface-600">— optional</span>
        </label>
        <input
          id={`mock-${jobId}-${milestoneId}`}
          value={mockupUrl}
          onChange={(event) => setMockupUrl(event.target.value)}
          placeholder="https://figma.com/file/…"
          className={`mt-2 ${inputClass}`}
        />
        <p className="mt-1.5 text-sm text-surface-500">
          Supplying one makes verification screenshot both this and your site
          and compare them. Without it, design match is not scored.
        </p>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="btn btn-primary btn-sm"
      >
        {busy ? "Submitting…" : "Submit for review"}
      </button>

      {localError ? (
        <p role="alert" className="text-sm text-status-rejected">
          {localError}
        </p>
      ) : null}

      <TransactionStatus state={state} />
    </form>
  );
}

export function MilestoneCard({
  job,
  jobId,
  milestoneId,
  milestone,
  onChanged,
}: {
  job: Job;
  jobId: number;
  milestoneId: number;
  milestone: Milestone;
  onChanged: () => Promise<void>;
}) {
  const { account } = useWallet();
  const verify = useContractWrite();

  const isFreelancer = sameAddress(account, job.freelancer);
  const canSubmit =
    isFreelancer &&
    job.status === "in_progress" &&
    (milestone.status === "pending" || milestone.status === "rejected");
  const canVerify = Boolean(account) && milestone.status === "submitted";
  const [confirmingVerify, setConfirmingVerify] = useState(false);
  const scored = milestone.status === "verified" || milestone.status === "rejected";

  const share = milestoneShare(job.total_amount, milestone.percentage);
  const payout = milestonePayout(
    job.total_amount,
    milestone.percentage,
    milestone.scores.final_weighted,
  );

  // Verification is the slowest and most consequential action in the app: it
  // costs gas, takes minutes, and its score decides whether money moves. It
  // gets a confirmation.
  async function handleVerify() {
    await verify.run(
      (account) => verifyMilestone(account, jobId, milestoneId),
      {
        // One LLM prompt and up to four page renders on the leader, plus a
        // re-fetch on every validator. Minutes, not seconds — a minimal
        // verification measured 194s on Bradbury.
        timeoutMs: VERIFY_TIMEOUT_MS,
        onAccepted: async () => {
          await waitForState(
            () => getMilestone(jobId, milestoneId),
            (m) => m.status !== "submitted",
            "the verdict to appear on chain",
          );
          await onChanged();
        },
      },
    );
  }

  return (
    <li className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-[0.15em] text-surface-600 uppercase">
            Milestone {milestoneId + 1}
          </p>
          <h3 className="mt-1.5 text-lg font-medium text-surface-100">
            {milestone.description}
          </h3>
        </div>
        <MilestoneStatusBadge status={milestone.status} />
      </div>

      <p className="mt-3 text-sm text-surface-400 tabular-nums">
        {milestone.percentage}% of escrow
        <span className="text-surface-600"> · {formatGen(share)} GEN</span>
      </p>

      {(hasEvidence(milestone.github_url) ||
        hasEvidence(milestone.site_url) ||
        hasEvidence(milestone.mockup_url)) && (
        <div className="mt-5 space-y-3 border-t border-surface-800 pt-5">
          <EvidenceLink label="Repository" url={milestone.github_url} />
          <EvidenceLink label="Deployed site" url={milestone.site_url} />
          <EvidenceLink label="Mockup" url={milestone.mockup_url} />
        </div>
      )}

      {scored ? (
        <div className="mt-5">
          <ScoreDisplay milestone={milestone} />
        </div>
      ) : null}

      {scored ? (
        // Attached to the verdict rather than to the job header alone, because
        // this is the number the depth actually qualifies: how much of the
        // repository was in front of the reviewer when it scored.
        <p className="mt-3 text-xs text-surface-500">
          Verified by {REVIEW_DEPTHS[job.review_depth].label.toLowerCase()} —{" "}
          {REVIEW_DEPTHS[job.review_depth].reads}.
        </p>
      ) : null}

      {scored && milestone.reasoning ? (
        <details className="mt-5 border-t border-surface-800 pt-5">
          <summary className="cursor-pointer text-sm font-medium text-surface-200">
            Reviewer&rsquo;s reasoning
          </summary>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-surface-300">
            {milestone.reasoning}
          </p>
          {/*
            Stated plainly rather than presented as proof. The citations are
            checkable — that is the point of recording them — but they are the
            reviewing validator's account, and other validators confirm only
            that it scored evidence they can fetch too, never this prose.
          */}
          <p className="mt-3 text-xs text-surface-500">
            Written by the reviewing validator, quoting the files and line
            numbers it was shown. Open the repository above to check any
            citation.
          </p>
        </details>
      ) : null}

      {milestone.status === "verified" ? (
        <PayoutNotice
          amountBaseUnits={payout}
          recipient={isFreelancer ? "you" : "the freelancer"}
          // Only this session's own verification has a hash to track; after a
          // reload the notice still explains the pending step.
          hash={verify.state.phase === "done" ? verify.state.hash : undefined}
        />
      ) : null}

      {milestone.status === "rejected" ? (
        <p className="mt-4 border border-status-rejected/30 bg-status-rejected/5 p-4 text-sm text-surface-300">
          Scored below 70, so no escrow was released. The freelancer can revise
          the work and submit this milestone again.
        </p>
      ) : null}

      {canVerify ? (
        <div className="mt-5 border-t border-surface-800 pt-5">
          <p className="text-sm text-surface-400">
            Verification reads the repository, renders the site, screenshots
            it against the mockup when one was supplied, and scores all four
            criteria against the job&rsquo;s requirements in a single pass.
            Other validators independently re-fetch the same pages and confirm
            the score was based on them. Anyone can trigger it; whoever does
            pays the gas. Expect minutes, not seconds.
          </p>
          <button
            type="button"
            onClick={() => setConfirmingVerify(true)}
            disabled={verify.busy}
            className="mt-4 btn btn-primary btn-sm"
          >
            {verify.busy ? "Validators working…" : "Run verification"}
          </button>
        </div>
      ) : null}

      {canSubmit ? (
        <div className="border-t border-surface-800 pt-5">
          <SubmitForm
            jobId={jobId}
            milestoneId={milestoneId}
            onChanged={onChanged}
            isResubmission={milestone.status === "rejected"}
          />
        </div>
      ) : null}

      {milestone.status === "submitted" && !account ? (
        <p className="mt-5 border-t border-surface-800 pt-5 text-sm text-surface-500">
          Connect a wallet to run verification on this milestone.
        </p>
      ) : null}
      <ConfirmModal
        open={confirmingVerify}
        onCancel={() => setConfirmingVerify(false)}
        onConfirm={() => {
          setConfirmingVerify(false);
          void handleVerify();
        }}
        title="Run verification?"
        summary={`Validators will score "${milestone.description}" against the job's requirements, and the score decides whether escrow is released.`}
        details={[
          { label: "Milestone share", value: `${milestone.percentage}% · ${formatGen(share)} GEN` },
          { label: "Pays out at", value: "70 or above" },
          // Whoever presses this pays the gas and waits, and a deep review is
          // the slower of the two — say so before the wallet opens.
          {
            label: "Review depth",
            value: `${REVIEW_DEPTHS[job.review_depth].label} · ${REVIEW_DEPTHS[job.review_depth].reads}`,
          },
        ]}
        effects={[
          "Your wallet asks you to approve the transaction — you pay the gas, whoever you are.",
          "Validators fetch the evidence, score it, and agree they saw the same pages. This takes minutes, not seconds.",
          "At 70 or above the milestone is verified and its share is released; below 70 it is rejected and can be resubmitted.",
        ]}
        irreversible="The score is written on chain and this evidence is only scored once. Check the URLs are public and correct before running it."
        confirmLabel="Verify milestone"
      />

      <TxProgressModal
        state={verify.state}
        onClose={verify.reset}
        title="Verifying the milestone"
        successTitle="Verdict recorded"
        successBody="The scores are on chain. If the milestone passed, its share of the escrow is released to the freelancer when the transaction finalizes."
        errorHint="No verdict was recorded and nothing was released. If the evidence URLs are private or unreachable, fix them, resubmit the milestone, and verify again."
        onRetry={() => {
          verify.reset();
          setConfirmingVerify(true);
        }}
      />
    </li>
  );
}
