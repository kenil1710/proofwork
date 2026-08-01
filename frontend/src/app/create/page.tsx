"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ConfirmModal } from "@/components/ConfirmModal";
import { GLOSSARY, Tooltip } from "@/components/Tooltip";
import { TransactionStatus } from "@/components/TransactionStatus";
import { TxProgressModal } from "@/components/TxProgressModal";
import { useWallet } from "@/components/WalletProvider";
import { useContractWrite } from "@/hooks/useContractWrite";
import { sameAddress } from "@/lib/address";
import {
  createJob,
  getJob,
  getJobCount,
  MILESTONE_SEPARATOR,
  waitForState,
} from "@/lib/contract";
import { explorerUrl } from "@/lib/genlayer";
import { formatGen, parseGen } from "@/lib/units";
import { MAX_STAKE_PCT, REVIEW_DEPTHS } from "@/types";
import type { ReviewDepth } from "@/types";

type MilestoneDraft = { id: number; description: string; percentage: string };

/**
 * Field styling WITHOUT a width, so callers set their own.
 *
 * Keeping width out of here is load-bearing. When the base carried `w-full`,
 * a narrower field written as `"w-20 … " + inputClass` still rendered full
 * width: class order in the attribute does not decide precedence, stylesheet
 * order does, and Tailwind emits `w-full` after `w-20`. The milestone
 * percentage box won that fight and squeezed the description input next to it
 * down to a ~25px sliver, which read as "the description field is missing".
 */
const inputBaseClass = "input";

const inputClass = `w-full ${inputBaseClass}`;

const labelClass =
  "text-xs tracking-[0.15em] text-surface-400 uppercase";

const hintClass = "mt-1.5 text-sm text-surface-500";

/** Whole numbers only — the contract does `int(p.strip())` on each. */
function parsePercentage(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed > 0 && parsed <= 100 ? parsed : null;
}

/**
 * `create_job` takes no mockup argument — the contract only stores a mockup URL
 * per milestone, supplied by the freelancer at submission. Folding the client's
 * reference design into the requirements text is what puts it on chain, and
 * requirements is the field every validator prompt reads.
 */
function composeRequirements(requirements: string, mockupUrl: string): string {
  const design = mockupUrl.trim();
  const body = requirements.trim();
  return design ? `${body}\n\nReference design: ${design}` : body;
}

export default function CreateJobPage() {
  const { account, walletAvailable, connecting, connect } = useWallet();

  const [title, setTitle] = useState("");
  const [requirements, setRequirements] = useState("");
  const [mockupUrl, setMockupUrl] = useState("");
  const [deposit, setDeposit] = useState("");
  // Defaults that are sane rather than empty: a week is a normal turnaround and
  // 10% is enough of a stake to deter a no-show without pricing out freelancers.
  const [deadlineDays, setDeadlineDays] = useState("7");
  const [stakePct, setStakePct] = useState("10");
  // Quick by default. Deep costs the freelancer nothing, but it costs every
  // validator real fetches and a much longer prompt, so it is opted into for
  // the jobs that warrant it rather than paid for on every small one.
  const [reviewDepth, setReviewDepth] = useState<ReviewDepth>("quick");
  // Start with a single milestone at the full 100. Most jobs are one
  // deliverable, and a valid-by-default form is better than one that opens
  // already failing its own total check.
  const nextId = useRef(1);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([
    { id: 0, description: "", percentage: "100" },
  ]);

  const create = useContractWrite();
  /** Id of the job just created, when it could be pinned down. */
  const [newJobId, setNewJobId] = useState<number | null>(null);
  // Hold field errors back until the first submit, so the form doesn't scold
  // someone who has only just started typing.
  const [showErrors, setShowErrors] = useState(false);
  // Sits between a valid form and the wallet. Locking escrow is the one action
  // here that cannot be undone if it goes wrong, so it gets a stated summary of
  // what is about to happen rather than going straight to a signature prompt.
  const [confirming, setConfirming] = useState(false);

  const percentTotal = useMemo(
    () =>
      milestones.reduce(
        (sum, milestone) => sum + (parsePercentage(milestone.percentage) ?? 0),
        0,
      ),
    [milestones],
  );

  const validation = useMemo(() => {
    const milestoneErrors = milestones.map((milestone) => {
      if (!milestone.description.trim()) return "Describe this milestone.";
      if (milestone.description.includes(MILESTONE_SEPARATOR)) {
        return `Cannot contain "${MILESTONE_SEPARATOR}".`;
      }
      if (parsePercentage(milestone.percentage) === null) {
        return "Share must be a whole number between 1 and 100.";
      }
      return null;
    });

    let depositBaseUnits: bigint | null = null;
    let depositError: string | null = null;
    try {
      depositBaseUnits = parseGen(deposit);
    } catch (error) {
      depositError = error instanceof Error ? error.message : "Invalid amount.";
    }

    // Both of these revert on chain, and a reverting create keeps the deposit,
    // so they are enforced here before anything reaches the network.
    const days = Number(deadlineDays.trim());
    const deadlineError =
      /^\d+$/.test(deadlineDays.trim()) && days >= 1
        ? null
        : "Give a whole number of days, at least 1.";

    const pct = Number(stakePct.trim());
    const stakeError =
      /^\d+$/.test(stakePct.trim()) && pct >= 0 && pct <= MAX_STAKE_PCT
        ? null
        : `Stake must be a whole number between 0 and ${MAX_STAKE_PCT}.`;

    return {
      title: title.trim() ? null : "Give the job a title.",
      requirements: requirements.trim()
        ? null
        : "Describe the work — this is the text validators score against.",
      milestones: milestoneErrors,
      percentTotal:
        percentTotal === 100 ? null : `Shares must total 100 — currently ${percentTotal}.`,
      deposit: depositError,
      depositBaseUnits,
      deadline: deadlineError,
      deadlineDays: deadlineError ? null : days,
      stake: stakeError,
      stakePercentage: stakeError ? null : pct,
    };
  }, [title, requirements, deposit, milestones, percentTotal, deadlineDays, stakePct]);

  const isValid =
    !validation.title &&
    !validation.requirements &&
    !validation.percentTotal &&
    !validation.deposit &&
    !validation.deadline &&
    !validation.stake &&
    validation.milestones.every((error) => error === null);

  /**
   * What a freelancer will have to stake, shown live under the slider.
   *
   * Mirrors the contract's truncating arithmetic (divide by 100 first, then
   * multiply) so the figure quoted here is exactly the value `accept_job`
   * will demand — the contract requires an exact match, not a minimum.
   */
  const stakeBaseUnits =
    validation.depositBaseUnits !== null && validation.stakePercentage !== null
      ? (validation.depositBaseUnits / 100n) * BigInt(validation.stakePercentage)
      : null;

  function updateMilestone(id: number, patch: Partial<MilestoneDraft>) {
    setMilestones((current) =>
      current.map((milestone) =>
        milestone.id === id ? { ...milestone, ...patch } : milestone,
      ),
    );
  }

  function addMilestone() {
    setMilestones((current) => [
      ...current,
      { id: nextId.current++, description: "", percentage: "" },
    ]);
  }

  function removeMilestone(id: number) {
    setMilestones((current) => current.filter((milestone) => milestone.id !== id));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (!account || !isValid || validation.depositBaseUnits === null) return;
    setConfirming(true);
  }

  async function send() {
    setConfirming(false);
    if (!account || !isValid || validation.depositBaseUnits === null) return;

    const submittedTitle = title.trim();
    const depositBaseUnits = validation.depositBaseUnits;

    // Ids are dense and 0-based, so the job about to be created lands at the
    // current count. Only used to link to it afterwards, so a failure here
    // costs nothing.
    let expectedId: number | null = null;
    try {
      expectedId = await getJobCount();
    } catch {
      expectedId = null;
    }

    await create.run(
      (account) =>
        createJob({
          account,
          title: submittedTitle,
          requirements: composeRequirements(requirements, mockupUrl),
          milestoneDescriptions: milestones.map((m) => m.description.trim()),
          milestonePercentages: milestones.map(
            (m) => parsePercentage(m.percentage) as number,
          ),
          depositBaseUnits,
          deadlineDays: validation.deadlineDays as number,
          stakePercentage: validation.stakePercentage as number,
          reviewDepth,
        }),
      {
        onAccepted: async () => {
          if (expectedId === null) return;
          try {
            await waitForState(
              () => getJob(expectedId),
              (job) =>
                sameAddress(job.client, account) && job.title === submittedTitle,
              "the new job to become readable",
              { timeoutMs: 60_000 },
            );
            setNewJobId(expectedId);
          } catch {
            // The job was created — we just could not pin its id, which happens
            // if someone else's create landed in between. Not worth failing the
            // whole flow for a convenience link.
          }
        },
      },
    );
  }

  function resetForm() {
    create.reset();
    setNewJobId(null);
    setShowErrors(false);
    setTitle("");
    setRequirements("");
    setMockupUrl("");
    setDeposit("");
    // Same shape the form opens with — one milestone at the full 100.
    setMilestones([
      { id: nextId.current++, description: "", percentage: "100" },
    ]);
  }

  if (create.state.phase === "done") {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16 sm:py-24">
        <div className="panel-live p-8">
          <p className="eyebrow text-accent-400">
            Escrow locked
          </p>
          <h1 className="title-display mt-3 text-surface-100">
            Your job is open for freelancers.
          </h1>
          <p className="mt-3 text-surface-400">
            {formatGen(validation.depositBaseUnits ?? 0n)} GEN is held in escrow
            and releases milestone by milestone, as validators verify the work.
          </p>

          <a
            href={explorerUrl("tx", create.state.hash)}
            target="_blank"
            rel="noreferrer"
            className="value-mono mt-6 block text-xs break-all text-orchid-400 hover:text-orchid-300"
          >
            {create.state.hash}
          </a>

          <div className="mt-8 flex flex-wrap gap-3">
            {newJobId !== null ? (
              <Link
                href={`/job/${newJobId}`}
                className="btn btn-primary btn-sm"
              >
                View job {newJobId}
              </Link>
            ) : null}
            <Link
              href="/"
              className={`btn btn-sm ${
                newJobId === null
                  ? "btn-primary"
                  : "btn-ghost"
              }`}
            >
              Back to dashboard
            </Link>
            <button
              type="button"
              onClick={resetForm}
              className="btn btn-ghost btn-sm"
            >
              Post another
            </button>
          </div>
        </div>
      </main>
    );
  }

  const busy = create.busy;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12 sm:py-16">
      <Breadcrumbs
        trail={[{ label: "ProofWork", href: "/" }, { label: "Post a job" }]}
      />
      <p className="eyebrow text-orchid-400">
        New job
      </p>
      <h1 className="title-display mt-3 text-surface-100">
        Describe the work, lock the escrow.
      </h1>
      <p className="mt-4 leading-relaxed text-surface-400">
        Whatever you write in the requirements is exactly what the validators
        score the deliverable against. Be specific about what must exist and how
        you would tell it was done.
      </p>

      <form onSubmit={handleSubmit} className="mt-12 space-y-10" noValidate>
        <div>
          <label htmlFor="title" className={labelClass}>
            Title
          </label>
          <input
            id="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Build a portfolio website"
            className={`mt-2 ${inputClass}`}
            aria-invalid={showErrors && Boolean(validation.title)}
          />
          {showErrors && validation.title ? (
            <p role="alert" className="mt-1.5 text-sm text-status-rejected">
              {validation.title}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="requirements" className={labelClass}>
            Requirements
          </label>
          <textarea
            id="requirements"
            value={requirements}
            onChange={(event) => setRequirements(event.target.value)}
            rows={7}
            placeholder="React + Tailwind. Responsive down to 375px. Contact form posts to /api/contact and shows a success state…"
            className={`mt-2 resize-y ${inputClass}`}
            aria-invalid={showErrors && Boolean(validation.requirements)}
          />
          <p className={hintClass}>
            Scored by AI validators on code quality, design match, functionality
            and completeness. Vague requirements produce vague scores.
          </p>
          {showErrors && validation.requirements ? (
            <p role="alert" className="mt-1.5 text-sm text-status-rejected">
              {validation.requirements}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="mockup" className={labelClass}>
            Reference design <span className="text-surface-600">— optional</span>
          </label>
          <input
            id="mockup"
            value={mockupUrl}
            onChange={(event) => setMockupUrl(event.target.value)}
            placeholder="https://figma.com/file/…"
            className={`mt-2 ${inputClass}`}
          />
          <p className={hintClass}>
            Appended to the requirements above, since the contract stores design
            links there. The freelancer supplies the mockup used for the visual
            comparison when they submit each milestone.
          </p>
        </div>

        <fieldset>
          <div className="flex items-baseline justify-between gap-4">
            <legend className={labelClass}>Milestones</legend>
            <span
              className={`text-xs tabular-nums ${ percentTotal === 100 ?"text-accent-400":"text-status-rejected"}`}
            >
              {percentTotal} / 100
            </span>
          </div>
          <p className={hintClass}>
            Break the work into checkpoints. AI verifies each milestone against
            its description, so be specific — vague descriptions get vague
            scores. Each milestone releases its share of the escrow once
            verified, and the shares must total exactly 100.
          </p>

          <div className="mt-4 space-y-3">
            {milestones.map((milestone, index) => {
              // The pipe check fires as you type rather than waiting for submit:
              // the contract splits descriptions on "|", so a stray one silently
              // creates extra milestones and reverts on chain. Worth catching at
              // the keystroke, unlike an empty field which just means "not
              // finished yet".
              const pipeError = milestone.description.includes(
                MILESTONE_SEPARATOR,
              );
              const fieldError = showErrors
                ? validation.milestones[index]
                : null;

              return (
                <div
                  key={milestone.id}
                  className="panel p-4"
                >
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-xs tracking-[0.15em] text-surface-500 uppercase">
                      Milestone {index + 1}
                    </p>
                    <button
                      type="button"
                      onClick={() => removeMilestone(milestone.id)}
                      disabled={milestones.length === 1}
                      aria-label={`Remove milestone ${index + 1}`}
                      className="border border-surface-700 px-2 py-1 text-xs text-surface-500 transition-colors hover:border-status-rejected hover:text-status-rejected disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-surface-700 disabled:hover:text-surface-500"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="mt-3">
                    <label
                      htmlFor={`ms-desc-${milestone.id}`}
                      className="text-sm text-surface-300"
                    >
                      Description
                    </label>
                    <input
                      id={`ms-desc-${milestone.id}`}
                      value={milestone.description}
                      onChange={(event) =>
                        updateMilestone(milestone.id, {
                          description: event.target.value,
                        })
                      }
                      placeholder="e.g., Homepage and navigation with hero section"
                      className={`mt-1.5 ${inputClass}`}
                    />
                  </div>

                  <div className="mt-3">
                    <label
                      htmlFor={`ms-pct-${milestone.id}`}
                      className="text-sm text-surface-300"
                    >
                      Percentage
                    </label>
                    <div className="mt-1.5 flex items-center gap-2">
                      <input
                        id={`ms-pct-${milestone.id}`}
                        value={milestone.percentage}
                        onChange={(event) =>
                          updateMilestone(milestone.id, {
                            percentage: event.target.value,
                          })
                        }
                        inputMode="numeric"
                        placeholder="100"
                        className={`w-24 text-center tabular-nums ${inputBaseClass}`}
                      />
                      <span className="text-sm text-surface-500">%</span>
                    </div>
                  </div>

                  {pipeError ? (
                    <p role="alert" className="mt-2 text-sm text-status-rejected">
                      Remove the &ldquo;{MILESTONE_SEPARATOR}&rdquo; — the
                      contract splits milestone descriptions on that character.
                    </p>
                  ) : fieldError ? (
                    <p role="alert" className="mt-2 text-sm text-status-rejected">
                      {fieldError}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={addMilestone}
            className="mt-3 border border-dashed border-surface-700 px-3 py-2 text-xs text-surface-400 transition-colors hover:border-orchid-400 hover:text-surface-100"
          >
            + Add milestone
          </button>

          {showErrors && validation.percentTotal ? (
            <p role="alert" className="mt-3 text-sm text-status-rejected">
              {validation.percentTotal}
            </p>
          ) : null}
        </fieldset>

        <div>
          <label htmlFor="deposit" className={labelClass}>
            Escrow deposit
          </label>
          <div className="relative mt-2">
            <input
              id="deposit"
              value={deposit}
              onChange={(event) => setDeposit(event.target.value)}
              inputMode="decimal"
              placeholder="0.05"
              className={`pr-16 tabular-nums ${inputClass}`}
              aria-invalid={showErrors && Boolean(validation.deposit)}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-surface-500">
              GEN
            </span>
          </div>
          <p className={hintClass}>
            Transferred on submit and held in{" "}
            <Tooltip term="escrow">{GLOSSARY.escrow}</Tooltip> by the contract.
            Refundable in full while the job is still open.{" "}
            <Tooltip term="GEN">{GLOSSARY.gen}</Tooltip> here has no real-world
            value.
          </p>
          {showErrors && validation.deposit ? (
            <p role="alert" className="mt-1.5 text-sm text-status-rejected">
              {validation.deposit}
            </p>
          ) : null}
        </div>

        {/* ── Anti-scam terms ─────────────────────────────────────────────
            Grouped rather than scattered among the other fields: they are one
            idea — what happens if the freelancer does not deliver — and a
            client deciding on a stake should see the deadline beside it. */}
        <fieldset className="panel p-5">
          <legend className={`${labelClass} px-2`}>If work is not delivered</legend>

          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            <div>
              <label htmlFor="deadline-days" className={labelClass}>
                Deadline
              </label>
              <div className="relative mt-2">
                <input
                  id="deadline-days"
                  value={deadlineDays}
                  onChange={(event) => setDeadlineDays(event.target.value)}
                  inputMode="numeric"
                  min={1}
                  type="number"
                  className={`pr-14 tabular-nums ${inputClass}`}
                  aria-invalid={showErrors && Boolean(validation.deadline)}
                  aria-describedby="deadline-hint"
                />
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-surface-500">
                  days
                </span>
              </div>
              <p id="deadline-hint" className={hintClass}>
                Every milestone must be verified within this window. After it
                passes you can reclaim the escrow and the freelancer&rsquo;s
                stake.
              </p>
              {showErrors && validation.deadline ? (
                <p role="alert" className="mt-1.5 text-sm text-status-rejected">
                  {validation.deadline}
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="stake-pct" className={labelClass}>
                <Tooltip term="Freelancer stake">
                  Freelancer must deposit this % of escrow to accept. Protects
                  against scammers who accept but don&rsquo;t deliver.
                </Tooltip>
              </label>
              <div className="mt-2 flex items-center gap-3">
                <input
                  id="stake-pct"
                  type="range"
                  min={0}
                  max={MAX_STAKE_PCT}
                  step={1}
                  value={/^\d+$/.test(stakePct) ? stakePct : "10"}
                  onChange={(event) => setStakePct(event.target.value)}
                  className="h-1 w-full flex-1 cursor-pointer appearance-none rounded-full bg-surface-800 accent-orchid-400"
                  aria-describedby="stake-hint"
                />
                <span className="w-12 shrink-0 text-right text-sm tabular-nums text-surface-100">
                  {stakePct || 0}%
                </span>
              </div>
              <p id="stake-hint" className={hintClass}>
                {stakeBaseUnits !== null && stakeBaseUnits > 0n ? (
                  <>
                    A freelancer will have to stake{" "}
                    <span className="text-surface-200 tabular-nums">
                      {formatGen(stakeBaseUnits)} GEN
                    </span>{" "}
                    to accept. They get it back when every milestone is
                    verified, and forfeit it to you if they miss the deadline.
                  </>
                ) : (
                  <>
                    No stake required — anyone can accept and walk away at no
                    cost to themselves. Raise it to deter no-shows.
                  </>
                )}
              </p>
              {showErrors && validation.stake ? (
                <p role="alert" className="mt-1.5 text-sm text-status-rejected">
                  {validation.stake}
                </p>
              ) : null}
            </div>
          </div>
        </fieldset>

        {/* ── Review depth ────────────────────────────────────────────────
            Fixed at creation and not changeable later, because every
            validator has to derive the same reading plan from stored state —
            so this radio is the only chance to choose it. Said plainly on the
            control rather than left to the docs. */}
        <fieldset className="panel p-5">
          <legend className={`${labelClass} px-2`}>How thoroughly to verify</legend>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {(["quick", "deep"] as const).map((value) => {
              const depth = REVIEW_DEPTHS[value];
              const selected = reviewDepth === value;
              return (
                <label
                  key={value}
                  className={`flex cursor-pointer gap-3 border p-4 transition-colors ${
                    selected
                      ? "border-orchid-400/60 bg-orchid-400/5"
                      : "border-surface-800 hover:border-surface-700"
                  }`}
                >
                  <input
                    type="radio"
                    name="review-depth"
                    value={value}
                    checked={selected}
                    onChange={() => setReviewDepth(value)}
                    className="mt-1 h-4 w-4 shrink-0 accent-orchid-400"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-surface-100">
                      {depth.label}
                      {value === "quick" ? (
                        <span className="text-surface-500"> — default</span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-sm text-surface-400">
                      {depth.summary} {depth.detail}
                    </span>
                    <span className="mt-2 block text-xs text-surface-500 tabular-nums">
                      {depth.reads} · verification takes {depth.estimate}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <p className={hintClass}>
            This is fixed once the job is created — every validator reads the
            same amount of the repository, so it cannot be changed per
            milestone or per verification.
          </p>
        </fieldset>

        <div className="border-t border-surface-800 pt-8">
          {!walletAvailable ? (
            <p className="text-sm text-surface-400">
              A browser wallet is required to lock escrow.{" "}
              <a
                href="https://metamask.io/download/"
                target="_blank"
                rel="noreferrer"
                className="text-orchid-400 hover:text-orchid-300"
              >
                Install MetaMask
              </a>
              .
            </p>
          ) : !account ? (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={connecting}
              className="btn btn-primary"
            >
              {connecting ? "Connecting…" : "Connect wallet to continue"}
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary"
            >
              {busy ? "Posting…" : "Lock escrow and post job"}
            </button>
          )}

          {/* Narrates the wait, including the wallet prompt that appears if the
              validator round stalls and has to be nudged. */}
          <TransactionStatus state={create.state} />
        </div>
      </form>

      <ConfirmModal
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void send()}
        title="Lock the escrow?"
        summary={`This posts "${title.trim()}" and transfers the deposit to the contract in one transaction.`}
        details={[
          { label: "Deposit", value: `${deposit.trim() || "0"} GEN` },
          {
            label: "Milestones",
            value: `${milestones.length} · ${milestones
              .map((m) => `${parsePercentage(m.percentage) ?? 0}%`)
              .join(" / ")}`,
          },
          // Listed here because it cannot be changed afterwards, and the
          // confirmation is the last point at which a client can go back.
          {
            label: "Verification",
            value: `${REVIEW_DEPTHS[reviewDepth].label} · ${REVIEW_DEPTHS[reviewDepth].reads}`,
          },
        ]}
        effects={[
          "Your wallet asks you to approve the transaction and the deposit.",
          "Validators accept it and the job becomes visible to freelancers.",
          "Any wallet except yours can then accept the job and start work.",
        ]}
        irreversible="Once a freelancer accepts, the escrow is committed and cannot be refunded. You can cancel and get it all back only while the job is still open."
        confirmLabel="Lock escrow and post"
      />

      <TxProgressModal
        state={create.state}
        onClose={create.reset}
        title="Posting your job"
        successTitle="Job posted"
        successBody="The escrow is locked and the job is live. Freelancers can accept it now."
        successAction={
          newJobId === null
            ? { label: "Back to dashboard", href: "/" }
            : { label: `View job ${newJobId}`, href: `/job/${newJobId}` }
        }
        errorHint="Nothing was posted. If your wallet reported the deposit as sent, check the explorer before retrying."
        onRetry={() => {
          create.reset();
          setConfirming(true);
        }}
      />
    </main>
  );
}
