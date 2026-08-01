/**
 * Typed reads and writes against the ProofWork contract.
 *
 * Every view method except `get_job_count` returns a JSON *string* that has to
 * be parsed client-side; `get_job_count` returns a bare `u32`. The wrappers
 * below hide that split so callers just get typed values.
 *
 * Three Bradbury behaviours shape the write path, and all three are handled
 * here so no page has to know about them:
 *
 *  1. Rounds stall. Transactions park in COMMITTING with votes committed and
 *     none revealed, and stay there indefinitely — `waitForTransactionReceipt`
 *     only ever *waits*, so it burns its retry budget on a transaction that was
 *     never going to move. `waitForWrite` polls and nudges with
 *     `finalizeIdlenessTxs` instead.
 *  2. A revert does not throw. The transaction is ACCEPTED with
 *     `txExecutionResultName === "FINISHED_WITH_ERROR"`, and the message exists
 *     only as bytes in the debug trace. `waitForWrite` turns that back into a
 *     thrown `ContractWriteError` carrying the user-facing sentence for that
 *     failure — see `lib/contract-errors.ts`.
 *  3. Reads lag accepted writes. The next `readContract` after a write can
 *     still serve pre-write state, so callers follow a write with
 *     `waitForState` rather than reading once.
 */
import {
  ExecutionResult,
  TransactionStatus,
  executionResultNumberToName,
  transactionsStatusNumberToName,
} from "genlayer-js/types";
import type { GenLayerTransaction, TransactionHash } from "genlayer-js/types";
import {
  CONTRACT_ADDRESS,
  IS_GASLESS,
  getReadClient,
  getWalletClient,
} from "./genlayer";
import { describeContractError, stripErrorClass } from "./contract-errors";
import { MAX_STAKE_PCT, SECONDS_PER_DAY, toReviewDepth } from "@/types";
import type { Job, Milestone, Reputation, ReviewDepth } from "@/types";

export type { TransactionHash };

/** A read that failed, with enough context to show the user something useful. */
export class ContractReadError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ContractReadError";
  }
}

async function readRaw(method: string, args: unknown[] = []): Promise<unknown> {
  try {
    return await getReadClient().readContract({
      address: CONTRACT_ADDRESS,
      functionName: method,
      // The SDK's CalldataEncodable union doesn't describe our arg shapes;
      // the contract's own signature is the real check here.
      args: args as never,
    });
  } catch (error) {
    throw new ContractReadError(
      method,
      `Could not reach the contract to read ${method}. Check your connection and that the network is up.`,
      error,
    );
  }
}

/**
 * Reads a view method that returns a JSON string and parses it.
 *
 * Kept separate from `readRaw` because a malformed payload is a different
 * failure from an unreachable node, and the UI should say so.
 */
async function readJson<T>(method: string, args: unknown[] = []): Promise<T> {
  const raw = await readRaw(method, args);

  if (typeof raw !== "string") {
    throw new ContractReadError(
      method,
      `Expected ${method} to return a JSON string, got ${typeof raw}.`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new ContractReadError(
      method,
      `${method} returned a value that isn't valid JSON.`,
      error,
    );
  }
}

/**
 * Total jobs ever created — also the next job's id, since ids start at 0 and
 * increment. Cancelled jobs still count.
 *
 * Returns a plain `u32`, not JSON, so it skips parsing. The SDK may hand back
 * a bigint, so it's normalised here.
 */
export async function getJobCount(): Promise<number> {
  const raw = await readRaw("get_job_count");

  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number") return raw;

  // Some transports stringify integers; accept that rather than fail the page.
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);

  throw new ContractReadError(
    "get_job_count",
    `Expected a number from get_job_count, got ${typeof raw}.`,
  );
}

/**
 * Job by id. Ids are 0-based and dense: valid range is 0 … count-1.
 *
 * `total_amount` gets special handling. The contract emits it as a JSON number
 * in 18-decimal base units, and anything above ~0.009 GEN is past
 * `Number.MAX_SAFE_INTEGER` — so `JSON.parse` would round the low digits away
 * without complaint, and every amount shown and every payout derived from it
 * would be quietly wrong. Quoting the field before parsing keeps it exact.
 */
export async function getJob(jobId: number): Promise<Job> {
  const raw = await readRaw("get_job", [jobId]);

  if (typeof raw !== "string") {
    throw new ContractReadError(
      "get_job",
      `Expected get_job to return a JSON string, got ${typeof raw}.`,
    );
  }

  try {
    // Quote every base-unit field before parsing. They are emitted as JSON
    // numbers and any escrow above ~0.009 GEN exceeds Number.MAX_SAFE_INTEGER,
    // so JSON.parse would silently round off the low digits — and a stake is a
    // fraction of the escrow, so it overflows at the same sizes.
    const quoted = raw.replace(
      /("(?:total_amount|required_stake|freelancer_stake|paid_out)"\s*:\s*)(\d+)/g,
      '$1"$2"',
    );

    type RawJob = Omit<
      Job,
      | "total_amount"
      | "required_stake"
      | "freelancer_stake"
      | "paid_out"
      | "review_depth"
    > & {
      total_amount: string;
      required_stake: string;
      freelancer_stake: string;
      paid_out: string;
      review_depth?: string;
    };
    const parsed = JSON.parse(quoted) as RawJob;

    return {
      ...parsed,
      total_amount: BigInt(parsed.total_amount),
      required_stake: BigInt(parsed.required_stake),
      freelancer_stake: BigInt(parsed.freelancer_stake),
      paid_out: BigInt(parsed.paid_out),
      // Normalised rather than cast: a job created before the field existed
      // omits it, and the UI must not render `undefined` as a review depth.
      review_depth: toReviewDepth(parsed.review_depth),
    };
  } catch (error) {
    throw new ContractReadError(
      "get_job",
      "get_job returned a value that isn't valid JSON.",
      error,
    );
  }
}

/** One milestone of a job. `milestoneId` is 0-based within the job. */
export async function getMilestone(
  jobId: number,
  milestoneId: number,
): Promise<Milestone> {
  return readJson<Milestone>("get_milestone", [jobId, milestoneId]);
}

/** Every milestone of a job, in order. */
export async function getMilestones(
  jobId: number,
  milestoneCount: number,
): Promise<Milestone[]> {
  return Promise.all(
    Array.from({ length: milestoneCount }, (_, index) =>
      getMilestone(jobId, index),
    ),
  );
}

/**
 * Reputation for a freelancer address.
 *
 * The address must be EIP-55 checksummed: `freelancer_scores` is keyed by
 * Python's `str(Address)`, which is the checksummed form, and an unknown key
 * reads as zeroed rather than erroring — so a lowercase address silently
 * reports "no completed jobs". Normalise with `toContractAddress` first.
 *
 * Reputation is only recorded once *every* milestone of a job is verified, so
 * a freelancer mid-job reads as having completed nothing.
 */
export async function getReputation(address: string): Promise<Reputation> {
  return readJson<Reputation>("get_reputation", [address]);
}

// ── Polling ──────────────────────────────────────────────────────────────────

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Thrown when a caller aborts a wait — a cancelled effect, usually. */
export class AbortError extends Error {
  constructor() {
    super("Aborted.");
    this.name = "AbortError";
  }
}

/**
 * Bounds a promise that talks to the network.
 *
 * Anything awaited inside a polling loop needs this: an unbounded await blocks
 * the loop past its own deadline, turning a slow call into a permanent hang.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export interface WaitForStateOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Polls a read until it satisfies `predicate`.
 *
 * This is the answer to read lag: reading once straight after a write shows
 * stale state, because a node can serve pre-write data even though the
 * transaction is ACCEPTED. Reads that throw count as "not ready yet" — querying
 * a job that hasn't landed raises rather than returning empty.
 *
 * @throws on timeout, reporting the last value seen so the failure is legible.
 */
export async function waitForState<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  { timeoutMs = 90_000, intervalMs = 2_500, signal }: WaitForStateOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;

  for (;;) {
    if (signal?.aborted) throw new AbortError();

    try {
      last = await withTimeout(read(), 30_000, label);
      lastError = undefined;
      if (predicate(last)) return last;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      const seen = lastError
        ? `last read failed: ${(lastError as Error)?.message}`
        : `last value: ${JSON.stringify(last)}`;
      throw new Error(`Timed out waiting for ${label} — ${seen}`);
    }
    await sleep(intervalMs, signal);
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Consensus settings per write, per network.
 *
 * Bradbury rounds park in COMMITTING with votes committed but none revealed and
 * stay there — a `create_job` sat unmoved for four minutes with three leader
 * rotations still available. They only advance when someone calls
 * `finalizeIdlenessTxs`, and on this testnet nobody else does. So rather than
 * waiting longer, `waitForWrite` nudges the transaction itself.
 *
 * Studio settles on its own in seconds and has no idle queue to nudge, so the
 * nudge is disabled there. That is not just tidiness: Studionet rate-limits per
 * IP (60 req/min), and a nudge is itself a consensus write. Polling is also
 * tightened to 1s, because a 5s poll makes a 6s chain feel like a 10s one.
 */
const CONSENSUS = IS_GASLESS
  ? ({
      intervalMs: 1_000,
      timeoutMs: 120_000,
      // An LLM round costs real time on any network; only the stalled-round
      // padding comes off.
      verifyTimeoutMs: 600_000,
      nudgeAfterMs: Number.POSITIVE_INFINITY,
      maxNudges: 0,
    } as const)
  : ({
      intervalMs: 5_000,
      /** Budget for accept / submit / cancel / create. */
      timeoutMs: 300_000,
      /**
       * Budget for `verify_milestone`. The leader renders up to four pages and
       * runs one LLM prompt; every validator then re-fetches those pages to check
       * the score was based on them. Measured at 194s for the minimal case, so the
       * budget is generous rather than tight.
       */
      verifyTimeoutMs: 900_000,
      /** How long a transaction may sit undecided before nudging it again. */
      nudgeAfterMs: 60_000,
      maxNudges: 6,
    } as const);

/**
 * States that actually end a transaction's life.
 *
 * Deliberately NOT the SDK's `DECIDED_STATES`, which also lists
 * `LEADER_TIMEOUT` and `VALIDATORS_TIMEOUT`. Those are not terminal on Bradbury:
 * the round rotates to a new leader and the transaction carries on — observed
 * on a `verify_milestone` that reported LEADER_TIMEOUT at 24s, then moved to
 * round 2 with three rotations still in hand. Treating them as decided reports
 * a failure on a transaction that is still running, and abandons it right when
 * it most needs nudging.
 *
 * `verify_milestone` hits this routinely, because rendering pages, screenshotting
 * them and running an LLM prompt can simply outlast a leader's slot.
 */
const TERMINAL_STATES: readonly TransactionStatus[] = [
  TransactionStatus.ACCEPTED,
  TransactionStatus.FINALIZED,
  TransactionStatus.UNDETERMINED,
  TransactionStatus.CANCELED,
];

/** A write that reverted, timed out, or settled as something other than ACCEPTED. */
export class ContractWriteError extends Error {
  constructor(
    message: string,
    readonly hash: TransactionHash,
    readonly statusName: string | null,
  ) {
    super(message);
    this.name = "ContractWriteError";
  }
}

/** What `waitForWrite` reports while it waits, so the UI can narrate honestly. */
export type WriteProgress =
  | { kind: "polling"; statusName: string | null; elapsedMs: number }
  /**
   * A nudge is about to be sent. This costs gas and opens the wallet, so the UI
   * must say so *before* the popup appears rather than letting it surprise the
   * user mid-wait.
   */
  | { kind: "nudging"; attempt: number };

export interface WriteOutcome {
  hash: TransactionHash;
  statusName: string;
  /** How many `finalizeIdlenessTxs` calls it took to settle. */
  nudges: number;
}

export interface WaitForWriteOptions {
  onProgress?: (progress: WriteProgress) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function statusNameOf(tx: GenLayerTransaction | null): TransactionStatus | null {
  if (!tx) return null;
  if (tx.statusName) return tx.statusName;

  const raw = tx.status;
  if (typeof raw === "number") {
    return (
      (transactionsStatusNumberToName as Record<number, TransactionStatus>)[
        raw
      ] ?? null
    );
  }
  return typeof raw === "string" ? raw : null;
}

/**
 * Studio's leader receipt, which the SDK's `GenLayerTransaction` does not type.
 * `result.payload` is the already-decoded UserError string.
 */
type StudioLeaderReceipt = {
  execution_result?: "SUCCESS" | "ERROR";
  result?: { status?: "return" | "rollback"; payload?: unknown };
};

function studioLeaderReceipt(
  tx: GenLayerTransaction | null,
): StudioLeaderReceipt | null {
  const receipt = (tx as { consensus_data?: { leader_receipt?: unknown } } | null)
    ?.consensus_data?.leader_receipt;
  const leader = Array.isArray(receipt) ? receipt[0] : receipt;
  return (leader as StudioLeaderReceipt) ?? null;
}

/**
 * Whether the contract code failed — the two networks report it differently.
 *
 * Bradbury sets `txExecutionResultName`. Studio leaves it **undefined** and puts
 * the outcome in `consensus_data.leader_receipt[0]` instead. Without the Studio
 * branch this returns null there, the `FINISHED_WITH_ERROR` check never fires,
 * and a rejected transaction is reported to the user as a success — the failure
 * mode this function exists to prevent.
 *
 * Studio's top-level `result_name` is deliberately not consulted: it carries the
 * *consensus* outcome ("MAJORITY_AGREE"), and validators agree unanimously about
 * reverts too.
 */
function executionResultOf(
  tx: GenLayerTransaction | null,
): ExecutionResult | null {
  if (!tx) return null;
  if (tx.txExecutionResultName) return tx.txExecutionResultName;

  const raw = tx.txExecutionResult;
  if (typeof raw === "number") {
    return (
      (executionResultNumberToName as Record<number, ExecutionResult>)[raw] ??
      null
    );
  }

  const leader = studioLeaderReceipt(tx);
  if (leader) {
    return leader.execution_result === "ERROR" ||
      leader.result?.status === "rollback"
      ? ExecutionResult.FINISHED_WITH_ERROR
      : ExecutionResult.FINISHED_WITH_RETURN;
  }
  return null;
}

/** Hex → latin1. `Buffer` is Node-only, and this runs in the browser. */
function hexToLatin1(hex: string): string {
  // Cap the work: traces carry memory pages and storage diffs, and the error
  // text sits near the front. Decoding megabytes to find a sentence is waste.
  const bounded = hex.slice(0, 512_000);
  let out = "";
  for (let i = 0; i + 1 < bounded.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(bounded.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Recovers a reverted transaction's message from the debug trace.
 *
 * The trace is a mostly-binary blob with the error text sitting in it as plain
 * bytes, so the catalogue is matched against the whole decode. Only when
 * nothing matches does this fall back to the printable runs — which is ugly,
 * and mangles any sentence containing an em dash (a non-ASCII byte ends the
 * run), but still beats showing nothing.
 */
async function revertMessage(hash: TransactionHash): Promise<string> {
  try {
    const trace = await withTimeout(
      getReadClient().debugTraceTransaction({ hash }),
      30_000,
      "debugTraceTransaction",
    );
    const data = (trace as { return_data?: unknown })?.return_data;
    if (typeof data !== "string" || !data.startsWith("0x")) return "";

    const decoded = hexToLatin1(data.slice(2));
    const known = describeContractError(decoded);
    if (known) return known;

    // Keep only printable runs, with any class prefix dropped — turns an
    // unreadable dump into something a person can at least skim.
    const runs = decoded.match(/[\x20-\x7E]{6,}/g) ?? [];
    return stripErrorClass(runs.join(" | ")).slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Waits for a write to settle, unsticking it when consensus stalls.
 *
 * Deliberately not `waitForTransactionReceipt`: that only waits, and a round
 * parked in COMMITTING never advances on its own here. Calling
 * `finalizeIdlenessTxs` moves it straight to ACCEPTED with every vote revealed.
 *
 * Note ACCEPTED is *not* the same as paid. Transfers to wallets are external
 * messages that apply on FINALIZATION, so a verified milestone or cancelled job
 * reads as settled while the GEN has not moved yet — see `waitForFinalized`.
 *
 * @throws {ContractWriteError} on revert, timeout, or a non-ACCEPTED outcome.
 */
export async function waitForWrite(
  account: `0x${string}`,
  hash: TransactionHash,
  { onProgress, timeoutMs = CONSENSUS.timeoutMs, signal }: WaitForWriteOptions = {},
): Promise<WriteOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastNudgeAt = startedAt;
  let nudges = 0;

  for (;;) {
    if (signal?.aborted) throw new AbortError();

    const tx = await withTimeout(
      getReadClient().getTransaction({ hash }),
      30_000,
      "getTransaction",
    ).catch(() => null);

    const statusName = statusNameOf(tx as GenLayerTransaction | null);
    onProgress?.({
      kind: "polling",
      statusName,
      elapsedMs: Date.now() - startedAt,
    });

    // Not `isDecidedState()` — it is broken in genlayer-js 1.1.8 and returns
    // false for every input, including "ACCEPTED", so the loop never exits.
    // Not `DECIDED_STATES` either — see TERMINAL_STATES above; a leader timeout
    // just rotates, so falling through here keeps polling and nudging.
    if (statusName && TERMINAL_STATES.includes(statusName)) {
      if (
        statusName !== TransactionStatus.ACCEPTED &&
        statusName !== TransactionStatus.FINALIZED
      ) {
        // UNDETERMINED / CANCELED are final, and neither means the call ran.
        throw new ContractWriteError(
          `The network settled this transaction as ${statusName} — validators could not agree on an outcome. Nothing was changed; you can safely try again.`,
          hash,
          statusName,
        );
      }

      if (executionResultOf(tx as GenLayerTransaction | null) ===
        ExecutionResult.FINISHED_WITH_ERROR) {
        // Studio hands back the UserError already decoded, so prefer it and
        // skip the trace fetch and hex scraping that Bradbury still needs.
        //
        // Still routed through the catalogue rather than shown as-is: the raw
        // string carries the `[EXTERNAL]`-style consensus prefix and the
        // contract's own interpolations (repo slugs, base-unit amounts), none
        // of which mean anything to the person who pressed the button.
        const payload = studioLeaderReceipt(tx as GenLayerTransaction | null)
          ?.result?.payload;
        const message =
          typeof payload === "string" && payload
            ? (describeContractError(payload) ?? stripErrorClass(payload))
            : await revertMessage(hash);
        throw new ContractWriteError(
          message || "The contract rejected this transaction.",
          hash,
          statusName,
        );
      }

      return { hash, statusName, nudges };
    }

    if (
      Date.now() - lastNudgeAt >= CONSENSUS.nudgeAfterMs &&
      nudges < CONSENSUS.maxNudges
    ) {
      nudges += 1;
      lastNudgeAt = Date.now();
      onProgress?.({ kind: "nudging", attempt: nudges });

      // Bounded and best-effort: the nudge is itself a consensus call whose own
      // receipt can hang, and an unbounded await would freeze this loop past
      // its deadline. It also reverts harmlessly if the round moved on, and the
      // user may simply decline it — in every case, keep polling.
      await withTimeout(
        getWalletClient(account).finalizeIdlenessTxs({ txIds: [hash] }),
        90_000,
        "finalizeIdlenessTxs",
      ).catch(() => undefined);
    }

    if (Date.now() >= deadline) {
      throw new ContractWriteError(
        `This transaction never settled — it is still ${statusName ?? "unknown"} after ${Math.round(
          timeoutMs / 1000,
        )}s and ${nudges} attempts to unstick it. It may still land; check the explorer before retrying.`,
        hash,
        statusName,
      );
    }
    await sleep(CONSENSUS.intervalMs, signal);
  }
}

/**
 * Waits for a transaction to reach FINALIZED.
 *
 * This is the only point at which GEN has actually moved. Paying a wallet is an
 * external message through the contract's ghost contract, and those apply on
 * finalization rather than acceptance — so a payout or refund is invisible in
 * any balance until this resolves. Bradbury finalizes on its own but slowly:
 * measured at ACCEPTED after 8 minutes and FINALIZED around two hours.
 *
 * There is no way to hurry it. `finalizeTransaction` reverts unless the
 * transaction is already READY_TO_FINALIZE, so this only watches.
 */
export async function waitForFinalized(
  hash: TransactionHash,
  { timeoutMs = 4 * 60 * 60_000, intervalMs = 30_000, signal }: WaitForStateOptions = {},
): Promise<void> {
  await waitForState(
    () => getReadClient().getTransaction({ hash }),
    (tx) => statusNameOf(tx as GenLayerTransaction | null) === TransactionStatus.FINALIZED,
    "the payout to finalize",
    { timeoutMs, intervalMs, signal },
  );
}

/**
 * Turns a submission failure into something worth reading.
 *
 * These are the *outer* call to the consensus contract failing before the
 * Intelligent Contract ever runs — usually because the sender still has an
 * unsettled transaction in its slot. Retrying works, but auto-retrying would
 * reopen the wallet unprompted, so the UI asks instead.
 */
export function describeSubmitError(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return "You rejected the transaction in your wallet.";

  const message = (error as Error)?.message ?? "";
  if (/nonce|already known|replacement|underpriced|was reverted/i.test(message)) {
    return "Your previous transaction is still settling. Wait a few seconds and try again.";
  }
  if (/insufficient funds/i.test(message)) {
    return IS_GASLESS
      ? "Not enough GEN to cover this transaction."
      : "Not enough GEN to cover this transaction. Top up from the testnet faucet.";
  }
  return message || "The transaction could not be submitted.";
}

/** Milestone descriptions are joined with `|`, so they cannot contain one. */
export const MILESTONE_SEPARATOR = "|";

/**
 * What the contract treats as "no evidence supplied".
 *
 * `verify_milestone` tests each URL against both `""` and `"none"`, so either
 * works; sending `"none"` makes the omission explicit on chain.
 */
const NO_URL = "none";

const normaliseUrl = (url: string) => url.trim() || NO_URL;

export interface CreateJobParams {
  account: `0x${string}`;
  title: string;
  requirements: string;
  /** One entry per milestone, in order. */
  milestoneDescriptions: string[];
  /** Whole numbers, same length as descriptions, summing to exactly 100. */
  milestonePercentages: number[];
  /** Escrow to lock, in base units — see `parseGen`. */
  depositBaseUnits: bigint;
  /** Whole days from now until the work must be finished. At least 1. */
  deadlineDays: number;
  /** Share of escrow a freelancer must stake to accept, 0–50. */
  stakePercentage: number;
  /**
   * How thoroughly milestones are verified. Fixed for the job's life, so this
   * is the client's only chance to choose it.
   */
  reviewDepth: ReviewDepth;
}

/**
 * Creates a job and locks the escrow in one payable call.
 *
 * The validation below is not belt-and-braces — a `create_job` that reverts
 * keeps the deposit. There is no job record afterwards, so no `cancel_job` can
 * refund it and the GEN is unrecoverable. Observed on chain, twice. Never let a
 * create reach the network unvalidated.
 *
 * Returns the transaction hash immediately; the job is not queryable until the
 * transaction is accepted, so follow this with `waitForWrite`.
 */
export async function createJob(
  params: CreateJobParams,
): Promise<TransactionHash> {
  const {
    account,
    title,
    requirements,
    milestoneDescriptions,
    milestonePercentages,
    depositBaseUnits,
    deadlineDays,
    stakePercentage,
    reviewDepth,
  } = params;

  if (milestoneDescriptions.length !== milestonePercentages.length) {
    throw new Error("Each milestone needs both a description and a percentage.");
  }
  if (milestoneDescriptions.length === 0) {
    throw new Error("A job needs at least one milestone.");
  }
  if (depositBaseUnits <= 0n) {
    throw new Error("The deposit must be greater than zero.");
  }
  // Both of these are contract-side reverts, and a reverting create keeps the
  // deposit — so they are checked here rather than relying on the chain.
  if (!Number.isInteger(deadlineDays) || deadlineDays < 1) {
    throw new Error("The deadline must be a whole number of days, at least 1.");
  }
  if (
    !Number.isInteger(stakePercentage) ||
    stakePercentage < 0 ||
    stakePercentage > MAX_STAKE_PCT
  ) {
    throw new Error(
      `The stake percentage must be a whole number between 0 and ${MAX_STAKE_PCT}.`,
    );
  }

  // The contract splits on "|", so a description containing one would silently
  // create extra milestones and fail the length check on chain.
  const offending = milestoneDescriptions.find((d) =>
    d.includes(MILESTONE_SEPARATOR),
  );
  if (offending !== undefined) {
    throw new Error(`Milestone descriptions cannot contain "${MILESTONE_SEPARATOR}".`);
  }

  const total = milestonePercentages.reduce((sum, pct) => sum + pct, 0);
  if (total !== 100) {
    throw new Error(`Milestone percentages must total 100 — they total ${total}.`);
  }

  return getWalletClient(account).writeContract({
    address: CONTRACT_ADDRESS,
    functionName: "create_job",
    args: [
      title,
      requirements,
      milestoneDescriptions.join(MILESTONE_SEPARATOR),
      milestonePercentages.join(MILESTONE_SEPARATOR),
      deadlineDays * SECONDS_PER_DAY,
      stakePercentage,
      // Normalised here too. The contract degrades an unrecognised value to
      // "quick" rather than reverting — a reverting create keeps the deposit —
      // so a typo would silently downgrade the job instead of failing loudly.
      toReviewDepth(reviewDepth),
    ] as never,
    value: depositBaseUnits,
  });
}

/**
 * Non-payable write. `value` is required by the SDK's types even here, so every
 * one of these passes `0n` explicitly.
 */
function write(
  account: `0x${string}`,
  functionName: string,
  args: unknown[],
): Promise<TransactionHash> {
  return getWalletClient(account).writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args: args as never,
    value: 0n,
  });
}

/**
 * Freelancer takes an open job, staking the amount the client required.
 *
 * Payable, and the contract demands the value match `required_stake` exactly —
 * not a minimum. Pass the job's own `required_stake` rather than recomputing
 * it from the percentage: the contract truncates when deriving it, so a
 * recomputed figure can be off by base units and revert.
 */
export function acceptJob(
  account: `0x${string}`,
  jobId: number,
  requiredStake: bigint,
): Promise<TransactionHash> {
  if (requiredStake < 0n) {
    throw new Error("The stake cannot be negative.");
  }
  return getWalletClient(account).writeContract({
    address: CONTRACT_ADDRESS,
    functionName: "accept_job",
    args: [jobId] as never,
    value: requiredStake,
  });
}

/**
 * Client reclaims escrow from a freelancer who missed the deadline, and takes
 * their stake as the penalty.
 *
 * Only valid while the job is `in_progress`, past its deadline, with at least
 * one milestone unverified — `canAbandon` in `@/types` mirrors that guard, and
 * the button should be gated on it. Calling outside those conditions reverts
 * and still costs gas.
 */
export function abandonJob(
  account: `0x${string}`,
  jobId: number,
): Promise<TransactionHash> {
  return write(account, "abandon_job", [jobId]);
}

export interface SubmitMilestoneParams {
  account: `0x${string}`;
  jobId: number;
  milestoneId: number;
  /** Blank fields are sent as "none" — the contract's marker for absent. */
  githubUrl: string;
  siteUrl: string;
  mockupUrl: string;
}

/**
 * Freelancer submits evidence for one milestone.
 *
 * At least one of GitHub or site is required: with neither, the milestone
 * records fine but `verify_milestone` reverts, leaving it stuck as submitted.
 * Catching that here saves a wasted transaction.
 */
export function submitMilestone({
  account,
  jobId,
  milestoneId,
  githubUrl,
  siteUrl,
  mockupUrl,
}: SubmitMilestoneParams): Promise<TransactionHash> {
  const github = normaliseUrl(githubUrl);
  const site = normaliseUrl(siteUrl);

  if (github === NO_URL && site === NO_URL) {
    throw new Error(
      "Give at least a repository or a deployed site — validators need something to assess.",
    );
  }

  return write(account, "submit_milestone", [
    jobId,
    milestoneId,
    github,
    site,
    normaliseUrl(mockupUrl),
  ]);
}

/**
 * Runs AI verification on a submitted milestone. Callable by anyone; the caller
 * pays the gas. Scoring 70 or above releases the milestone's share of escrow.
 */
export function verifyMilestone(
  account: `0x${string}`,
  jobId: number,
  milestoneId: number,
): Promise<TransactionHash> {
  return write(account, "verify_milestone", [jobId, milestoneId]);
}

/** Client cancels a job nobody has accepted yet, refunding the escrow. */
export function cancelJob(
  account: `0x${string}`,
  jobId: number,
): Promise<TransactionHash> {
  return write(account, "cancel_job", [jobId]);
}

/** Budget for the verify call, which is far slower than the other writes. */
export const VERIFY_TIMEOUT_MS = CONSENSUS.verifyTimeoutMs;
