/**
 * Shared plumbing for the ProofWork integration suite.
 *
 * Two Bradbury behaviours shape everything in here:
 *
 *  1. Reads lag accepted writes. A transaction can reach ACCEPTED and the very
 *     next `readContract` still returns the previous state. This is network
 *     infrastructure, not the contract — so every state assertion goes through
 *     `waitForState`, which polls the view method until the expected value
 *     shows up rather than reading once and trusting it.
 *
 *  2. A `gl.vm.UserError` does not throw client-side — the transaction is
 *     ACCEPTED and the revert has to be dug out of the receipt, from a
 *     different place on each network. `send()` normalises both into
 *     `{ reverted, errorMessage }`; see `executionOutcome`.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet, testnetBradbury } from "genlayer-js/chains";
import {
  executionResultNumberToName,
  transactionsStatusNumberToName,
} from "genlayer-js/types";

/**
 * States that genuinely end a transaction. See `awaitConsensus` for why this is
 * narrower than the SDK's `DECIDED_STATES`.
 */
const TERMINAL_STATES = new Set([
  "ACCEPTED",
  "FINALIZED",
  "UNDETERMINED",
  "CANCELED",
]);
import { readFileSync } from "node:fs";

/**
 * Escrow used by test jobs: 0.001 GEN.
 *
 * Deliberately below 2^53 base units — `get_job` reports `total_amount` inside
 * a JSON string, so anything past `Number.MAX_SAFE_INTEGER` (~0.009 GEN) would
 * lose precision in `JSON.parse` and make the amount assertions lie.
 */
export const TEST_DEPOSIT = 1_000_000_000_000_000n;

/**
 * Both the address under test and the network come from the frontend's env
 * file rather than constants, so a stale `.env.local` fails the suite instead
 * of silently testing a contract the app no longer points at.
 *
 * Reading them from the *same* file is deliberate: address and network are not
 * independent — each network has its own deploy — and a mismatch is silent,
 * turning every read into null. Sourcing both here makes drift impossible.
 *
 * The regexes are anchored and require a leading `NEXT_PUBLIC_`, so the
 * commented-out Bradbury block in `.env.local` is correctly ignored.
 */
function envFromFrontend() {
  const path = new URL("../frontend/.env.local", import.meta.url);
  const text = readFileSync(path, "utf8");

  const address = text.match(
    /^NEXT_PUBLIC_CONTRACT_ADDRESS\s*=\s*(0x[0-9a-fA-F]{40})\s*$/m,
  )?.[1];
  if (!address) {
    throw new Error(
      "No NEXT_PUBLIC_CONTRACT_ADDRESS found in frontend/.env.local",
    );
  }

  // Matches lib/genlayer.ts: unset means studionet.
  const network = text.match(/^NEXT_PUBLIC_GENLAYER_NETWORK\s*=\s*(\S+)\s*$/m)?.[1] ?? "studionet";
  const chain = { studionet, bradbury: testnetBradbury }[network];
  if (!chain) {
    throw new Error(
      `NEXT_PUBLIC_GENLAYER_NETWORK in frontend/.env.local must be studionet | bradbury, got: ${network}`,
    );
  }
  return { address, chain };
}

const { address: CONTRACT_ADDRESS_, chain } = envFromFrontend();
export const CONTRACT_ADDRESS = CONTRACT_ADDRESS_;
export { chain };

/**
 * Throwaway keypairs funded from the CLI wallet. They live outside git because
 * they are only useful for burning testnet GEN.
 */
const accounts = JSON.parse(
  readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"),
);

export const CLIENT = accounts.client.address;
export const FREELANCER = accounts.freelancer.address;

const readClient = createClient({ chain });

const wallets = {
  client: createClient({
    chain,
    account: createAccount(accounts.client.key),
  }),
  freelancer: createClient({
    chain,
    account: createAccount(accounts.freelancer.key),
  }),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consensus settings per write, per network.
 *
 * Bradbury rounds park in COMMITTING with votes committed but none revealed,
 * and stay there indefinitely — a `create_job` sat unmoved for four minutes
 * with three leader rotations still available. They only advance when someone
 * calls `finalizeIdlenessTxs`, and on this testnet nobody else does. So rather
 * than waiting longer, `awaitConsensus` nudges the transaction itself.
 *
 * Studio has no idle queue and settles on its own, so nudging there is not
 * merely useless — `maxNudges: 0` also keeps the poll loop under Studionet's
 * rate limit (60 req/min, 1000/hr per IP), which a nudge storm would burn
 * through and get the whole suite 429'd.
 */
const CONSENSUS = chain.isStudio
  ? {
      intervalMs: 1_000,
      // An LLM round still costs real time on Studio; this only has to be
      // generous enough for verify_milestone, not for a stalled testnet round.
      timeoutMs: 600_000,
      nudgeAfterMs: Infinity,
      maxNudges: 0,
      submitAttempts: 4,
    }
  : {
      intervalMs: 5_000,
      /**
       * Generous on purpose. A `verify_milestone` was observed grinding through
       * PROPOSING -> COMMITTING -> REVEALING -> a full APPEAL_COMMITTING /
       * APPEAL_REVEALING cycle -> another round, and was still live at 822s. The
       * old 900s / 6-nudge budget gave up on transactions that were progressing
       * perfectly well, which read as "the contract is broken" when it was not.
       */
      timeoutMs: 2_700_000,
      /** How long a transaction may sit undecided before we nudge it again. */
      nudgeAfterMs: 60_000,
      maxNudges: 30,
      /** Attempts at getting the submission itself accepted, with backoff. */
      submitAttempts: 4,
    };

/**
 * Bounds a promise that talks to the network.
 *
 * Anything awaited inside a polling loop needs this: an unbounded await blocks
 * the loop past its own deadline, turning a slow call into a permanent hang.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** Progress line, indented to sit under the test it belongs to. */
const note = (message) => console.log(`       · ${message}`);

// ── Reads ────────────────────────────────────────────────────────────────────

async function read(functionName, args = []) {
  return readClient.readContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
  });
}

/** Every view method except `get_job_count` hands back a JSON string. */
async function readJson(functionName, args = []) {
  const raw = await read(functionName, args);
  if (typeof raw !== "string") {
    throw new Error(`${functionName} returned ${typeof raw}, expected a string`);
  }
  return JSON.parse(raw);
}

export const getJobCount = async () => Number(await read("get_job_count"));
export const getJob = (jobId) => readJson("get_job", [jobId]);
export const getMilestone = (jobId, milestoneId) =>
  readJson("get_milestone", [jobId, milestoneId]);
export const getReputation = (address) => readJson("get_reputation", [address]);

/** Contract escrow balance — the honest way to prove a refund actually moved. */
export const getContractBalance = () =>
  readClient.getBalance({ address: CONTRACT_ADDRESS });

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Did the contract code succeed, and if not, why — across both networks.
 *
 * The two report execution outcome in completely different places, and getting
 * this wrong is silent and dangerous: a revert that reads as success turns
 * every `assertReverted` into a false failure, and would let a genuinely
 * missing guard pass unnoticed in the other direction.
 *
 * Bradbury: `txExecutionResultName === "FINISHED_WITH_ERROR"`, with the message
 * only as hex bytes in the debug trace (see `revertMessage`).
 *
 * Studio: `txExecutionResultName` is **undefined**. The outcome lives in
 * `consensus_data.leader_receipt[0].execution_result` ("SUCCESS" | "ERROR"),
 * and `result.status` ("return" | "rollback") alongside it. The upside is that
 * `result.payload` is the already-decoded UserError string, so no trace fetch
 * and no hex scraping is needed.
 *
 * Note Studio's top-level `result_name` is *consensus* ("MAJORITY_AGREE"), not
 * execution — validators can unanimously agree that a call reverted. Reading it
 * as an execution result is exactly the mistake that makes reverts look green.
 */
function executionOutcome(tx) {
  const execName =
    tx?.txExecutionResultName ?? executionResultNumberToName[tx?.txExecutionResult];
  if (execName) return { reverted: execName === "FINISHED_WITH_ERROR", message: "" };

  const receipt = tx?.consensus_data?.leader_receipt;
  const leader = Array.isArray(receipt) ? receipt[0] : receipt;
  if (!leader) {
    throw new Error(
      `Could not determine execution outcome for ${tx?.hash}: no txExecutionResultName ` +
        `and no consensus_data.leader_receipt. Treating it as success would hide a revert.`,
    );
  }

  const reverted =
    leader.execution_result === "ERROR" || leader.result?.status === "rollback";
  const payload = leader.result?.payload;
  return {
    reverted,
    message: reverted && typeof payload === "string" ? payload : "",
  };
}

/**
 * Decodes a reverted transaction's message out of the trace.
 *
 * `return_data` is a GenVM-encoded blob; the UserError string sits in it as
 * plain bytes, so scanning the latin1 decoding for the message is enough and
 * avoids depending on the encoding's internals.
 */
async function revertMessage(hash) {
  try {
    const trace = await readClient.debugTraceTransaction({ hash });
    const data = trace?.return_data;
    if (typeof data !== "string" || !data.startsWith("0x")) return "";

    // The blob is mostly binary — hashes, memory pages, storage diffs. Keeping
    // only the printable runs turns an unreadable dump into the error text
    // plus a little surrounding context. UserError messages are contiguous
    // ASCII, so substring matching against them still works.
    const decoded = Buffer.from(data.slice(2), "hex").toString("latin1");
    const runs = decoded.match(/[\x20-\x7E]{4,}/g) ?? [];
    return runs.join(" | ");
  } catch (error) {
    return `<trace unavailable: ${error?.message}>`;
  }
}

/**
 * Polls a transaction to a decided state, unsticking it when consensus stalls.
 *
 * `waitForTransactionReceipt` is deliberately not used: it only waits, and a
 * round parked in COMMITTING never advances on its own here. Calling
 * `finalizeIdlenessTxs` moves it straight to ACCEPTED with every vote revealed.
 */
async function awaitConsensus(wallet, hash) {
  const startedAt = Date.now();
  const deadline = startedAt + CONSENSUS.timeoutMs;
  let lastNudgeAt = Date.now();
  let lastReported = null;
  let nudges = 0;

  for (;;) {
    const tx = await withTimeout(
      readClient.getTransaction({ hash }),
      30_000,
      "getTransaction",
    ).catch(() => null);
    const statusName = transactionsStatusNumberToName[tx?.status];

    if (statusName !== lastReported) {
      note(`${((Date.now() - startedAt) / 1000).toFixed(0)}s ${statusName ?? "unknown"}`);
      lastReported = statusName;
    }

    // Not `isDecidedState()` — it is broken in genlayer-js 1.1.8 and returns
    // false for every input, including "ACCEPTED", so the loop never exited.
    //
    // Not `DECIDED_STATES` either: it lists LEADER_TIMEOUT and
    // VALIDATORS_TIMEOUT, which are NOT terminal here — the round rotates to a
    // new leader and the transaction continues. Returning on them abandons a
    // live transaction and reports a failure that did not happen. A heavy
    // `verify_milestone` trips this routinely.
    if (statusName && TERMINAL_STATES.has(statusName)) {
      return { tx, statusName, nudges };
    }

    if (
      Date.now() - lastNudgeAt >= CONSENSUS.nudgeAfterMs &&
      nudges < CONSENSUS.maxNudges
    ) {
      nudges += 1;
      lastNudgeAt = Date.now();
      note(`nudge ${nudges}: finalizeIdlenessTxs`);
      // Bounded and best-effort: the nudge is itself a consensus call whose own
      // receipt can hang, and an unbounded await here would freeze this loop
      // past its deadline. It also reverts harmlessly if the round moved on.
      await withTimeout(
        wallet.finalizeIdlenessTxs({ txIds: [hash] }),
        90_000,
        "finalizeIdlenessTxs",
      ).catch((error) => note(`nudge ${nudges} did not settle: ${error.message}`));
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Transaction ${hash} never reached a decided state — last status ` +
          `${statusName ?? tx?.status}, after ${nudges} finalize nudges`,
      );
    }
    await sleep(CONSENSUS.intervalMs);
  }
}

/**
 * Submits a write, retrying when the consensus contract rejects the submission.
 *
 * Distinct from a contract-level revert: this is the *outer* EVM call to the
 * consensus contract failing before the Intelligent Contract ever runs, which
 * happens intermittently when the sender still has an unsettled transaction in
 * its slot. Retrying after a pause clears it; failing here would report a
 * contract bug that does not exist.
 */
async function submit(wallet, functionName, args, value, attempt = 1) {
  try {
    return await wallet.writeContract({
      address: CONTRACT_ADDRESS,
      functionName,
      args,
      ...(value === undefined ? {} : { value }),
    });
  } catch (error) {
    const message = error?.message ?? "";
    const retriable =
      /was reverted|nonce|already known|replacement|underpriced/i.test(message);

    if (!retriable || attempt >= CONSENSUS.submitAttempts) throw error;

    const backoffMs = 15_000 * attempt;
    note(`submit attempt ${attempt} rejected, retrying in ${backoffMs / 1000}s`);
    await sleep(backoffMs);
    return submit(wallet, functionName, args, value, attempt + 1);
  }
}

/**
 * Sends a write and waits for consensus.
 *
 * Resolves for both outcomes — a revert is a normal result here, not an
 * exception — so callers assert on `reverted` explicitly.
 */
export async function send(role, functionName, args = [], value) {
  const wallet = wallets[role];
  if (!wallet) throw new Error(`Unknown role: ${role}`);

  const hash = await submit(wallet, functionName, args, value);
  const { tx, statusName, nudges } = await awaitConsensus(wallet, hash);

  // UNDETERMINED / LEADER_TIMEOUT / VALIDATORS_TIMEOUT are decided but are not
  // outcomes any assertion can be made against.
  if (statusName !== "ACCEPTED" && statusName !== "FINALIZED") {
    throw new Error(
      `${functionName} settled as ${statusName}, not ACCEPTED (${hash})`,
    );
  }

  const outcome = executionOutcome(tx);

  return {
    hash,
    tx,
    nudges,
    reverted: outcome.reverted,
    errorMessage: outcome.reverted
      ? outcome.message || (await revertMessage(hash))
      : "",
  };
}

/**
 * Drives a transaction all the way to FINALIZED.
 *
 * Paying an EOA is an external message through the contract's ghost contract,
 * and those apply on finalization rather than acceptance — so a refund or
 * payout is simply not visible in any balance until this completes. Bradbury
 * does not finalize on its own promptly, hence the explicit call.
 */
export async function finalize(role, hash, { timeoutMs = 600_000 } = {}) {
  const wallet = wallets[role];
  const deadline = Date.now() + timeoutMs;
  let requested = false;

  for (;;) {
    const tx = await withTimeout(
      readClient.getTransaction({ hash }),
      30_000,
      "getTransaction",
    ).catch(() => null);

    if (transactionsStatusNumberToName[tx?.status] === "FINALIZED") return tx;

    if (!requested) {
      requested = true;
      note("requesting finalization");
      await withTimeout(
        wallet.finalizeTransaction({ txId: hash }),
        120_000,
        "finalizeTransaction",
      ).catch((error) => note(`finalize: ${error.message}`));
      // Allow a fresh request if it did not take.
      setTimeout(() => {
        requested = false;
      }, 90_000);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Transaction ${hash} never reached FINALIZED`);
    }
    await sleep(CONSENSUS.intervalMs);
  }
}

// ── Assertions ───────────────────────────────────────────────────────────────

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${expected}, got ${actual}`);
  }
}

export function assertAccepted(result, what) {
  assert(
    !result.reverted,
    `${what}: expected success but the transaction reverted (${result.hash}) — ${result.errorMessage}`,
  );
  return result;
}

/** Asserts a write reverted *and* that it failed for the expected reason. */
export function assertReverted(result, expectedMessage, what) {
  assert(
    result.reverted,
    `${what}: expected a revert but the transaction succeeded (${result.hash})`,
  );
  assert(
    result.errorMessage.includes(expectedMessage),
    `${what}: expected the error to mention "${expectedMessage}", but the trace read: ${JSON.stringify(
      result.errorMessage.slice(0, 300),
    )}`,
  );
  return result;
}

/**
 * Polls a read until it satisfies `predicate`.
 *
 * This is the fix for the read-lag problem: asserting straight after a write
 * produces flaky failures because the node may still serve pre-write state.
 * Reads that throw are treated as "not ready yet" — querying a job that hasn't
 * landed raises rather than returning empty.
 */
export async function waitForState(
  readFn,
  predicate,
  label,
  { timeoutMs = 90_000, intervalMs = 2_500 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;

  for (;;) {
    try {
      last = await readFn();
      lastError = undefined;
      if (predicate(last)) return last;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      const seen = lastError
        ? `read kept failing: ${lastError.message}`
        : `last value: ${JSON.stringify(last)}`;
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label} — ${seen}`,
      );
    }
    await sleep(intervalMs);
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

const tests = [];

/** Registers a test. Order matters: later tests build on earlier state. */
export function test(name, fn) {
  tests.push({ name, fn });
}

export async function run() {
  console.log(`ProofWork integration suite`);
  console.log(`  contract   ${CONTRACT_ADDRESS}  (from frontend/.env.local)`);
  console.log(`  client     ${CLIENT}`);
  console.log(`  freelancer ${FREELANCER}\n`);

  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const failures = [];
  let ran = 0;

  for (const [index, { name, fn }] of tests.entries()) {
    const number = index + 1;
    if (only.length && !only.includes(number)) continue;
    ran += 1;

    const label = `${String(number).padStart(2, " ")}. ${name}`;
    const startedAt = Date.now();
    try {
      await fn();
      console.log(`PASS ${label}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failures.push({ number, name, error });
      console.log(`FAIL ${label}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      console.log(`       ${error.message}`);
    }
  }

  // Count what actually ran, not what was registered — a filtered run that
  // executed two tests must not report the whole suite as passing.
  console.log(
    `\n${ran - failures.length}/${ran} passed` +
      (failures.length ? `, ${failures.length} failed` : "") +
      (ran < tests.length ? ` (${tests.length - ran} not run)` : ""),
  );

  if (failures.length) {
    console.log("\nFailures:");
    for (const { number, name, error } of failures) {
      console.log(`  ${number}. ${name}\n     ${error.message}`);
    }
    process.exitCode = 1;
  }
}
