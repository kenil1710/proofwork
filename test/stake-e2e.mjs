/**
 * End-to-end for the anti-scam mechanism: deadline + freelancer stake.
 *
 * Covers the paths that move money on the failure side, which are the ones
 * worth testing against the real chain:
 *   1. accept with no stake            -> reverts
 *   2. accept with the wrong stake     -> reverts
 *   3. accept with the exact stake     -> succeeds, stake recorded
 *   4. abandon before the deadline     -> reverts
 *   5. abandon after the deadline      -> client is made whole, stake forfeited
 *
 * The milestone-verification path (stake returned on completion) is exercised
 * by verify-e2e.mjs, which needs an LLM round and runs for minutes.
 */
import {
  CLIENT,
  FREELANCER,
  assert,
  assertAccepted,
  assertEqual,
  assertReverted,
  getJob,
  getJobCount,
  send,
  test,
  run,
  waitForState,
} from "./harness.mjs";

const DEPOSIT = 1_000_000_000_000_000n; // 0.001 GEN
const STAKE_PCT = 10;
const EXPECTED_STAKE = (DEPOSIT / 100n) * BigInt(STAKE_PCT);

/** Deadline short enough that the test can outlive it. */
const SHORT_DEADLINE_S = 2;
const LONG_DEADLINE_S = 86_400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createJob(deadlineSeconds, stakePct = STAKE_PCT) {
  // Ids are dense and 0-based, so the job about to be created lands at the
  // current count. Read it BEFORE the write — deriving the id from the write's
  // return value silently fell back to 0 when the field was absent, which sent
  // three tests at an already-accepted job 0 and made the contract look broken.
  const expectedId = await getJobCount();

  const result = assertAccepted(
    await send(
      "client",
      "create_job",
      [
        "Stake test job",
        "A single deliverable used to exercise the stake and deadline rules.",
        "Only milestone",
        "100",
        deadlineSeconds,
        stakePct,
      ],
      DEPOSIT,
    ),
    "create_job",
  );

  // Confirm the id really is the one we predicted before anything relies on it.
  const job = await waitForState(
    () => getJob(expectedId),
    (j) => !!j && j.status === "open",
    `job ${expectedId} to appear as open`,
  );
  return { id: expectedId, job, result };
}

test("create_job stores deadline and required stake", async () => {
  const { job } = await createJob(LONG_DEADLINE_S);

  assertEqual(String(job.required_stake), String(EXPECTED_STAKE), "required_stake");
  assertEqual(String(job.freelancer_stake), "0", "freelancer_stake before accept");
  assert(job.deadline > job.now, `deadline (${job.deadline}) should be ahead of chain now (${job.now})`);
  assert(
    job.deadline - job.now > LONG_DEADLINE_S - 120,
    `deadline should be ~${LONG_DEADLINE_S}s out, got ${job.deadline - job.now}s`,
  );
  console.log(`    required_stake=${job.required_stake}  deadline-now=${job.deadline - job.now}s`);
});

test("create_job rejects a stake percentage above the cap", async () => {
  assertReverted(
    await send(
      "client",
      "create_job",
      ["Too greedy", "x", "m", "100", LONG_DEADLINE_S, 51],
      DEPOSIT,
    ),
    "between 0 and 50",
    "create_job with 51% stake",
  );
});

test("create_job rejects a zero deadline", async () => {
  assertReverted(
    await send("client", "create_job", ["No deadline", "x", "m", "100", 0, 10], DEPOSIT),
    "more than zero seconds",
    "create_job with 0s deadline",
  );
});

test("accept_job without a stake reverts", async () => {
  const { id } = await createJob(LONG_DEADLINE_S);

  assertReverted(
    await send("freelancer", "accept_job", [id], 0n),
    "Must stake exactly",
    "accept with no stake",
  );

  const job = await getJob(id);
  assertEqual(job.status, "open", "job stays open after a failed accept");
});

test("accept_job with the wrong stake reverts", async () => {
  const { id } = await createJob(LONG_DEADLINE_S);

  assertReverted(
    await send("freelancer", "accept_job", [id], EXPECTED_STAKE - 1n),
    "Must stake exactly",
    "accept with stake short by 1",
  );
});

test("accept_job with the exact stake succeeds and records it", async () => {
  const { id } = await createJob(LONG_DEADLINE_S);

  assertAccepted(
    await send("freelancer", "accept_job", [id], EXPECTED_STAKE),
    "accept with exact stake",
  );

  const job = await waitForState(
    () => getJob(id),
    (j) => j.status === "in_progress",
    "job to read as in_progress",
  );
  assertEqual(String(job.freelancer_stake), String(EXPECTED_STAKE), "freelancer_stake");
  assertEqual(job.freelancer.toLowerCase(), FREELANCER.toLowerCase(), "freelancer");
  assert(job.accepted_at > 0, `accepted_at should be set, got ${job.accepted_at}`);
});

test("abandon_job before the deadline reverts", async () => {
  const { id } = await createJob(LONG_DEADLINE_S);
  assertAccepted(await send("freelancer", "accept_job", [id], EXPECTED_STAKE), "accept");
  await waitForState(() => getJob(id), (j) => j.status === "in_progress", "in_progress");

  assertReverted(
    await send("client", "abandon_job", [id], 0n),
    "Deadline has not passed",
    "abandon before deadline",
  );
});

test("abandon_job after the deadline pays the client escrow plus the stake", async () => {
  const { id } = await createJob(SHORT_DEADLINE_S);
  assertAccepted(await send("freelancer", "accept_job", [id], EXPECTED_STAKE), "accept");
  await waitForState(() => getJob(id), (j) => j.status === "in_progress", "in_progress");

  // Let the chain clock pass the deadline. Consensus alone usually covers it,
  // but sleeping makes the test independent of how fast the round settles.
  await sleep((SHORT_DEADLINE_S + 4) * 1000);

  assertAccepted(await send("client", "abandon_job", [id], 0n), "abandon after deadline");

  const job = await waitForState(
    () => getJob(id),
    (j) => j.status === "abandoned",
    "job to read as abandoned",
  );
  assertEqual(String(job.freelancer_stake), "0", "stake is zeroed after forfeiture");
  console.log(
    `    escrow ${job.total_amount} + stake ${EXPECTED_STAKE} returned to client; freelancer forfeited ${EXPECTED_STAKE}`,
  );
});

test("a non-client cannot abandon", async () => {
  const { id } = await createJob(SHORT_DEADLINE_S);
  assertAccepted(await send("freelancer", "accept_job", [id], EXPECTED_STAKE), "accept");
  await waitForState(() => getJob(id), (j) => j.status === "in_progress", "in_progress");
  await sleep((SHORT_DEADLINE_S + 4) * 1000);

  assertReverted(
    await send("freelancer", "abandon_job", [id], 0n),
    "Only client can abandon",
    "freelancer trying to abandon",
  );
});

await run();
