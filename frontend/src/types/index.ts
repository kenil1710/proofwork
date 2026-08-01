/**
 * Shapes returned by the ProofWork contract's view methods.
 *
 * Field names are snake_case on purpose — they mirror the JSON the contract
 * emits, so parsed payloads pass through untransformed. Renaming to camelCase
 * would mean a mapping layer on every read, and a silent `undefined` wherever
 * one was forgotten.
 */

/** Value of `Job.freelancer` before anyone accepts the job. */
export const UNASSIGNED_ADDRESS = `0x${"0".repeat(40)}` as const;

export type JobStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "cancelled"
  /** Client reclaimed escrow after the freelancer blew the deadline. */
  | "abandoned";

export type MilestoneStatus = "pending" | "submitted" | "verified" | "rejected";

/**
 * How much of the repository verification reads, chosen by the client when the
 * job is created and fixed for its life.
 *
 * A property of the job rather than of the verify call because every validator
 * has to derive the same reading plan from state alone — see `review_depth` on
 * the contract's `Job`.
 */
export type ReviewDepth = "quick" | "deep";

export interface ReviewDepthInfo {
  value: ReviewDepth;
  label: string;
  /** One line for a badge or a radio label. */
  summary: string;
  /** The fuller explanation, for the form and the docs. */
  detail: string;
  /**
   * How long verification takes, measured on Studionet against
   * vercel/commerce — two runs per depth. Not a guess: the first version of
   * this field claimed deep took "two to three times" as long, and the
   * measurement said otherwise.
   */
  estimate: string;
  /** What the reviewer is actually handed, in round numbers. */
  reads: string;
}

/**
 * The two depths, described once.
 *
 * Shared by the create form, the job header, the milestone card and the docs so
 * the numbers cannot drift between the place a client chooses a depth and the
 * place they see what it bought.
 */
export const REVIEW_DEPTHS: Record<ReviewDepth, ReviewDepthInfo> = {
  quick: {
    value: "quick",
    label: "Quick review",
    summary: "Fast verification for typical projects.",
    detail:
      "Reads around 15 files, each in an excerpt. Good for small and medium work where the milestone turns on a handful of files.",
    estimate: "about 30-60 seconds (measured 27s and 55s)",
    reads: "~15 files, up to 36k characters",
  },
  deep: {
    value: "deep",
    label: "Deep review",
    summary: "Thorough analysis for complex projects.",
    detail:
      "Reads up to 40 files, most of them whole, and asks the reviewer to account for each one and for how they fit together. Better for high-value work — DeFi protocols, large dApps — where the milestone turns on cross-file behaviour.",
    estimate: "no slower here in testing (25s and 26s)",
    reads: "up to 40 files, up to 200k characters",
  },
};

/** Anything unrecognised is quick, exactly as the contract normalises it. */
export function toReviewDepth(value: string | undefined): ReviewDepth {
  return String(value ?? "").trim().toLowerCase() === "deep" ? "deep" : "quick";
}

/** Returned by `get_job(job_id)`. */
export interface Job {
  client: string;
  /** `UNASSIGNED_ADDRESS` until a freelancer accepts. */
  freelancer: string;
  title: string;
  /** Free text the AI validators score the deliverable against. */
  requirements: string;
  /**
   * Total escrowed amount in base units.
   *
   * `bigint`, not `number`: the contract emits this as a JSON number, and any
   * escrow above ~0.009 GEN exceeds `Number.MAX_SAFE_INTEGER`, so `JSON.parse`
   * silently rounds off the low digits. `getJob` quotes the field before
   * parsing to keep it exact.
   */
  total_amount: bigint;
  status: JobStatus;
  milestone_count: number;
  completed_milestones: number;

  // ── Anti-scam fields ────────────────────────────────────────────────────
  /** Epoch seconds by which every milestone must be verified. */
  deadline: number;
  /**
   * What a freelancer must deposit to accept, in base units. May be 0.
   *
   * `bigint` for the same reason as `total_amount` — it is a fraction of it,
   * so it clears `Number.MAX_SAFE_INTEGER` at the same escrow sizes.
   */
  required_stake: bigint;
  /** What is currently held. 0 before accepting, and 0 again once returned. */
  freelancer_stake: bigint;
  /** Epoch seconds when accepted; 0 while open. */
  accepted_at: number;
  /** Milestone payments already released, in base units. */
  paid_out: bigint;
  /**
   * How thoroughly each milestone of this job is verified.
   *
   * Set once at creation. Jobs created before this field existed read as
   * `"quick"` — `getJob` normalises, as the contract does.
   */
  review_depth: ReviewDepth;
  /**
   * The chain's own clock at read time, epoch seconds.
   *
   * Countdowns are computed against this rather than `Date.now()`: a viewer
   * with a skewed system clock would otherwise be told a deadline had passed
   * when the contract disagrees, and offered an "Abandon job" button that can
   * only revert.
   */
  now: number;
}

/**
 * The four criteria plus the weighted result. Every value is 0-100.
 *
 * Criteria that don't apply score 0 and carry 0 weight — a submission with no
 * mockup, for instance, has `design_match: 0` because it was never assessed,
 * not because the design failed. Read scores alongside the evidence URLs.
 */
export interface MilestoneScores {
  code_quality: number;
  design_match: number;
  functionality: number;
  completeness: number;
  final_weighted: number;
}

/** Returned by `get_milestone(job_id, milestone_id)`. */
export interface Milestone {
  description: string;
  /** Share of the job's escrow this milestone releases, 0-100. */
  percentage: number;
  status: MilestoneStatus;
  /** Empty string or "none" when not supplied. */
  github_url: string;
  site_url: string;
  mockup_url: string;
  scores: MilestoneScores;
  /**
   * The reviewer's own account of what it read, with `file.ext:LINE` citations
   * into the evidence it was shown.
   *
   * This is the leader validator's CLAIM, not a verified fact. Validators
   * confirm the leader scored evidence they can themselves fetch; they do not
   * re-derive this prose, and nothing about it gates a payout. Its value is
   * that it is falsifiable — the cited lines can be opened and checked.
   *
   * Empty on milestones verified before the contract began recording it, and
   * on any reply where the model omitted it.
   */
  reasoning?: string;
}

/** The contract treats both "" and "none" as "no evidence supplied". */
export function hasEvidence(url: string | undefined): boolean {
  return Boolean(url) && url !== "none";
}

/** Ceiling the contract enforces on `stake_percentage`. */
export const MAX_STAKE_PCT = 50;

/** Seconds in a day — deadlines are entered in days and stored in seconds. */
export const SECONDS_PER_DAY = 86_400;

/**
 * How long is left, in seconds, measured against the CHAIN's clock.
 *
 * `job.now` is the contract's own time at read, plus however long the page has
 * been open since. Deliberately not `Date.now()/1000 - deadline`: a viewer
 * whose system clock is wrong would be shown an expired deadline the contract
 * does not agree has expired, and offered an abandon button that can only
 * revert.
 */
export function secondsLeft(job: Job, elapsedSinceRead = 0): number {
  return job.deadline - (job.now + elapsedSinceRead);
}

/**
 * "3d 4h left", "2h 11m left", "overdue by 5h".
 *
 * Two units, never more: "3d 4h" is read at a glance and "3d 4h 12m 6s" is
 * not, and the extra precision is noise on a deadline measured in days.
 */
export function formatCountdown(totalSeconds: number): string {
  const overdue = totalSeconds < 0;
  let s = Math.abs(Math.trunc(totalSeconds));

  const days = Math.floor(s / 86_400);
  s -= days * 86_400;
  const hours = Math.floor(s / 3_600);
  s -= hours * 3_600;
  const minutes = Math.floor(s / 60);
  const seconds = s - minutes * 60;

  let text: string;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${minutes}m`;
  else if (minutes > 0) text = `${minutes}m ${seconds}s`;
  else text = `${seconds}s`;

  return overdue ? `overdue by ${text}` : `${text} left`;
}

export type DeadlineTone = "expired" | "urgent" | "soon" | "ok";

/** Under a day is urgent, under three days is worth noticing. */
export function deadlineTone(secondsRemaining: number): DeadlineTone {
  if (secondsRemaining < 0) return "expired";
  if (secondsRemaining < SECONDS_PER_DAY) return "urgent";
  if (secondsRemaining < 3 * SECONDS_PER_DAY) return "soon";
  return "ok";
}

/**
 * Whether the client may call `abandon_job` right now.
 *
 * Mirrors the contract's guard exactly. Showing the button under any looser
 * condition produces a transaction that reverts and still costs gas.
 */
export function canAbandon(job: Job, account: string | null, elapsed = 0): boolean {
  return (
    Boolean(account) &&
    account?.toLowerCase() === job.client.toLowerCase() &&
    job.status === "in_progress" &&
    job.completed_milestones < job.milestone_count &&
    secondsLeft(job, elapsed) < 0
  );
}

export interface EvaluationWeights {
  code_quality: number;
  design_match: number;
  functionality: number;
  completeness: number;
}

/**
 * The weights `verify_milestone` applies, derived from which evidence exists.
 *
 * Reproduced here so the UI can say *why* a criterion scored zero. A milestone
 * submitted without a mockup has `design_match: 0` because design was never
 * assessed, which is a completely different fact from design being judged bad —
 * and the raw scores alone cannot tell those apart.
 */
export function evaluationWeights(milestone: {
  github_url: string;
  site_url: string;
  mockup_url: string;
}): EvaluationWeights {
  const code = hasEvidence(milestone.github_url);
  const site = hasEvidence(milestone.site_url);
  const mockup = hasEvidence(milestone.mockup_url);

  if (code && site && mockup) {
    return { code_quality: 25, design_match: 25, functionality: 25, completeness: 25 };
  }
  if (code && site) {
    return { code_quality: 35, design_match: 0, functionality: 35, completeness: 30 };
  }
  if (code) {
    return { code_quality: 50, design_match: 0, functionality: 0, completeness: 50 };
  }
  if (site) {
    return mockup
      ? { code_quality: 0, design_match: 30, functionality: 40, completeness: 30 }
      : { code_quality: 0, design_match: 0, functionality: 50, completeness: 50 };
  }
  // No evidence at all — `verify_milestone` refuses to run on this.
  return { code_quality: 0, design_match: 0, functionality: 0, completeness: 0 };
}

/** Returned by `get_reputation(address)`. Zeroed for unknown addresses. */
export interface Reputation {
  address: string;
  jobs_completed: number;
  avg_score: number;
  /** Final weighted score of each completed job, oldest first. */
  scores: number[];
}

/** What a final score pays out, matching `verify_milestone`. */
export const PAYOUT_BANDS = [
  { min: 90, payoutPct: 100, label: "Full payout" },
  { min: 80, payoutPct: 80, label: "Partial payout" },
  { min: 70, payoutPct: 70, label: "Reduced payout" },
  { min: 0, payoutPct: 0, label: "Rejected" },
] as const;

/** Band a final score falls into. Scores below 70 release nothing. */
export function payoutBand(score: number) {
  return PAYOUT_BANDS.find((band) => score >= band.min) ?? PAYOUT_BANDS[3];
}

/**
 * What a milestone releases, mirroring `verify_milestone` exactly.
 *
 * The contract divides before multiplying at each step — a multiply-first form
 * overflows u64 once the operand passes u64_max/100 — so this does the same,
 * truncation included. Doing it the "obvious" way here would report a payout a
 * few base units off what actually lands.
 */
export function milestonePayout(
  totalAmount: bigint,
  percentage: number,
  finalScore: number,
): bigint {
  if (finalScore < 70) return 0n;

  const milestoneAmount = (totalAmount / 100n) * BigInt(percentage);
  if (finalScore >= 90) return milestoneAmount;
  if (finalScore >= 80) return (milestoneAmount / 100n) * 80n;
  return (milestoneAmount / 100n) * 70n;
}

/** A milestone's full share of escrow, before the score discount. */
export function milestoneShare(
  totalAmount: bigint,
  percentage: number,
): bigint {
  return (totalAmount / 100n) * BigInt(percentage);
}

/** A job the contract has finished with: it holds no escrow for it any more. */
export function isSettled(status: JobStatus): boolean {
  return (
    status === "completed" || status === "cancelled" || status === "abandoned"
  );
}

/**
 * What the contract still holds for this job, in base units.
 *
 * Deliberately not plain `total_amount - paid_out`. The two settled paths
 * account for themselves differently: `abandon_job` raises `paid_out` to the
 * full escrow before refunding, while `cancel_job` refunds everything and never
 * touches `paid_out` at all — so subtraction alone reports a cancelled job as
 * still holding its whole deposit. What is true of all three settled states is
 * that the contract holds nothing, so that is what is checked first.
 */
export function escrowRemaining(job: Job): bigint {
  if (isSettled(job.status)) return 0n;
  const remaining = job.total_amount - job.paid_out;
  return remaining > 0n ? remaining : 0n;
}

/** Where a settled job's escrow actually went. All figures in base units. */
export interface Settlement {
  /** Milestone payouts, at the rate each score band released. */
  toFreelancer: bigint;
  /**
   * Escrow the freelancer never earned, back to the client: the 10-30% the
   * score bands withheld on a completed job, or everything unearned plus the
   * forfeited stake on an abandoned one.
   */
  toClient: bigint;
  /** The freelancer's own stake coming back, which only completion returns. */
  stakeToFreelancer: bigint;
}

/**
 * Reconstructs a settled job's disbursement from its milestones.
 *
 * It cannot be read off the job alone: both settled paths overwrite `paid_out`
 * with the full escrow on the way out, which is exactly what makes it useless
 * afterwards for saying who got what. Summing the milestone payouts recovers
 * the split, using the same truncating arithmetic the contract used.
 */
export function settlement(job: Job, milestones: Milestone[]): Settlement {
  const toFreelancer = milestones.reduce(
    (sum, milestone) =>
      sum +
      milestonePayout(
        job.total_amount,
        milestone.percentage,
        milestone.scores.final_weighted,
      ),
    0n,
  );

  const unearned = job.total_amount - toFreelancer;
  const forfeitedStake =
    job.status === "abandoned" ? job.required_stake : 0n;

  return {
    toFreelancer,
    toClient: (unearned > 0n ? unearned : 0n) + forfeitedStake,
    stakeToFreelancer:
      job.status === "completed" ? job.required_stake : 0n,
  };
}
