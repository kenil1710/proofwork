"use client";

import { useCallback, useEffect, useState } from "react";
import { getJobCount } from "@/lib/contract";
import { CONTRACT_ADDRESS, chain, explorerUrl } from "@/lib/genlayer";

type State =
  | { phase: "loading" }
  | { phase: "ready"; count: number }
  | { phase: "error"; message: string };

/**
 * Live job count, read straight from the contract.
 *
 * Fetched in the browser rather than on the server so a slow or unreachable RPC
 * degrades to a retry prompt instead of failing the whole page render.
 */
export function NetworkReadout() {
  const [state, setState] = useState<State>({ phase: "loading" });
  // Bumped by the retry button to re-run the effect below.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // The state updates sit behind an await, so the effect body itself never
    // sets state synchronously.
    void (async () => {
      try {
        const count = await getJobCount();
        if (!cancelled) setState({ phase: "ready", count });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not read the contract.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // An event handler, so updating state here is fine.
  const retry = useCallback(() => {
    setState({ phase: "loading" });
    setReloadToken((token) => token + 1);
  }, []);

  return (
    <section
      aria-labelledby="network-heading"
      className="panel-live p-8"
    >
      <h2
        id="network-heading"
        className="flex items-center gap-2 text-xs tracking-[0.2em] text-surface-400 uppercase"
      >
        {state.phase === "ready" ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-orchid-400 animate-pulse-dot"
          />
        ) : null}
        On chain now
      </h2>

      <div className="mt-6 min-h-24">
        {state.phase === "loading" ? (
          <p className="text-sm text-surface-400">Reading contract…</p>
        ) : null}

        {state.phase === "error" ? (
          <div>
            <p role="alert" className="text-sm text-status-rejected">
              {state.message}
            </p>
            <button
              type="button"
              onClick={retry}
              className="btn btn-ghost btn-sm mt-3"
            >
              Try again
            </button>
          </div>
        ) : null}

        {state.phase === "ready" ? (
          <div className="flex items-baseline gap-4">
            <span className="title-hero text-6xl tabular-nums text-orchid-400">
              {state.count}
            </span>
            <span className="text-surface-400">
              {state.count === 0
                ? "No jobs posted yet — the first one is yours."
                : state.count === 1
                  ? "job posted to the escrow"
                  : "jobs posted to the escrow"}
            </span>
          </div>
        ) : null}
      </div>

      <dl className="mt-8 grid gap-3 border-t border-surface-800 pt-6 text-xs sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="tracking-[0.15em] text-surface-600 uppercase">Network</dt>
          <dd className="value-mono text-surface-300">
            {chain.name} · {chain.id}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="tracking-[0.15em] text-surface-600 uppercase">Contract</dt>
          <dd>
            <a
              href={explorerUrl("address", CONTRACT_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className="value-mono break-all text-orchid-400 transition-colors hover:text-orchid-300"
            >
              {CONTRACT_ADDRESS}
            </a>
          </dd>
        </div>
      </dl>
    </section>
  );
}
