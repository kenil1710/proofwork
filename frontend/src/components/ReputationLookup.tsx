"use client";

import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyState, MARK_NO_RECORD } from "@/components/EmptyState";
import { ReputationSkeleton } from "@/components/Skeleton";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { scoreBand } from "@/components/ScoreDisplay";
import { InvalidAddressError, toContractAddress } from "@/lib/address";
import { getReputation } from "@/lib/contract";
import { explorerUrl } from "@/lib/genlayer";
import type { Reputation } from "@/types";

const BAR_COLOR = {
  high: "bg-score-high",
  good: "bg-score-good",
  fair: "bg-score-fair",
  fail: "bg-score-fail",
} as const;

const BAND_LABEL = {
  high: "full payout",
  good: "paid 80%",
  fair: "paid 70%",
  fail: "rejected",
} as const;

type State =
  | { phase: "empty" }
  | { phase: "loading" }
  | { phase: "ready"; reputation: Reputation }
  | { phase: "error"; message: string };

/** A headline number. Two of these beat any chart for a single value. */
function StatTile({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string | number;
  suffix?: string;
}) {
  return (
    <div className="panel p-6">
      <p className="text-xs tracking-[0.15em] text-surface-600 uppercase">
        {label}
      </p>
      <p className="title-hero mt-2 text-4xl tabular-nums text-orchid-400">
        {value}
        {suffix ? (
          <span className="ml-1 text-base text-surface-500">
            {suffix}
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * Score history.
 *
 * One entry per completed job, oldest first. With a single entry this is a stat
 * line rather than a chart — a one-bar bar chart is just a number wearing a
 * costume. Each bar is direct-labelled with its score and payout band, so the
 * colour is never the only thing carrying the meaning.
 */
function ScoreHistory({ scores }: { scores: number[] }) {
  if (scores.length === 0) return null;

  if (scores.length === 1) {
    const band = scoreBand(scores[0]);
    return (
      <p className="text-sm text-surface-300">
        <span className="text-2xl tabular-nums">{scores[0]}</span>
        <span className="text-surface-500"> — {BAND_LABEL[band]}</span>
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {scores.map((score, index) => {
        const band = scoreBand(score);
        return (
          <li
            key={index}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4"
          >
            <span className="text-xs text-surface-600 tabular-nums">
              #{index + 1}
            </span>
            <div
              aria-hidden
              className="h-1.5 overflow-hidden bg-surface-800"
            >
              <div
                className={`h-full ${BAR_COLOR[band]}`}
                style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
              />
            </div>
            <span className="text-sm tabular-nums text-surface-100">
              {score}
              <span className="ml-2 text-xs text-surface-600">
                {BAND_LABEL[band]}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ReputationLookup() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { account } = useWallet();

  // The URL is the source of truth, so a reputation page can be linked to —
  // the job page points at freelancers this way.
  const queried = searchParams.get("address") ?? "";
  const [input, setInput] = useState(queried);
  const [state, setState] = useState<State>({ phase: "empty" });

  useEffect(() => {
    if (!queried) return;
    let cancelled = false;

    void (async () => {
      let normalised: string;
      try {
        // Must be checksummed: `freelancer_scores` is keyed by Python's
        // `str(Address)`, and a lowercase key reads as "no completed jobs"
        // instead of erroring — a silently wrong answer.
        normalised = toContractAddress(queried);
      } catch (error) {
        if (!cancelled) {
          setState({
            phase: "error",
            message:
              error instanceof InvalidAddressError
                ? error.message
                : "That is not a valid address.",
          });
        }
        return;
      }

      try {
        const reputation = await getReputation(normalised);
        if (!cancelled) setState({ phase: "ready", reputation });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not read reputation.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queried]);

  function search(value: string) {
    const trimmed = value.trim();
    setState({ phase: "loading" });
    router.replace(trimmed ? `/reputation?address=${trimmed}` : "/reputation");
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
      <Breadcrumbs
        trail={[{ label: "ProofWork", href: "/" }, { label: "Reputation" }]}
      />
      <p className="eyebrow text-orchid-400">
        Reputation
      </p>
      <h1 className="title-display mt-3 text-surface-100">
        Every score a freelancer has earned.
      </h1>
      <p className="mt-4 leading-relaxed text-surface-400">
        Reputation here is not a rating anyone typed in. Each entry is a score
        validators produced from the evidence, recorded on chain when a job
        finished.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          search(input);
        }}
        className="mt-10 flex flex-col gap-3 sm:flex-row"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="0x…"
          aria-label="Freelancer address"
          className="input input-mono w-full"
        />
        <button
          type="submit"
          className="btn btn-primary shrink-0"
        >
          Look up
        </button>
      </form>

      {account && !queried ? (
        <button
          type="button"
          onClick={() => {
            setInput(account);
            search(account);
          }}
          className="mt-3 text-xs text-orchid-400 transition-colors hover:text-orchid-300"
        >
          Use my connected wallet
        </button>
      ) : null}

      {state.phase === "loading" ? <ReputationSkeleton /> : null}

      {state.phase === "error" ? (
        <p role="alert" className="mt-10 text-sm text-status-rejected">
          {state.message}
        </p>
      ) : null}

      {state.phase === "ready" ? (
        <section className="mt-10">
          <a
            href={explorerUrl("address", state.reputation.address)}
            target="_blank"
            rel="noreferrer"
            className="value-mono text-sm break-all text-orchid-400 transition-colors hover:text-orchid-300"
          >
            {state.reputation.address}
          </a>

          {state.reputation.jobs_completed === 0 ? (
            <div className="mt-6 panel p-6">
              <p className="text-surface-300">
                No completed jobs recorded for this address.
              </p>
              <p className="mt-2 text-sm text-surface-500">
                A job only counts once <em>every</em> one of its milestones has
                been verified, so a freelancer part-way through their first job
                still reads as zero here.
              </p>
            </div>
          ) : (
            <>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <StatTile
                  label="Jobs completed"
                  value={state.reputation.jobs_completed}
                />
                <StatTile
                  label="Average score"
                  value={state.reputation.avg_score}
                  suffix="/ 100"
                />
              </div>

              <div className="mt-8 panel p-6">
                <h2 className="text-xs tracking-[0.15em] text-surface-400 uppercase">
                  Score history
                  <span className="ml-2 text-surface-600 normal-case">
                    oldest first
                  </span>
                </h2>
                <div className="mt-5">
                  <ScoreHistory scores={state.reputation.scores} />
                </div>
                <p className="mt-6 border-t border-surface-800 pt-4 text-sm text-surface-500">
                  One entry per completed job — specifically the score of the
                  milestone that finished it, which is what the contract records.
                  Scores on earlier milestones of the same job are on the job&rsquo;s
                  own page.
                </p>
              </div>
            </>
          )}
        </section>
      ) : null}

      {state.phase === "empty" ? (
        <div className="mt-10">
          <EmptyState
            mark={MARK_NO_RECORD}
            title="Look up a freelancer"
            body="Paste any wallet address to see the scores validators gave their completed work. No account needed — every record here is public."
          />
        </div>
      ) : null}
    </main>
  );
}
