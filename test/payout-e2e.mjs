/**
 * Exercises the PAYOUT branch of `verify_milestone` — the path job 1 cannot
 * reach, because its evidence URL (github.com/example/portfolio) is a 404
 * placeholder that no honest scorer can pass.
 *
 * Creates a job whose requirements truthfully describe a real, live project,
 * points a milestone at that project's actual repository and deployed site, and
 * verifies it. Evidence is repo + site with no mockup, so the contract's weight
 * table gives code 35 / functionality 35 / completeness 30 and design_match is
 * genuinely not assessed — the honest shape for this evidence, rather than
 * feeding the same URL in twice to manufacture a design score.
 *
 * Usage: node payout-e2e.mjs
 */
import { createClient } from "genlayer-js";
import {
  CLIENT,
  FREELANCER,
  TEST_DEPOSIT,
  assertAccepted,
  chain,
  getContractBalance,
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

// Truthful description of tailwindcss.com — the site the evidence points at.
const TITLE = "Tailwind CSS documentation site";
const REQUIREMENTS = [
  "A documentation website for a utility-first CSS framework.",
  "Must include: a homepage introducing the framework and its core idea;",
  "comprehensive documentation pages covering utility classes, layout, typography,",
  "colors and responsive design; working navigation and search across the docs;",
  "copyable code examples throughout; a responsive layout that works on mobile;",
  "and dark mode support. The underlying framework source should be a maintained,",
  "well-structured open-source codebase with tests and documentation.",
].join(" ");
const MILESTONE = "Homepage and documentation navigation";
const GITHUB = "https://github.com/tailwindlabs/tailwindcss";
const SITE = "https://tailwindcss.com";

console.log("=== payout-branch end-to-end ===\n");
console.log(`evidence: ${GITHUB}`);
console.log(`          ${SITE}`);
console.log(`expected weights: code=35 design=0 (no mockup) func=35 comp=30\n`);

// ── 1. Create ────────────────────────────────────────────────────────────────
const expectedId = await getJobCount();
console.log(`Creating job (will be id ${expectedId}), escrow ${fmt(TEST_DEPOSIT)} GEN…`);
assertAccepted(
  await send("client", "create_job", [TITLE, REQUIREMENTS, MILESTONE, "100"], TEST_DEPOSIT),
  "create_job",
);
const jobId = expectedId;
await waitForState(() => getJob(jobId), (j) => j.status === "open", "the job to be readable");
console.log(`  job ${jobId} open\n`);

// ── 2. Accept ────────────────────────────────────────────────────────────────
console.log("Freelancer accepting…");
assertAccepted(await send("freelancer", "accept_job", [jobId]), "accept_job");
await waitForState(() => getJob(jobId), (j) => j.status === "in_progress", "the job to be accepted");
console.log("  accepted\n");

// ── 3. Submit ────────────────────────────────────────────────────────────────
console.log("Freelancer submitting evidence…");
assertAccepted(
  await send("freelancer", "submit_milestone", [jobId, 0, GITHUB, SITE, "none"]),
  "submit_milestone",
);
await waitForState(
  () => getMilestone(jobId, 0),
  (m) => m.status === "submitted",
  "the submission to be readable",
);
console.log("  submitted\n");

// ── 4. Verify ────────────────────────────────────────────────────────────────
const balBefore = {
  contract: await getContractBalance(),
  freelancer: await chainClient.getBalance({ address: FREELANCER }),
};
console.log("Running verify_milestone — renders the repo and the site, screenshots");
console.log("the site, and runs three LLM prompts on every validator…");
const startedAt = Date.now();
const result = await send("client", "verify_milestone", [jobId, 0]);
console.log(`\n  settled in ${((Date.now() - startedAt) / 1000).toFixed(0)}s, ${result.nudges} nudge(s)`);

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

const w = { code: 35, design: 0, func: 35, comp: 30 };
const s = ms.scores;
console.log(`\nSCORES`);
console.log(`  code_quality   ${String(s.code_quality).padStart(3)}  weight ${w.code}%`);
console.log(`  design_match   ${String(s.design_match).padStart(3)}  weight ${w.design}%  (not assessed — no mockup)`);
console.log(`  functionality  ${String(s.functionality).padStart(3)}  weight ${w.func}%`);
console.log(`  completeness   ${String(s.completeness).padStart(3)}  weight ${w.comp}%`);
console.log(`  final_weighted ${String(s.final_weighted).padStart(3)}`);

const recomputed = Math.floor(
  (s.code_quality * w.code + s.design_match * w.design + s.functionality * w.func + s.completeness * w.comp) / 100,
);
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
console.log(`  expected  ${fmt(payout)} GEN to ${FREELANCER}`);
const tx = await chainClient.getTransaction({ hash: result.hash });
console.log(`  tx.messages: ${JSON.stringify(tx?.messages ?? null)}`);
console.log(`  contract balance ${fmt(balBefore.contract)} -> ${fmt(await getContractBalance())}`);
console.log(`  (transfers apply on FINALIZATION, so an unchanged balance is expected)`);

// Reputation only records once EVERY milestone of the job is verified. This job
// has exactly one, so a verified milestone should complete it.
if (job.status === "completed") {
  const rep = JSON.parse(
    await chainClient.readContract({
      address: (await import("./harness.mjs")).CONTRACT_ADDRESS,
      functionName: "get_reputation",
      args: [FREELANCER],
    }),
  );
  console.log(`\nREPUTATION for ${FREELANCER}`);
  console.log(`  jobs_completed ${rep.jobs_completed}  avg ${rep.avg_score}  scores [${rep.scores}]`);
}

console.log(`\njob id ${jobId} — view at /job/${jobId}`);
console.log("=== done ===");
