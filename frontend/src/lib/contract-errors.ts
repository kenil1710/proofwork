/**
 * What the contract's reverts should say to a person.
 *
 * Kept apart from `lib/contract.ts` on purpose: this file is pure copy plus a
 * matcher, with no SDK imports, so the catalogue can be exercised directly by
 * `test/_frontend-revert-check.mjs` without pulling a browser client into Node.
 *
 * Two networks deliver the same revert in different shapes, and this is the one
 * place that reconciles them:
 *
 *  - Studio hands back `leader_receipt.result.payload`, the UserError string
 *    exactly as the contract raised it — including the class prefix.
 *  - Bradbury leaves the message as bytes inside the debug trace, so the caller
 *    decodes a mostly-binary blob and matches known sentences out of it.
 *
 * Both paths run through `describeContractError`, so a given failure reads the
 * same on either network.
 */

/**
 * The class prefix the contract stamps on verification errors.
 *
 * `[EXPECTED]`, `[EXTERNAL]`, `[TRANSIENT]` and `[LLM_ERROR]` tell *validators*
 * how to compare two failures — whether a disagreement is a real conflict or
 * two nodes hitting the same unreachable host. They are consensus machinery and
 * mean nothing to the person who clicked the button, so they never reach the
 * UI.
 */
const ERROR_CLASS = /^\s*\[(?:EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]\s*/;

/** Drops the consensus class prefix from a raw contract message. */
export function stripErrorClass(message: string): string {
  return message.replace(ERROR_CLASS, "").trim();
}

export interface ContractErrorCopy {
  /**
   * A distinctive ASCII fragment of the contract's message.
   *
   * Fragments, not whole sentences, because most of these interpolate a repo
   * name, a path or an amount. ASCII-only and unbroken by punctuation on
   * purpose: the Bradbury path matches against a latin1 decode of the trace,
   * where the contract's em dashes arrive as non-printable bytes and split the
   * surrounding text.
   */
  match: string;
  /** What the user reads. Never contains the contract's own interpolations. */
  message: string;
}

/**
 * Every `gl.vm.UserError` the contract can raise, in match order.
 *
 * **Order is load-bearing** — the first entry whose `match` appears in the
 * message wins. `"Could not list"` must stay ahead of `"GitHub returned"`,
 * because the listing failure quotes the status code too and would otherwise be
 * reported as a transient blip the user should just retry.
 */
export const CONTRACT_ERRORS: readonly ContractErrorCopy[] = [
  // ── create_job ────────────────────────────────────────────────────────────
  {
    match: "Must deposit GEN for escrow",
    message: "A job needs GEN locked as escrow. Enter an amount above zero.",
  },
  {
    match: "Milestone descriptions and percentages must match",
    message: "Every milestone needs both a description and a percentage.",
  },
  {
    match: "Milestone percentages must sum to 100",
    message: "Milestone percentages must add up to exactly 100.",
  },
  {
    match: "Deadline must be more than zero seconds away",
    message: "The deadline must be at least one day from now.",
  },
  {
    match: "Stake percentage must be between",
    message: "The stake must be between 0% and 50% of the escrow.",
  },
  {
    match: "Cannot read transaction time",
    message:
      "The network could not read the current time. Nothing was changed — try again.",
  },

  // ── accept_job ────────────────────────────────────────────────────────────
  {
    match: "Job is not open",
    message:
      "This job is no longer open. Reload the page to see its current state.",
  },
  {
    match: "Client cannot accept their own job",
    message: "You posted this job, so you cannot accept it yourself.",
  },
  {
    match: "Job already taken",
    message: "Another freelancer accepted this job first.",
  },
  {
    match: "Must stake exactly",
    message:
      "The stake sent did not match what this job requires. Reload the page and accept again.",
  },

  // ── submit_milestone / verify_milestone guards ────────────────────────────
  {
    match: "Job is not in progress",
    message:
      "This job is not in progress. Reload the page to see its current state.",
  },
  {
    match: "Only assigned freelancer can submit",
    message: "Only the freelancer assigned to this job can submit work for it.",
  },
  {
    match: "Milestone not awaiting submission",
    message:
      "This milestone is not awaiting a submission. Reload the page to see its current state.",
  },
  {
    match: "Milestone not submitted for review",
    message:
      "This milestone has nothing to verify. Reload the page to see its current state.",
  },
  {
    match: "Must provide at least a GitHub URL or deployed site URL",
    message:
      "Give at least a repository or a deployed site — validators need something to assess.",
  },

  // ── cancel_job / abandon_job ──────────────────────────────────────────────
  {
    match: "Only client can cancel",
    message: "Only the client who posted this job can cancel it.",
  },
  {
    match: "Can only cancel open jobs",
    message:
      "This job has already been accepted, so it can no longer be cancelled.",
  },
  {
    match: "Only client can abandon",
    message: "Only the client who posted this job can abandon it.",
  },
  {
    match: "Can only abandon a job that is in progress",
    message: "Only a job that is in progress can be abandoned.",
  },
  {
    match: "Every milestone is verified; nothing to abandon",
    message:
      "Every milestone on this job is verified, so there is no escrow left to reclaim.",
  },
  {
    match: "Deadline has not passed yet",
    message: "The deadline has not passed yet, so this job cannot be abandoned.",
  },

  // ── Evidence gathering ────────────────────────────────────────────────────
  // These are the ones worth writing carefully. A freelancer reading them has
  // just had a verification refuse to run, and the difference between "your
  // work scored badly" and "nothing could be read, so nothing was scored" is
  // the difference between rewriting the work and fixing a URL.
  {
    match: "Insufficient evidence from",
    message:
      "Not enough files could be read from the repository, so the milestone was not scored. This is not a judgement on the work — check the repository is public and its files are reachable, then verify again.",
  },
  {
    match: "No source code could be read from",
    message:
      "No source files could be read from the repository, so nothing was scored. Check it is public and that any branch named in the URL exists, then verify again.",
  },
  {
    // Ahead of "GitHub returned": the listing failure quotes a status code too.
    match: "Could not list",
    message:
      "The repository could not be read. Check the URL is right, the repository is public, and any branch named in the URL exists.",
  },
  {
    match: "GitHub's file listing for",
    message:
      "GitHub's reply could not be read. Nothing was changed — verify again.",
  },
  {
    match: "contains no files",
    message:
      "There are no files to review at that URL. Check it points at the code rather than an empty repository or folder.",
  },
  {
    match: "GitHub returned",
    message:
      "GitHub could not be reached, or it rate-limited the request. Nothing was changed — wait a moment and verify again.",
  },
  {
    match: "No evidence could be fetched from the submitted URLs",
    message:
      "None of the submitted URLs could be loaded. Check they are public and reachable, then verify again.",
  },

  // ── The model misbehaving ─────────────────────────────────────────────────
  {
    match: "Could not read a JSON score object from the model's reply",
    message:
      "The AI reviewer returned an unreadable response. Nothing was changed — verify again to retry with a different validator set.",
  },
  {
    match: "Model omitted",
    message:
      "The AI reviewer left out one of the four scores. Nothing was changed — verify again to retry with a different validator set.",
  },
  {
    match: "Non-numeric score for",
    message:
      "The AI reviewer returned a malformed score. Nothing was changed — verify again to retry.",
  },
] as const;

/**
 * The sentence to show for a raw contract message.
 *
 * @param raw - a UserError string, or a latin1 decode of a trace containing one.
 * @returns the user-facing copy, or `null` if nothing in the catalogue matched —
 * the caller then falls back to whatever it can salvage, rather than this file
 * inventing a reassuring sentence for a failure it does not recognise.
 */
export function describeContractError(raw: string): string | null {
  const found = CONTRACT_ERRORS.find((error) => raw.includes(error.match));
  return found ? found.message : null;
}
