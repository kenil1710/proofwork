"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import {
  AbortError,
  describeSubmitError,
  waitForWrite,
  type TransactionHash,
} from "@/lib/contract";

/**
 * Lifecycle of one write, from wallet prompt to state being readable.
 *
 * `settling` is its own phase on purpose: acceptance is not the end. Reads lag
 * accepted writes, so the caller's `onAccepted` re-reads until the change shows
 * up, and the user should see that happening rather than a frozen button.
 */
export type WriteState =
  | { phase: "idle" }
  | { phase: "signing" }
  | {
      phase: "waiting";
      hash: TransactionHash;
      statusName: string | null;
      elapsedMs: number;
      /** True while a stall nudge is awaiting approval in the wallet. */
      nudging: boolean;
      nudges: number;
    }
  | { phase: "settling"; hash: TransactionHash }
  | { phase: "done"; hash: TransactionHash }
  | { phase: "error"; message: string; hash: TransactionHash | null };

export interface RunOptions {
  /** Longer for `verify_milestone`, the slowest call by a wide margin. */
  timeoutMs?: number;
  /**
   * Runs after the write is accepted, before `done`. Use it to poll the view
   * methods until the new state is visible.
   */
  onAccepted?: (hash: TransactionHash) => Promise<void> | void;
}

/**
 * Drives one contract write and reports what it is doing.
 *
 * Every failure mode ends as `{ phase: "error" }` with wording meant for a
 * person — including reverts, which the SDK reports as ordinary success and
 * which `waitForWrite` converts back into a thrown error.
 */
export function useContractWrite() {
  const { account } = useWallet();
  const [state, setState] = useState<WriteState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // A write outlives the component only if we let it; aborting on unmount stops
  // the poll loop and prevents setState on a gone component.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  const run = useCallback(
    async (
      submit: (account: `0x${string}`) => Promise<TransactionHash>,
      { timeoutMs, onAccepted }: RunOptions = {},
    ): Promise<boolean> => {
      if (!account) {
        setState({
          phase: "error",
          message: "Connect your wallet to send this transaction.",
          hash: null,
        });
        return false;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ phase: "signing" });

      let hash: TransactionHash;
      try {
        hash = await submit(account);
      } catch (error) {
        setState({
          phase: "error",
          message: describeSubmitError(error),
          hash: null,
        });
        return false;
      }

      try {
        await waitForWrite(account, hash, {
          timeoutMs,
          signal: controller.signal,
          onProgress: (progress) => {
            setState((current) =>
              progress.kind === "nudging"
                ? {
                    phase: "waiting",
                    hash,
                    statusName:
                      current.phase === "waiting" ? current.statusName : null,
                    elapsedMs:
                      current.phase === "waiting" ? current.elapsedMs : 0,
                    nudging: true,
                    nudges: progress.attempt,
                  }
                : {
                    phase: "waiting",
                    hash,
                    statusName: progress.statusName,
                    elapsedMs: progress.elapsedMs,
                    nudging: false,
                    nudges: current.phase === "waiting" ? current.nudges : 0,
                  },
            );
          },
        });

        if (onAccepted) {
          setState({ phase: "settling", hash });
          await onAccepted(hash);
        }

        setState({ phase: "done", hash });
        return true;
      } catch (error) {
        // An abort is the component going away, not a failure worth showing.
        if (error instanceof AbortError || controller.signal.aborted) {
          return false;
        }
        setState({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "The transaction did not settle.",
          hash,
        });
        return false;
      }
    },
    [account],
  );

  return { state, run, reset, busy: state.phase !== "idle" && state.phase !== "error" && state.phase !== "done" };
}
