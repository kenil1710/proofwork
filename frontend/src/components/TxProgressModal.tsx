"use client";

import Link from "next/link";
import { useId } from "react";
import { Modal } from "@/components/Modal";
import type { WriteState } from "@/hooks/useContractWrite";
import { explorerUrl } from "@/lib/genlayer";

/**
 * Narrates one transaction from wallet prompt to settled state.
 *
 * The steps map to `WriteState`'s real phases rather than a decorative
 * progress bar — nothing here advances on a timer. The estimates are measured
 * on Bradbury, not aspirational: an ordinary write settles in 10-40s, and a
 * verification took 194s in testing.
 *
 * While a transaction is in flight the dialog cannot be dismissed. Closing it
 * would not cancel anything, and offering an X that silently abandons a
 * transaction the user still owns is worse than making them watch.
 */
type StepId = "signing" | "consensus" | "reading" | "done";

const STEPS: { id: StepId; label: string; estimate: string }[] = [
  { id: "signing", label: "Signing in your wallet", estimate: "you approve" },
  {
    id: "consensus",
    label: "Validators reaching consensus",
    estimate: "10–40s, longer for verification",
  },
  { id: "reading", label: "Reading the result back", estimate: "a few seconds" },
  { id: "done", label: "Settled on chain", estimate: "" },
];

function activeStep(state: WriteState): StepId | null {
  switch (state.phase) {
    case "signing":
      return "signing";
    case "waiting":
      return "consensus";
    case "settling":
      return "reading";
    case "done":
      return "done";
    default:
      return null;
  }
}

const ORDER: StepId[] = ["signing", "consensus", "reading", "done"];

export function TxProgressModal({
  state,
  onClose,
  title,
  /** Shown once settled — what actually changed. */
  successTitle,
  successBody,
  /** Optional link offered on success, e.g. through to the new job. */
  successAction,
  /** Extra guidance shown under an error, specific to this action. */
  errorHint,
  onRetry,
}: {
  state: WriteState;
  onClose: () => void;
  title: string;
  successTitle: string;
  successBody: string;
  successAction?: { label: string; href: string };
  errorHint?: string;
  onRetry?: () => void;
}) {
  const titleId = useId();
  const open = state.phase !== "idle";
  const settled = state.phase === "done" || state.phase === "error";
  const current = activeStep(state);
  const currentIndex = current ? ORDER.indexOf(current) : -1;

  if (!open) return null;

  // ── Settled: success ──────────────────────────────────────────────────────
  if (state.phase === "done") {
    return (
      <Modal open onClose={onClose} labelledBy={titleId}>
        <div className="flex items-center gap-3">
          {/* Restrained celebration: the check draws itself once. No confetti —
              this is someone's money, and the tone should be a receipt. */}
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-accent-500/40 bg-accent-500/10">
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 stroke-accent-400"
            >
              <path d="m5 12 4.5 4.5L19 7" />
            </svg>
          </span>
          <h2
            id={titleId}
            className="text-xl font-semibold text-surface-100"
          >
            {successTitle}
          </h2>
        </div>

        <p className="mt-4 leading-relaxed text-surface-300">{successBody}</p>

        <a
          href={explorerUrl("tx", state.hash)}
          target="_blank"
          rel="noreferrer"
          className="value-mono mt-4 inline-block text-xs break-all text-orchid-400 transition-colors hover:text-orchid-300"
        >
          {state.hash}
        </a>

        <div className="mt-7 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="border border-surface-700 px-4 py-2 text-sm text-surface-300 transition-colors hover:border-surface-600 hover:text-surface-100"
          >
            Close
          </button>
          {successAction ? (
            <Link
              href={successAction.href}
              className="bg-orchid-600 px-5 py-2 text-sm text-white transition-colors hover:bg-orchid-500"
            >
              {successAction.label}
            </Link>
          ) : null}
        </div>
      </Modal>
    );
  }

  // ── Settled: failure ──────────────────────────────────────────────────────
  if (state.phase === "error") {
    return (
      <Modal open onClose={onClose} labelledBy={titleId}>
        <h2
          id={titleId}
          className="text-xl font-semibold text-status-rejected"
        >
          Transaction did not go through
        </h2>
        <p role="alert" className="mt-4 leading-relaxed text-surface-300">
          {state.message}
        </p>
        {errorHint ? (
          <p className="mt-3 text-sm leading-relaxed text-surface-500">
            {errorHint}
          </p>
        ) : null}

        {state.hash ? (
          <a
            href={explorerUrl("tx", state.hash)}
            target="_blank"
            rel="noreferrer"
            className="value-mono mt-4 inline-block text-xs break-all text-orchid-400 transition-colors hover:text-orchid-300"
          >
            {state.hash}
          </a>
        ) : null}

        <div className="mt-7 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="border border-surface-700 px-4 py-2 text-sm text-surface-300 transition-colors hover:border-surface-600 hover:text-surface-100"
          >
            Close
          </button>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="bg-orchid-600 px-5 py-2 text-sm text-white transition-colors hover:bg-orchid-500"
            >
              Try again
            </button>
          ) : null}
        </div>
      </Modal>
    );
  }

  // ── In flight ─────────────────────────────────────────────────────────────
  return (
    <Modal open onClose={onClose} labelledBy={titleId} dismissible={false}>
      <h2 id={titleId} className="text-xl font-semibold text-surface-100">
        {title}
      </h2>

      <ol className="mt-7 space-y-4">
        {STEPS.map((step, index) => {
          const done = currentIndex > index;
          const active = currentIndex === index;

          return (
            <li key={step.id} className="flex items-start gap-3">
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                  done
                    ? "border-accent-500/50 bg-accent-500/15 text-accent-400"
                    : active
                      ? "border-orchid-400 text-orchid-400"
                      : "border-surface-700 text-surface-700"
                }`}
              >
                {done ? "✓" : index + 1}
              </span>
              <div className="min-w-0">
                <p
                  className={`text-sm ${
                    active
                      ? "text-surface-100"
                      : done
                        ? "text-surface-400"
                        : "text-surface-600"
                  }`}
                >
                  {step.label}
                  {active ? (
                    <span className="ml-2 text-xs text-orchid-400">
                      in progress
                    </span>
                  ) : null}
                </p>
                {step.estimate && !done ? (
                  <p className="mt-0.5 text-xs text-surface-600">
                    {step.estimate}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {state.phase === "waiting" ? (
        <div className="mt-6 border-t border-surface-800 pt-5">
          <p className="text-xs text-surface-500">
            {state.statusName ?? "submitted"} ·{" "}
            {Math.round(state.elapsedMs / 1000)}s elapsed
          </p>
          {state.nudging ? (
            <p className="mt-2 text-sm leading-relaxed text-status-progress">
              This round stalled, so your wallet is asking you to approve a nudge
              that restarts it. It costs a little gas and is safe to approve.
            </p>
          ) : state.nudges > 0 ? (
            <p className="mt-2 text-sm leading-relaxed text-surface-500">
              Unstuck {state.nudges} {state.nudges === 1 ? "time" : "times"} so
              far. Stalls are normal on this testnet.
            </p>
          ) : null}
        </div>
      ) : null}

      {!settled ? (
        <p className="mt-6 text-xs leading-relaxed text-surface-600">
          Keep this tab open. Closing it will not cancel the transaction, but you
          will stop seeing its progress.
        </p>
      ) : null}
    </Modal>
  );
}
