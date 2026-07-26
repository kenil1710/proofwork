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
