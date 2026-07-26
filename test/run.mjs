/**
 * ProofWork integration suite — non-AI paths only.
 *
 * Covers create/accept/submit/cancel and the view methods. `verify_milestone`
 * is deliberately excluded: it renders pages and runs four LLM prompts across
 * validators, so it belongs in a separate, slower suite.
 *
 * Tests run in order and share state — test 2 opens the job that the accept and
 * submit tests then operate on.
 *
 *   node run.mjs        # whole suite
 *   node run.mjs 6 7    # only the numbered tests
 */
import {
  CLIENT,
  FREELANCER,
  TEST_DEPOSIT,
  assert,
  assertAccepted,
  assertEqual,
  assertReverted,
  finalize,
  getContractBalance,
  getJob,
  getJobCount,
  getMilestone,
  getReputation,
  run,
  send,
  test,
  waitForState,
} from "./harness.mjs";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const REQUIREMENTS =
  "React + Tailwind portfolio site. Responsive, dark mode, accessible.";
const MILESTONES = "Homepage and navigation|Dashboard and auth|Polish and deploy";
const PERCENTAGES = "30|40|30";

/** Opened in test 2, then accepted, submitted against, and cancel-tested. */
let mainJobId;
/** A second open job, so the cancel tests don't disturb the main one. */
let cancelJobId;
/** Carried from the cancel test to the opt-in finalization test. */
let cancelTxHash;
let balanceBeforeCancel;

/**
 * Refunds and payouts are external messages to EOAs, which only apply once the
 * transaction finalizes — observed to take far longer than a test run. Pass
 * `--slow` to additionally assert the GEN really moves.
 */
const RUN_SLOW = process.argv.includes("--slow");

test("baseline — contract is reachable and reports a job count", async () => {
  const count = await getJobCount();
  assert(
    Number.isInteger(count) && count >= 0,
    `get_job_count returned ${count}`,
  );
});

test("create_job — opens a job and locks the escrow", async () => {
  const countBefore = await getJobCount();
  const balanceBefore = await getContractBalance();

  const result = await send(
    "client",
    "create_job",
    ["Portfolio site", REQUIREMENTS, MILESTONES, PERCENTAGES],
    TEST_DEPOSIT,
  );
  assertAccepted(result, "create_job");

  // Ids are dense and 0-based, so the new job takes the pre-write count.
  mainJobId = countBefore;
  await waitForState(
    getJobCount,
    (count) => count === countBefore + 1,
    `job count to reach ${countBefore + 1}`,
  );

  const job = await waitForState(
    () => getJob(mainJobId),
    (j) => j.status === "open",
    `job ${mainJobId} to read as open`,
  );

  assertEqual(job.client.toLowerCase(), CLIENT.toLowerCase(), "job client");
  assertEqual(
    job.freelancer.toLowerCase(),
    ZERO_ADDRESS,
    "freelancer on a fresh job",
  );
  assertEqual(job.total_amount, Number(TEST_DEPOSIT), "escrowed amount");
  assertEqual(job.milestone_count, 3, "milestone count");
  assertEqual(job.completed_milestones, 0, "completed milestones");

  const balanceAfter = await getContractBalance();
  assertEqual(
    balanceAfter - balanceBefore,
    TEST_DEPOSIT,
    "escrow added to the contract balance",
  );
});

test("create_job — rejects percentages that do not sum to 100", async () => {
  const countBefore = await getJobCount();

  const result = await send(
    "client",
    "create_job",
    ["Bad percentages", REQUIREMENTS, "First half|Second half", "30|30"],
    TEST_DEPOSIT,
  );
  assertReverted(
    result,
    "Milestone percentages must sum to 100",
    "create_job totalling 60%",
  );

  assertEqual(
    await getJobCount(),
    countBefore,
    "job count after a rejected create",
  );
});

test("create_job — rejects mismatched description and percentage counts", async () => {
  const countBefore = await getJobCount();

  const result = await send(
    "client",
    "create_job",
    ["Mismatched", REQUIREMENTS, "One|Two|Three", "50|50"],
    TEST_DEPOSIT,
  );
  assertReverted(
    result,
    "Milestone descriptions and percentages must match",
    "create_job with 3 descriptions and 2 percentages",
  );

  assertEqual(
    await getJobCount(),
    countBefore,
    "job count after a rejected create",
  );
});

test("create_job — rejects a job with no escrow", async () => {
  const countBefore = await getJobCount();

  const result = await send(
    "client",
    "create_job",
    ["No deposit", REQUIREMENTS, "Only milestone", "100"],
    0n,
  );
  assertReverted(result, "Must deposit GEN for escrow", "create_job with 0 value");

  assertEqual(
    await getJobCount(),
    countBefore,
    "job count after a rejected create",
  );
});

test("accept_job — client cannot accept their own job", async () => {
  const result = await send("client", "accept_job", [mainJobId]);
  assertReverted(
    result,
    "Client cannot accept their own job",
    "client accepting their own job",
  );

  const job = await getJob(mainJobId);
  assertEqual(job.status, "open", "status after a rejected self-accept");
  assertEqual(
    job.freelancer.toLowerCase(),
    ZERO_ADDRESS,
    "freelancer after a rejected self-accept",
  );
});

test("accept_job — freelancer takes the job and it moves to in_progress", async () => {
  const result = await send("freelancer", "accept_job", [mainJobId]);
  assertAccepted(result, "accept_job");

  const job = await waitForState(
    () => getJob(mainJobId),
    (j) => j.status === "in_progress",
    `job ${mainJobId} to read as in_progress`,
  );
  assertEqual(
    job.freelancer.toLowerCase(),
    FREELANCER.toLowerCase(),
    "assigned freelancer",
  );
});

test("accept_job — an accepted job cannot be accepted again", async () => {
  const result = await send("freelancer", "accept_job", [mainJobId]);
  assertReverted(result, "Job is not open", "re-accepting a taken job");

  const job = await getJob(mainJobId);
  assertEqual(job.status, "in_progress", "status after a rejected re-accept");
  assertEqual(
    job.freelancer.toLowerCase(),
    FREELANCER.toLowerCase(),
    "freelancer is unchanged",
  );
});

test("submit_milestone — rejects anyone but the assigned freelancer", async () => {
  const result = await send("client", "submit_milestone", [
    mainJobId,
    0,
    "https://github.com/example/portfolio",
    "none",
    "none",
  ]);
  assertReverted(
    result,
    "Only assigned freelancer can submit",
    "client submitting a milestone",
  );

  const milestone = await getMilestone(mainJobId, 0);
  assertEqual(milestone.status, "pending", "milestone after a rejected submit");
});

test("submit_milestone — freelancer submits evidence and it flips to submitted", async () => {
  const githubUrl = "https://github.com/example/portfolio";

  const result = await send("freelancer", "submit_milestone", [
    mainJobId,
    0,
    githubUrl,
    "none",
    "none",
  ]);
  assertAccepted(result, "submit_milestone");

  const milestone = await waitForState(
    () => getMilestone(mainJobId, 0),
    (m) => m.status === "submitted",
    `milestone ${mainJobId}:0 to read as submitted`,
  );

  assertEqual(milestone.github_url, githubUrl, "stored github url");
  assertEqual(milestone.percentage, 30, "milestone percentage");
  assertEqual(
    milestone.scores.final_weighted,
    0,
    "final score before verification",
  );
});

test("cancel_job — rejects a caller who is not the client", async () => {
  const countBefore = await getJobCount();

  const created = await send(
    "client",
    "create_job",
    ["Cancellable job", REQUIREMENTS, "Only milestone", "100"],
    TEST_DEPOSIT,
  );
  assertAccepted(created, "create_job for the cancel tests");

  cancelJobId = countBefore;
  await waitForState(
    () => getJob(cancelJobId),
    (j) => j.status === "open",
    `job ${cancelJobId} to read as open`,
  );

  const result = await send("freelancer", "cancel_job", [cancelJobId]);
  assertReverted(result, "Only client can cancel", "freelancer cancelling");

  assertEqual(
    (await getJob(cancelJobId)).status,
    "open",
    "status after a rejected cancel",
  );
});

test("cancel_job — client cancels an open job and the refund is emitted", async () => {
  balanceBeforeCancel = await getContractBalance();

  const result = await send("client", "cancel_job", [cancelJobId]);
  // The regression this guards: paying an EOA via `gl.ContractAt` raised a
  // VmError here and rolled the whole call back, leaving the job open and the
  // escrow unrecoverable. Reaching FINISHED_WITH_RETURN means the transfer
  // message was emitted; the GEN itself moves at finalization (test 15).
  assertAccepted(result, "cancel_job");
  cancelTxHash = result.hash;

  await waitForState(
    () => getJob(cancelJobId),
    (j) => j.status === "cancelled",
    `job ${cancelJobId} to read as cancelled`,
  );
});

test("cancel_job — rejects cancelling a job already in progress", async () => {
  const result = await send("client", "cancel_job", [mainJobId]);
  assertReverted(
    result,
    "Can only cancel open jobs",
    "cancelling an in_progress job",
  );

  assertEqual(
    (await getJob(mainJobId)).status,
    "in_progress",
    "status after a rejected cancel",
  );
});

test("get_reputation — an address with no completed jobs reads as zeroed", async () => {
  const reputation = await getReputation(FREELANCER);

  assertEqual(reputation.jobs_completed, 0, "jobs completed");
  assertEqual(reputation.avg_score, 0, "average score");
  assertEqual(reputation.scores.length, 0, "score history length");
});

if (RUN_SLOW) {
  test("cancel_job — the escrow actually leaves the contract (slow)", async () => {
    assert(cancelTxHash, "the cancel test must run first to produce a tx hash");

    // Bradbury finalizes on its own eventually; `finalize` also asks, which
    // only takes effect once the transaction is READY_TO_FINALIZE.
    await finalize("client", cancelTxHash, { timeoutMs: 3_600_000 });

    await waitForState(
      getContractBalance,
      (balance) => balance === balanceBeforeCancel - TEST_DEPOSIT,
      "the contract balance to drop by the refunded escrow",
      { timeoutMs: 600_000, intervalMs: 10_000 },
    );
  });
}

await run();
