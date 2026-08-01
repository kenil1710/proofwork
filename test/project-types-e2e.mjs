/**
 * Three DIFFERENT project types, end to end, on whatever contract .env.local names.
 *
 * The adaptive evidence gathering claims to work for any project anyone submits.
 * This is the test of that claim: a Solidity DeFi protocol, a full-stack Next.js
 * storefront and a PyTorch training pipeline, each with real requirements and a
 * real public repository, each scored by a real `verify_milestone`.
 *
 *   node project-types-e2e.mjs                 # all three
 *   node project-types-e2e.mjs --only=solidity # one of them
 *   node project-types-e2e.mjs --no-verify     # set them up, score nothing
 *
 * Each verify fetches a repository, runs one LLM prompt on the leader and one
 * evidence re-fetch on every validator. `[TRANSIENT]` is retried — it means
 * GitHub rate-limited a validator, not that the work is bad.
 */
import {
  TEST_DEPOSIT, assertAccepted, getJob, getJobCount, getMilestone, send, waitForState,
} from "./harness.mjs";

const ATTEMPTS = 4;
const DEADLINE_SECONDS = 7 * 24 * 60 * 60;
const STAKE_PCT = 0;

const PROJECTS = [
  {
    key: "solidity",
    label: "Solidity DeFi — constant-product AMM",
    title: "Constant-product AMM core contracts",
    github: "https://github.com/Uniswap/v2-core",
    requirements:
      "Build a constant-product automated market maker. Each pair must hold "
      + "reserves of two ERC20 tokens and price swaps by the x*y=k invariant. "
      + "Liquidity providers mint LP tokens on deposit and burn them to withdraw "
      + "their share. The pair must be protected against reentrancy and must "
      + "accumulate a cumulative price for use as a TWAP oracle. A factory "
      + "deploys pairs deterministically, one per token pair.",
    milestone:
      "Core pair contract: swap, mint and burn with reserves accounting, the "
      + "k-invariant check, reentrancy protection and cumulative price accumulators.",
  },
  {
    key: "nextjs",
    label: "Full-stack Next.js — ecommerce storefront",
    title: "Next.js commerce storefront: catalogue and cart",
    github: "https://github.com/vercel/commerce",
    requirements:
      "Build a production ecommerce storefront in Next.js. Shoppers browse a "
      + "product catalogue, open a product page with variant selection, add items "
      + "to a cart that persists across navigation, and complete checkout. Product "
      + "and cart data come from a headless commerce backend through a typed API "
      + "layer. Pages must server-render for SEO and the cart must update without "
      + "a full page reload.",
    milestone:
      "Product listing and product detail pages with variant selection, plus a "
      + "cart that adds, updates and removes line items and survives navigation.",
  },
  {
    key: "ml",
    label: "Python ML — transformer training pipeline",
    title: "PyTorch training pipeline for a small transformer",
    github: "https://github.com/karpathy/nanoGPT",
    requirements:
      "Deliver a reproducible training pipeline for a small transformer language "
      + "model in PyTorch. It must define the model architecture, load and batch a "
      + "tokenised dataset, run a training loop with checkpointing and evaluation "
      + "on a held-out split, and support sampling from a trained checkpoint. "
      + "Hyperparameters must live in configuration rather than being hard-coded, "
      + "and a run must be reproducible from a fixed seed.",
    milestone:
      "Model definition and the training loop: batching from the tokenised "
      + "dataset, loss evaluation on a held-out split, checkpointing, and "
      + "configurable hyperparameters.",
  },
];

const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const chosen = only ? PROJECTS.filter((p) => p.key === only) : PROJECTS;
const results = [];

for (const project of chosen) {
  console.log(`\n${"═".repeat(78)}\n${project.label}\n${"═".repeat(78)}`);

  // Ids are dense and 0-based, so the new job takes the pre-write count.
  const jobId = await getJobCount();
  console.log(`create_job    -> job ${jobId}  (${project.github})`);
  assertAccepted(await send("client", "create_job",
    [project.title, project.requirements, project.milestone, "100",
     DEADLINE_SECONDS, STAKE_PCT], TEST_DEPOSIT), "create_job");
  await waitForState(() => getJob(jobId), (j) => j?.status === "open", "job open");

  const job = await getJob(jobId);
  console.log("accept_job");
  assertAccepted(await send("freelancer", "accept_job", [jobId],
    BigInt(job.required_stake ?? 0)), "accept_job");
  await waitForState(() => getJob(jobId), (j) => j?.status === "in_progress",
    "job in_progress");

  console.log("submit_milestone");
  // Repository only: no deployed site and no mockup, so the weights are
  // code 50 / completeness 50 and the score is entirely about the code.
  assertAccepted(await send("freelancer", "submit_milestone",
    [jobId, 0, project.github, "none", "none"]), "submit_milestone");
  await waitForState(() => getMilestone(jobId, 0), (m) => m?.status === "submitted",
    "milestone submitted");

  if (process.argv.includes("--no-verify")) {
    results.push({ project, jobId, milestone: null });
    continue;
  }

  let milestone = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    process.stdout.write(`verify_milestone (attempt ${attempt}/${ATTEMPTS})… `);
    const started = Date.now();
    const sent = await send("client", "verify_milestone", [jobId, 0]);
    const seconds = Math.round((Date.now() - started) / 1000);

    if (!sent.reverted) {
      console.log(`settled in ${seconds}s`);
      milestone = await waitForState(() => getMilestone(jobId, 0),
        (m) => m?.status === "verified" || m?.status === "rejected", "verdict");
      break;
    }

    console.log(`reverted in ${seconds}s: ${sent.errorMessage}`);
    // Only a transient failure is worth repeating. A deterministic [EXTERNAL]
    // or [EXPECTED] says the same thing however many times it is asked.
    if (!String(sent.errorMessage ?? "").includes("[TRANSIENT]")) break;
  }

  results.push({ project, jobId, milestone });

  if (milestone) {
    const s = milestone.scores ?? {};
    console.log(`\n  verdict  ${milestone.status.toUpperCase()}`);
    for (const [axis, weight] of [["code_quality", 50], ["design_match", 0],
                                  ["functionality", 0], ["completeness", 50]]) {
      const value = Number(s[axis]) || 0;
      const bar = "█".repeat(Math.round(value / 4)).padEnd(25, "·");
      const note = weight === 0 ? "  (zero weight — repository only)" : `  @ ${weight}%`;
      console.log(`  ${axis.padEnd(13)} ${String(s[axis] ?? "-").padStart(3)}  ${bar}${note}`);
    }
    console.log(`  ${"FINAL".padEnd(13)} ${String(s.final_weighted ?? "-").padStart(3)}`
      + `   (pass threshold 70)`);
    console.log(`\n  reasoning (${(milestone.reasoning ?? "").length} chars):`);
    for (const line of wrap(milestone.reasoning || "(none returned)", 74)) {
      console.log(`    ${line}`);
    }
  }
}

function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if ((line + " " + word).trim().length > width) { out.push(line.trim()); line = word; }
    else line += " " + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

console.log(`\n${"═".repeat(78)}\nSUMMARY\n${"═".repeat(78)}`);
for (const { project, jobId, milestone } of results) {
  const s = milestone?.scores ?? {};
  console.log(`  job ${String(jobId).padStart(2)}  ${project.key.padEnd(9)}`
    + `${(milestone?.status ?? "not verified").padEnd(10)}`
    + `code ${String(s.code_quality ?? "-").padStart(3)}  `
    + `comp ${String(s.completeness ?? "-").padStart(3)}  `
    + `FINAL ${String(s.final_weighted ?? "-").padStart(3)}`);
}
