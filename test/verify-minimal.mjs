/**
 * Smallest possible real verification, to answer one question: does the nondet
 * pipeline work at all now that the copy_to_memory/str() bug is fixed?
 *
 * The tailwindcss run proved nothing about correctness — it died as
 * VALIDATORS_TIMEOUT with all 5 validators revealing a timeout vote, i.e. the
 * workload (5 page renders incl. a screenshot + 3 LLM prompts per validator)
 * simply exceeds Bradbury's budget.
 *
 * So: GitHub-only evidence pointing at example.com — about 1KB, renders
 * instantly. Weights become code 50 / completeness 50.
 *
 * As of the evidence-integrity restructure this is one render + one LLM prompt
 * on the leader, and one render (no LLM) on each validator. First run to fully
 * succeed: 194s, scores 90/80 -> final 85, milestone verified, job completed.
 *
 * Usage: node verify-minimal.mjs
 */
import { createClient } from "genlayer-js";
import {
  CONTRACT_ADDRESS,
  FREELANCER,
  TEST_DEPOSIT,
  assertAccepted,
  chain,
  getJob,
  getJobCount,
  getMilestone,
  send,
  waitForState,
} from "./harness.mjs";

const GEN = 10n ** 18n;
const fmt = (b) => {
  const f = (b % GEN).toString().padStart(18, "0").replace(/0+$/, "");
  return f ? `${b / GEN}.${f}` : `${b / GEN}`;
};
const chainClient = createClient({ chain });

const TITLE = "Minimal landing page";
const REQUIREMENTS =
  "A single minimal HTML landing page. It must have a title, one heading, a " +
  "short paragraph of explanatory text, and a link to more information. No " +
  "styling framework, no build step, no JavaScript required.";
const MILESTONE = "The landing page";
const GITHUB = "https://example.com";

console.log(`=== minimal verification ===`);
console.log(`contract ${CONTRACT_ADDRESS}`);
console.log(`evidence ${GITHUB} (github slot only, no site, no mockup)`);
console.log(`weights  code=50 design=0 func=0 comp=50 -> 1 render + 1 prompt (leader), 1 render (each validator)\n`);

const jobId = await getJobCount();
console.log(`create_job (id ${jobId})…`);
assertAccepted(
  await send("client", "create_job", [TITLE, REQUIREMENTS, MILESTONE, "100"], TEST_DEPOSIT),
  "create_job",
);
await waitForState(() => getJob(jobId), (j) => j.status === "open", "job open");

console.log(`accept_job…`);
assertAccepted(await send("freelancer", "accept_job", [jobId]), "accept_job");
await waitForState(() => getJob(jobId), (j) => j.status === "in_progress", "job accepted");

console.log(`submit_milestone…`);
assertAccepted(
  await send("freelancer", "submit_milestone", [jobId, 0, GITHUB, "none", "none"]),
  "submit_milestone",
);
await waitForState(() => getMilestone(jobId, 0), (m) => m.status === "submitted", "submitted");

console.log(`\nverify_milestone — leader: 1 render + 1 LLM prompt; validators: 1 render, no LLM…`);
const started = Date.now();
const result = await send("client", "verify_milestone", [jobId, 0]);
console.log(`  settled in ${((Date.now() - started) / 1000).toFixed(0)}s, ${result.nudges} nudge(s)`);

if (result.reverted) {
  console.log(`  REVERTED: ${result.errorMessage}`);
  process.exit(1);
}

const ms = await waitForState(
  () => getMilestone(jobId, 0),
  (m) => m.status !== "submitted",
  "the verdict",
  { timeoutMs: 180_000, intervalMs: 5_000 },
);
const job = await getJob(jobId);
const s = ms.scores;

console.log(`\nSCORES`);
console.log(`  code_quality   ${String(s.code_quality).padStart(3)}   weight 50%`);
console.log(`  design_match   ${String(s.design_match).padStart(3)}   weight  0%  (not assessed — no mockup)`);
console.log(`  functionality  ${String(s.functionality).padStart(3)}   weight  0%  (not assessed — no site)`);
console.log(`  completeness   ${String(s.completeness).padStart(3)}   weight 50%`);
console.log(`  final_weighted ${String(s.final_weighted).padStart(3)}`);

const recomputed = Math.floor((s.code_quality * 50 + s.completeness * 50) / 100);
console.log(`  recomputed     ${recomputed} — ${recomputed === s.final_weighted ? "MATCHES" : "MISMATCH"}`);

console.log(`\nSTATE`);
console.log(`  milestone.status         ${ms.status}`);
console.log(`  job.completed_milestones ${job.completed_milestones}/${job.milestone_count}`);
console.log(`  job.status               ${job.status}`);

const total = BigInt(job.total_amount);
const share = (total / 100n) * BigInt(ms.percentage);
const f = s.final_weighted;
const payout = f >= 90 ? share : f >= 80 ? (share / 100n) * 80n : f >= 70 ? (share / 100n) * 70n : 0n;
console.log(`\nPAYOUT`);
console.log(`  expected ${fmt(payout)} GEN to the freelancer (final=${f})`);
const tx = await chainClient.getTransaction({ hash: result.hash });
// BigInt is not JSON-serialisable and the payout amounts are BigInt, so a plain
// stringify throws here — after the run has already fully succeeded.
console.log(
  `  tx.messages: ${JSON.stringify(tx?.messages ?? null, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
);

if (job.status === "completed") {
  const rep = JSON.parse(
    await chainClient.readContract({
      address: CONTRACT_ADDRESS, functionName: "get_reputation", args: [FREELANCER],
    }),
  );
  console.log(`\nREPUTATION ${FREELANCER}`);
  console.log(`  jobs_completed ${rep.jobs_completed}  avg ${rep.avg_score}  scores [${rep.scores}]`);
}
console.log(`\njob ${jobId} — /job/${jobId}\n=== done ===`);
