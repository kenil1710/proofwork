/**
 * Measures how long the ordinary (non-LLM) writes actually take on whichever
 * network `frontend/.env.local` currently points at.
 *
 * The point of comparison is Bradbury, where a `create_job` routinely sat in
 * COMMITTING for minutes and only moved when the harness called
 * `finalizeIdlenessTxs` at it. This script exists to show that number, not to
 * assert behaviour — the correctness suites (`stake-e2e.mjs`, `verify-e2e.mjs`)
 * still own that.
 *
 * `verify_milestone` is deliberately excluded: it runs an LLM round and page
 * renders, so it is slow on every network and would drown out the signal.
 *
 * Usage: node timing.mjs
 */
import {
  CONTRACT_ADDRESS,
  TEST_DEPOSIT,
  chain,
  getJob,
  getJobCount,
  send,
  waitForState,
} from "./harness.mjs";

const DEADLINE_S = 7 * 24 * 60 * 60;
const STAKE_PCT = 10;

const laps = [];

async function lap(label, fn) {
  const startedAt = Date.now();
  const value = await fn();
  const seconds = (Date.now() - startedAt) / 1000;
  laps.push({ label, seconds });
  console.log(`  ${label.padEnd(34)} ${seconds.toFixed(1)}s`);
  return value;
}

console.log(`network:  ${chain.name} (id ${chain.id})`);
console.log(`rpc:      ${chain.rpcUrls.default.http[0]}`);
console.log(`contract: ${CONTRACT_ADDRESS}\n`);

// Ids are dense and 0-based, so the next one is the current count. Reading it
// *before* the write matters: deriving the id from the write result silently
// falls back to 0 and points every later step at a stale job.
const expectedId = await lap("get_job_count (view)", getJobCount);

const created = await lap("create_job -> decided", () =>
  send(
    "client",
    "create_job",
    [
      "Studionet timing probe",
      "A single-milestone job used only to measure write latency.",
      "Only milestone",
      "100",
      DEADLINE_S,
      STAKE_PCT,
    ],
    TEST_DEPOSIT,
  ),
);

if (created.reverted) {
  throw new Error(`create_job reverted: ${created.message ?? "(no message)"}`);
}

// Acceptance and read-visibility are separate clocks: Bradbury serves reads
// from a lagging view, so a job can be accepted and still not be queryable.
const job = await lap("job readable after accept", () =>
  waitForState(
    () => getJob(expectedId),
    (j) => !!j && j.status === "open",
    `job ${expectedId} to appear as open`,
  ),
);

const stake = BigInt(job.required_stake);
const accepted = await lap("accept_job -> decided", () =>
  send("freelancer", "accept_job", [expectedId], stake),
);

if (accepted.reverted) {
  throw new Error(`accept_job reverted: ${accepted.message ?? "(no message)"}`);
}

await lap("job readable as in_progress", () =>
  waitForState(
    () => getJob(expectedId),
    (j) => !!j && j.status === "in_progress",
    `job ${expectedId} to reach in_progress`,
  ),
);

const total = laps.reduce((sum, l) => sum + l.seconds, 0);
const createTotal = laps
  .filter((l) => l.label.startsWith("create_job") || l.label.startsWith("job readable after"))
  .reduce((sum, l) => sum + l.seconds, 0);

console.log(`\njob id ${expectedId} created and accepted in ${total.toFixed(1)}s total`);
console.log(`create_job, submit to readable: ${createTotal.toFixed(1)}s`);
