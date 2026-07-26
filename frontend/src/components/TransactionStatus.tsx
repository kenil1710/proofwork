"use client";

import type { WriteState } from "@/hooks/useContractWrite";
import { explorerUrl } from "@/lib/genlayer";

/**
 * Consensus status names, in the words of someone watching rather than the
 * words of the protocol. Anything unmapped falls through as-is — a status we
 * didn't anticipate is better shown raw than hidden.
 */
const STATUS_TEXT: Record<string, string> = {
  UNINITIALIZED: "Submitted",
  PENDING: "Queued for validators",
  PROPOSING: "Leader running the call",
  COMMITTING: "Validators committing votes",
  REVEALING: "Validators revealing votes",
  ACCEPTED: "Accepted",
  FINALIZED: "Finalized",
  READY_TO_FINALIZE: "Ready to finalize",
  APPEAL_COMMITTING: "Appeal in progress",
  APPEAL_REVEALING: "Appeal in progress",
};

function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={explorerUrl("tx", hash)}
      target="_blank"
      rel="noreferrer"
      className="value-mono text-xs break-all text-orchid-400 transition-colors hover:text-orchid-300"
    >
      {hash.slice(0, 10)}…{hash.slice(-8)}
    </a>
  );
}

/**
 * Narrates one write in flight.
 *
 * The stall case earns its prominence: when a round parks in COMMITTING the app
 * sends a `finalizeIdlenessTxs` transaction to unstick it, which costs gas and
 * opens the wallet. A second unexplained MetaMask popup reads as either a bug
 * or an attack, so it gets announced before it happens.
 */
export function TransactionStatus({ state }: { state: WriteState }) {
  if (state.phase === "idle") return null;

  if (state.phase === "error") {
    return (
      <div
        role="alert"
        className="mt-4 border border-status-rejected/30 bg-status-rejected/5 p-4"
      >
        <p className="text-sm text-status-rejected">{state.message}</p>
        {state.hash ? (
          <p className="mt-2">
            <TxLink hash={state.hash} />
          </p>
        ) : null}
      </div>
    );
  }

  if (state.phase === "done") {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-accent-400">Accepted</span>
        <TxLink hash={state.hash} />
      </div>
    );
  }

  if (state.phase === "signing") {
    return (
      <p className="mt-4 text-xs text-surface-400">
        Confirm in your wallet…
      </p>
    );
  }

  if (state.phase === "settling") {
    return (
      <div className="mt-4">
        <p className="text-xs text-surface-400">
          Accepted — reading the updated state back…
        </p>
        <p className="mt-1.5 text-xs text-surface-600">
          Nodes can still serve the previous state for a few seconds after a
          write lands.
        </p>
      </div>
    );
  }

  const { statusName, elapsedMs, nudging, nudges } = state;
  const seconds = Math.round(elapsedMs / 1000);

  return (
    <div className="mt-4">
      {nudging ? (
        <div className="border border-status-progress/30 bg-status-progress/5 p-4">
          <p className="text-xs tracking-[0.15em] text-status-progress uppercase">
            Consensus stalled
          </p>
          <p className="mt-2 text-sm text-surface-300">
            The validator round stopped advancing on its own. Approve the
            transaction in your wallet to restart it — this is a network nudge,
            not a second attempt at your action.
          </p>
          <p className="mt-2 text-xs text-surface-500">
            Attempt {nudges}. Declining is safe; the app will offer again.
          </p>
        </div>
      ) : (
        <p className="text-xs text-surface-400">
          {statusName
            ? (STATUS_TEXT[statusName] ?? statusName)
            : "Waiting for the network"}
          <span className="text-surface-600"> · {seconds}s</span>
          {nudges > 0 ? (
            <span className="text-surface-600"> · nudged {nudges}×</span>
          ) : null}
        </p>
      )}
      <p className="mt-2">
        <TxLink hash={state.hash} />
      </p>
    </div>
  );
}
