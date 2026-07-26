"use client";

import { useEffect, useState } from "react";
import { waitForFinalized, type TransactionHash } from "@/lib/contract";
import { explorerUrl } from "@/lib/genlayer";
import { formatGen } from "@/lib/units";

/**
 * Says where the money actually is.
 *
 * Acceptance and payment are different events here. Paying a wallet is an
 * external message through the contract's ghost contract, and those apply on
 * FINALIZATION — so the instant a verification is accepted, the milestone reads
 * `verified` and the job's escrow has not moved. Bradbury finalizes on its own
 * but slowly: measured at ACCEPTED after eight minutes, FINALIZED around two
 * hours. Nothing can hurry it; `finalizeTransaction` reverts until the round is
 * already READY_TO_FINALIZE.
 *
 * So the UI states the pending step plainly rather than showing a green tick
 * over a balance that has not changed.
 */
export function PayoutNotice({
  amountBaseUnits,
  recipient,
  hash,
}: {
  amountBaseUnits: bigint;
  /** Who is owed — "the freelancer", "you", etc. */
  recipient: string;
  /**
   * The verifying or cancelling transaction, when this session sent it. With a
   * hash the notice tracks finalization live and can honestly say the money has
   * not moved. Without one — after a reload — it cannot know either way, so it
   * describes the mechanism instead of asserting a state.
   */
  hash?: TransactionHash;
}) {
  const [finalized, setFinalized] = useState(false);
  const [tracking, setTracking] = useState(Boolean(hash));

  useEffect(() => {
    if (!hash) return;
    const controller = new AbortController();

    // Both setState calls sit behind an await, which is what React 19's
    // set-state-in-effect rule requires.
    void (async () => {
      try {
        await waitForFinalized(hash, { signal: controller.signal });
        if (!controller.signal.aborted) setFinalized(true);
      } catch {
        // Gave up watching — finalization still happens, we just stop saying so.
        if (!controller.signal.aborted) setTracking(false);
      }
    })();

    return () => controller.abort();
  }, [hash]);

  const amount = formatGen(amountBaseUnits);

  if (finalized) {
    return (
      <div className="mt-4 border border-accent-500/30 bg-accent-500/5 p-4">
        <p className="text-xs tracking-[0.15em] text-accent-400 uppercase">
          Payout settled
        </p>
        <p className="mt-2 text-sm text-surface-300">
          {amount} GEN has left escrow and reached {recipient}.
        </p>
        {hash ? (
          <a
            href={explorerUrl("tx", hash)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs text-orchid-400 hover:text-orchid-300"
          >
            View transaction
          </a>
        ) : null}
      </div>
    );
  }

  // Without a hash this component cannot tell whether the transfer already
  // landed, and it must not guess. Asserting "it has not moved yet" on every
  // page load was wrong the moment finalization happened — job 0's escrow had
  // already drained while the page still called the payout pending.
  if (!hash) {
    return (
      <div className="mt-4 border border-surface-700 bg-surface-800/40 p-4">
        <p className="text-xs tracking-[0.15em] text-surface-400 uppercase">
          Payout settles on finalization
        </p>
        <p className="mt-2 text-sm text-surface-300">
          {amount} GEN of escrow is assigned to {recipient}. Transfers out of
          escrow apply when the verifying transaction <em>finalizes</em>, which
          is a later step than acceptance and can take hours on this testnet.
        </p>
        <p className="mt-2 text-xs text-surface-500">
          This page cannot tell from the contract alone whether that has happened
          yet — check {recipient === "you" ? "your" : "the"} balance or the
          explorer to confirm.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border border-status-progress/30 bg-status-progress/5 p-4">
      <p className="text-xs tracking-[0.15em] text-status-progress uppercase">
        Payout pending finalization
      </p>
      <p className="mt-2 text-sm text-surface-300">
        {amount} GEN is owed to {recipient}, but it has not moved yet. Transfers
        out of escrow apply when the transaction <em>finalizes</em>, which is a
        later step than the acceptance you just saw — on this testnet it can take
        hours. Balances will not change until then.
      </p>
      <p className="mt-2 text-xs text-surface-500">
        {tracking
          ? "Watching for finalization; this page will update if it lands while you are here."
          : "Finalization happens on its own — reload later to check."}
      </p>
      <a
        href={explorerUrl("tx", hash)}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-xs text-orchid-400 hover:text-orchid-300"
      >
        Track on the explorer
      </a>
    </div>
  );
}
