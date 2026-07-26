import {
  evaluationWeights,
  payoutBand,
  type EvaluationWeights,
  type Milestone,
} from "@/types";

/**
 * Full class strings — Tailwind resolves these statically, so they can't be
 * assembled from fragments at runtime.
 */
const BAR_COLOR = {
  high: "bg-score-high",
  good: "bg-score-good",
  fair: "bg-score-fair",
  fail: "bg-score-fail",
} as const;

const TEXT_COLOR = {
  high: "text-score-high",
  good: "text-score-good",
  fair: "text-score-fair",
  fail: "text-score-fail",
} as const;

export function scoreBand(score: number): keyof typeof BAR_COLOR {
  if (score >= 90) return "high";
  if (score >= 80) return "good";
  if (score >= 70) return "fair";
  return "fail";
}

// Keyed on the weighted criteria, which deliberately excludes `final_weighted`
// — that is the result of these four, not a fifth one.
const CRITERIA: { key: keyof EvaluationWeights; label: string }[] = [
  { key: "code_quality", label: "Code quality" },
  { key: "design_match", label: "Design match" },
  { key: "functionality", label: "Functionality" },
  { key: "completeness", label: "Completeness" },
];

function Criterion({
  label,
  score,
  weight,
}: {
  label: string;
  score: number;
  weight: number;
}) {
  // Weight zero means this criterion was never run — the contract skips the
  // prompt entirely. Showing a red 0/100 bar would libel work that was simply
  // never assessed, so it renders as an explicit absence instead.
  const assessed = weight > 0;

  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-2">
      <span
        className={`text-sm ${assessed ?"text-surface-300":"text-surface-600"}`}
      >
        {label}
      </span>

      {assessed ? (
        // The value stays in ink and the bar beside it carries the colour —
        // colouring both spends the same channel twice.
        <span className="text-sm tabular-nums">
          <span className="text-surface-100">{score}</span>
          <span className="text-surface-600"> ·{weight}%</span>
        </span>
      ) : (
        <span className="text-xs text-surface-600">not assessed</span>
      )}

      <div
        aria-hidden
        className="col-span-2 h-1 overflow-hidden bg-surface-800"
      >
        {assessed ? (
          <div
            className={`h-full ${BAR_COLOR[scoreBand(score)]}`}
            style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The four criteria, the weight each carried, and the weighted result.
 *
 * Weights come from the evidence the freelancer supplied, not from a fixed
 * rubric — see `evaluationWeights`.
 */
export function ScoreDisplay({ milestone }: { milestone: Milestone }) {
  const weights = evaluationWeights(milestone);
  const final = milestone.scores.final_weighted;
  const band = payoutBand(final);

  return (
    <div className="panel p-5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-xs tracking-[0.15em] text-surface-500 uppercase">
          Verdict
        </span>
        <span className="text-xs text-surface-600">score · weight</span>
      </div>

      <div className="mt-5 space-y-5">
        {CRITERIA.map(({ key, label }) => (
          <Criterion
            key={key}
            label={label}
            score={milestone.scores[key]}
            weight={weights[key]}
          />
        ))}
      </div>

      <div className="mt-6 flex items-end justify-between gap-4 border-t border-surface-800 pt-5">
        <div>
          <p className="text-xs tracking-[0.15em] text-surface-600 uppercase">
            Final weighted
          </p>
          {/* Tabular figures, not mono: a score is read at a glance, not
              compared character by character, and the columns still line up
              because Geist's tabular set is fixed-width. */}
          <p
            className={`title-hero mt-1 text-4xl tabular-nums ${TEXT_COLOR[scoreBand(final)]}`}
          >
            {final}
          </p>
        </div>
        <p
          className={`pb-1 text-right text-sm ${
            band.payoutPct === 0 ? "text-status-rejected" : "text-accent-400"
          }`}
        >
          {band.payoutPct === 0
            ? "Below 70 — releases nothing"
            : `Releases ${band.payoutPct}% of this milestone`}
        </p>
      </div>
    </div>
  );
}
