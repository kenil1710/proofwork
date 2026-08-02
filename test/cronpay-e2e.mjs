/**
 * The CronPay submission, end to end, against whatever contract .env.local names.
 *
 * Recreates job 1 from `0x2c28B36b359fD90233E79a04611B9F463e44C92F` verbatim —
 * same requirements, same three milestone descriptions, same evidence URLs — so
 * the evidence-selection fixes are measured against the case that motivated
 * them rather than against a fresh fixture.
 *
 *   node cronpay-e2e.mjs
 *   node cronpay-e2e.mjs --no-verify
 */
import {
  FREELANCER, TEST_DEPOSIT, assertAccepted, getJob, getJobCount,
  getMilestone, send, waitForState,
} from "./harness.mjs";
import { readFileSync } from "node:fs";

const SITE = "https://cronpay.co/";
const MS = [
  { gh: "https://github.com/cronpay-code/cronpay/tree/main/contracts", pct: 40 },
  { gh: "https://github.com/cronpay-code/cronpay/tree/main/Frontend", pct: 35 },
  { gh: "https://github.com/cronpay-code/cronpay", pct: 25 },
];
// Read straight from the dumps taken off the old contract, so the text is the
// original byte-for-byte rather than a retyped approximation.
const OLD = MS.map((_, i) => JSON.parse(readFileSync(`/tmp/cronpay-m${i}.json`, "utf8")));
const TITLE = "Build Escrow-Based USDC Payment System for Remote Teams";
const REQUIREMENTS = OLD[0].requirements;
const DESCS = OLD.map((o) => o.milestone_desc);

const jobId = await getJobCount();
console.log(`\ncreate_job -> job ${jobId}`);
assertAccepted(await send("client", "create_job",
  [TITLE, REQUIREMENTS, DESCS.join("|"), MS.map((m) => m.pct).join("|"),
   7 * 24 * 60 * 60, 0], TEST_DEPOSIT), "create_job");
await waitForState(() => getJob(jobId), (j) => j?.status === "open", "job open");

console.log("accept_job");
const job = await getJob(jobId);
assertAccepted(await send("freelancer", "accept_job", [jobId],
  BigInt(job.required_stake ?? 0)), "accept_job");
await waitForState(() => getJob(jobId), (j) => j?.status === "in_progress", "in_progress");

for (let i = 0; i < MS.length; i++) {
  console.log(`submit_milestone ${i}`);
  assertAccepted(await send("freelancer", "submit_milestone",
    [jobId, i, MS[i].gh, SITE, "none"]), `submit_milestone ${i}`);
  await waitForState(() => getMilestone(jobId, i), (m) => m?.status === "submitted",
    `milestone ${i} submitted`);
}

if (process.argv.includes("--no-verify")) { console.log(`\njob ${jobId} ready`); process.exit(0); }

for (let i = 0; i < MS.length; i++) {
  console.log(`\nverify_milestone ${i} — fetching evidence and scoring…`);
  const t0 = Date.now();
  const r = await send("client", "verify_milestone", [jobId, i]);
  console.log(`  settled in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (r.reverted) { console.log(`  REVERTED: ${r.errorMessage}`); continue; }
  const m = await waitForState(() => getMilestone(jobId, i),
    (x) => x?.status === "verified" || x?.status === "rejected", `milestone ${i} verdict`);
  const s = m.scores;
  console.log(`  ${m.status.toUpperCase()}  ${s.code_quality}/${s.design_match}/${s.functionality}/${s.completeness} -> ${s.final_weighted}`);
}
console.log(`\njob ${jobId}: ${JSON.stringify(await getJob(jobId))}`);
