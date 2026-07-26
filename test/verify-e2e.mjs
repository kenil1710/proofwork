/**
 * End-to-end AI verification run against the deployed contract.
 *
 * Usage: node verify-e2e.mjs <jobId> <milestoneId> [role]
 *
 * Separate from run.mjs because this is the slow path: `verify_milestone`
 * renders pages, screenshots them, and runs up to four LLM prompts on every
 * validator, so it is measured in minutes and costs real testnet GEN.
 */
import { createClient } from "genlayer-js";
import {
  CLIENT,
  FREELANCER,
  chain,
  getContractBalance,
  getJob,
  getMilestone,
  send,
  waitForState,
} from "./harness.mjs";

const jobId = Number(process.argv[2] ?? 1);
const milestoneId = Number(process.argv[3] ?? 0);
const role = process.argv[4] ?? "client";

const GEN = 10n ** 18n;
const fmt = (b) => {
  const f = (b % GEN).toString().padStart(18, "0").replace(/0+$/, "");
  return f ? `${b / GEN}.${f}` : `${b / GEN}`;
};

const chainClient = createClient({ chain });
const balances = async () => ({
  client: await chainClient.getBalance({ address: CLIENT }),
  freelancer: await chainClient.getBalance({ address: FREELANCER }),
  contract: await getContractBalance(),
});

console.log(`=== verify_milestone(${jobId}, ${milestoneId}) as ${role} ===\n`);

const jobBefore = await getJob(jobId);
const msBefore = await getMilestone(jobId, milestoneId);
const balBefore = await balances();

console.log("BEFORE");
console.log(`  job.status              ${jobBefore.status}`);
console.log(`  job.completed_milestones ${jobBefore.completed_milestones}/${jobBefore.milestone_count}`);
console.log(`  job.total_amount        ${fmt(BigInt(jobBefore.total_amount))} GEN`);
console.log(`  milestone.status        ${msBefore.status}  (${msBefore.percentage}%)`);
console.log(`  evidence                gh=${msBefore.github_url} site=${msBefore.site_url} mockup=${msBefore.mockup_url}`);
console.log(`  balances                contract=${fmt(balBefore.contract)} freelancer=${fmt(balBefore.freelancer)}`);

// Which criteria will actually run, mirroring the contract's weight table.
const has = (u) => u !== "" && u !== "none";
const [code, site, mockup] = [has(msBefore.github_url), has(msBefore.site_url), has(msBefore.mockup_url)];
const weights =
  code && site && mockup ? { code: 25, design: 25, func: 25, comp: 25 }
  : code && site ? { code: 35, design: 0, func: 35, comp: 30 }
  : code ? { code: 50, design: 0, func: 0, comp: 50 }
  : site ? (mockup ? { code: 0, design: 30, func: 40, comp: 30 } : { code: 0, design: 0, func: 50, comp: 50 })
  : { code: 0, design: 0, func: 0, comp: 0 };
console.log(`  expected weights        code=${weights.code} design=${weights.design} func=${weights.func} comp=${weights.comp}`);

const startedAt = Date.now();
console.log(`\nSending verify_milestone…`);
const result = await send(role, "verify_milestone", [jobId, milestoneId]);
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

console.log(`\nTRANSACTION  ${result.hash}`);
console.log(`  settled in    ${elapsed}s with ${result.nudges} nudge(s)`);
console.log(`  reverted      ${result.reverted}`);
if (result.reverted) {
  console.log(`  error         ${result.errorMessage}`);
  console.log(`\nFAILED — the call reverted, no scores were written.`);
  process.exit(1);
}

// Reads lag accepted writes, so poll rather than reading once.
console.log(`\nWaiting for the verdict to become readable…`);
const msAfter = await waitForState(
  () => getMilestone(jobId, milestoneId),
  (m) => m.status !== "submitted",
  "the milestone to leave 'submitted'",
  { timeoutMs: 180_000, intervalMs: 5_000 },
);
const jobAfter = await getJob(jobId);
const balAfter = await balances();

console.log(`\nSCORES (on chain)`);
const s = msAfter.scores;
const line = (label, score, weight) =>
  console.log(
    `  ${label.padEnd(14)} ${String(score).padStart(3)}   weight ${String(weight).padStart(3)}%   ` +
      `contributes ${((score * weight) / 100).toFixed(1)}` +
      (weight === 0 ? "   (not assessed)" : ""),
  );
line("code_quality", s.code_quality, weights.code);
line("design_match", s.design_match, weights.design);
line("functionality", s.functionality, weights.func);
line("completeness", s.completeness, weights.comp);
console.log(`  ${"final_weighted".padEnd(14)} ${String(s.final_weighted).padStart(3)}`);

const recomputed = Math.floor(
  (s.code_quality * weights.code + s.design_match * weights.design +
    s.functionality * weights.func + s.completeness * weights.comp) / 100,
);
console.log(`  recomputed locally ${recomputed} — ${recomputed === s.final_weighted ? "MATCHES" : "MISMATCH!"}`);

console.log(`\nSTATE TRANSITIONS`);
console.log(`  milestone.status         ${msBefore.status} -> ${msAfter.status}`);
console.log(`  job.completed_milestones ${jobBefore.completed_milestones} -> ${jobAfter.completed_milestones}`);
console.log(`  job.status               ${jobBefore.status} -> ${jobAfter.status}`);

// Payout, mirroring verify_milestone's divide-before-multiply exactly.
const total = BigInt(jobAfter.total_amount);
const share = (total / 100n) * BigInt(msAfter.percentage);
const final = s.final_weighted;
const expectedPayout =
  final >= 90 ? share : final >= 80 ? (share / 100n) * 80n : final >= 70 ? (share / 100n) * 70n : 0n;

console.log(`\nPAYOUT`);
console.log(`  milestone share    ${fmt(share)} GEN (${msAfter.percentage}% of escrow)`);
console.log(`  expected payout    ${fmt(expectedPayout)} GEN  (final=${final})`);
console.log(`  balances now       contract=${fmt(balAfter.contract)} freelancer=${fmt(balAfter.freelancer)}`);
console.log(`  contract delta     ${fmt(balAfter.contract - balBefore.contract)} GEN`);
console.log(`  freelancer delta   ${fmt(balAfter.freelancer - balBefore.freelancer)} GEN`);

if (expectedPayout > 0n) {
  console.log(`\n  NOTE: transfers to wallets are external messages that apply on`);
  console.log(`  FINALIZATION, not acceptance — a zero delta here is expected.`);
  console.log(`  Inspect the tx's emitted messages to confirm the transfer was queued.`);
  const tx = await chainClient.getTransaction({ hash: result.hash });
  console.log(`  tx.messages: ${JSON.stringify(tx?.messages ?? null)}`);
} else {
  console.log(`\n  Scored below 70 — the contract emits no transfer on this path.`);
}

console.log(`\n=== done ===`);
