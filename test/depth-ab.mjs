/**
 * Quick review versus deep review, on the SAME repository.
 *
 * Two jobs identical in every respect but `review_depth`, submitted with the
 * same URL and scored by the same contract. Anything that differs in the
 * verdicts is attributable to the depth and to nothing else — which is why the
 * requirements, the milestone text and the deposit are shared constants rather
 * than being written out twice.
 *
 *   node depth-ab.mjs                  # both, then compare
 *   node depth-ab.mjs --only=deep      # one of them
 *   node depth-ab.mjs --repo=uniswap   # a different subject
 *
 * The comparison is printed at the end: evidence size, files, scores, and how
 * long each verification took to settle.
 */
import {
  TEST_DEPOSIT, assertAccepted, getJob, getJobCount, getMilestone, send, waitForState,
} from "./harness.mjs";

const ATTEMPTS = 4;
const DEADLINE_SECONDS = 7 * 24 * 60 * 60;
const STAKE_PCT = 0;

const SUBJECTS = {
  commerce: {
    label: "vercel/commerce — 65 source files, Next.js storefront",
    github: "https://github.com/vercel/commerce",
    title: "Next.js commerce storefront: catalogue and cart",
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
  uniswap: {
    label: "Uniswap/v2-core — 11 source files, Solidity AMM",
    github: "https://github.com/Uniswap/v2-core",
    title: "Constant-product AMM core contracts",
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
};

const repoArg = process.argv.find((a) => a.startsWith("--repo="))?.split("=")[1];
const subject = SUBJECTS[repoArg ?? "commerce"];
if (!subject) {
  throw new Error(`unknown --repo=${repoArg}; expected ${Object.keys(SUBJECTS).join(" | ")}`);
}

const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const depths = only ? [only] : ["quick", "deep"];
const results = [];

console.log(`subject: ${subject.label}\n${subject.github}`);

for (const depth of depths) {
  console.log(`\n${"═".repeat(78)}\n${depth.toUpperCase()} REVIEW\n${"═".repeat(78)}`);

  const jobId = await getJobCount();
  console.log(`create_job    -> job ${jobId}  review_depth="${depth}"`);
  assertAccepted(await send("client", "create_job",
    [`${subject.title} (${depth})`, subject.requirements, subject.milestone, "100",
     DEADLINE_SECONDS, STAKE_PCT, depth], TEST_DEPOSIT), "create_job");
  await waitForState(() => getJob(jobId), (j) => j?.status === "open", "job open");

  const job = await getJob(jobId);
  // The whole experiment rests on this: if the field did not round-trip, the
  // two runs are the same run and any difference below is noise.
  if (job.review_depth !== depth) {
    throw new Error(
      `job ${jobId} stored review_depth="${job.review_depth}", expected "${depth}" — `
      + `the A/B is invalid, stop and fix the round-trip`,
    );
  }
  console.log(`get_job       -> review_depth="${job.review_depth}" (round-tripped)`);

  console.log("accept_job");
  assertAccepted(await send("freelancer", "accept_job", [jobId],
    BigInt(job.required_stake ?? 0)), "accept_job");
  await waitForState(() => getJob(jobId), (j) => j?.status === "in_progress",
    "job in_progress");

  console.log("submit_milestone");
  assertAccepted(await send("freelancer", "submit_milestone",
    [jobId, 0, subject.github, "none", "none"]), "submit_milestone");
  await waitForState(() => getMilestone(jobId, 0), (m) => m?.status === "submitted",
    "milestone submitted");

  if (process.argv.includes("--no-verify")) {
    results.push({ depth, jobId, milestone: null, seconds: 0 });
    continue;
  }

  let milestone = null;
  let seconds = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    process.stdout.write(`verify_milestone (attempt ${attempt}/${ATTEMPTS})… `);
    const started = Date.now();
    const sent = await send("client", "verify_milestone", [jobId, 0]);
    seconds = Math.round((Date.now() - started) / 1000);

    if (!sent.reverted) {
      console.log(`settled in ${seconds}s`);
      milestone = await waitForState(() => getMilestone(jobId, 0),
        (m) => m?.status === "verified" || m?.status === "rejected", "verdict");
      break;
    }
    console.log(`reverted in ${seconds}s: ${sent.errorMessage}`);
    if (!String(sent.errorMessage ?? "").includes("[TRANSIENT]")) break;
  }

  results.push({ depth, jobId, milestone, seconds });

  if (milestone) {
    const s = milestone.scores ?? {};
    console.log(`\n  verdict   ${milestone.status.toUpperCase()}   final ${s.final_weighted}`
      + `   (code ${s.code_quality} @50%, completeness ${s.completeness} @50%)`);
    console.log(`  reasoning ${(milestone.reasoning ?? "").length} chars`);
    console.log("");
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

/** Files a review cited, so "read more" can be checked rather than asserted. */
const ROOT_FILES = new Set(["README.md", "package.json", "requirements.txt"]);

function citedFiles(reasoning) {
  const hits = String(reasoning ?? "").match(
    /[\w./[\]-]+\.(?:tsx?|jsx?|sol|py|md|json)\b/g,
  ) ?? [];
  return [
    ...new Set(
      hits
        .map((hit) => hit.replace(/^[./]+/, ""))
        // "Next.js" and "Node.js" match the extension pattern and are not
        // files. Anything without a directory has to be a known root file.
        .filter((hit) => hit.includes("/") || ROOT_FILES.has(hit)),
    ),
  ].sort();
}

console.log(`\n${"═".repeat(78)}\nCOMPARISON — ${subject.github}\n${"═".repeat(78)}`);
const table = results.map(({ depth, jobId, milestone, seconds }) => {
  const s = milestone?.scores ?? {};
  const cited = citedFiles(milestone?.reasoning);
  return {
    depth,
    jobId,
    status: milestone?.status ?? "not verified",
    code: s.code_quality ?? "-",
    comp: s.completeness ?? "-",
    final: s.final_weighted ?? "-",
    chars: (milestone?.reasoning ?? "").length,
    cited: cited.length,
    files: cited,
    seconds,
  };
});

console.log(
  "  depth  job  status    code  comp  FINAL  reasoning  files cited  settled",
);
for (const row of table) {
  console.log(
    `  ${row.depth.padEnd(6)} ${String(row.jobId).padStart(3)}  `
    + `${String(row.status).padEnd(9)} ${String(row.code).padStart(4)}  `
    + `${String(row.comp).padStart(4)}  ${String(row.final).padStart(5)}  `
    + `${String(row.chars).padStart(6)} ch  ${String(row.cited).padStart(11)}  `
    + `${String(row.seconds).padStart(5)}s`,
  );
}

if (table.length === 2) {
  const [q, d] = table;
  const onlyDeep = d.files.filter((f) => !q.files.includes(f));
  const onlyQuick = q.files.filter((f) => !d.files.includes(f));
  console.log(`\n  cited only by DEEP  (${onlyDeep.length}): ${onlyDeep.join(", ") || "(none)"}`);
  console.log(`  cited only by QUICK (${onlyQuick.length}): ${onlyQuick.join(", ") || "(none)"}`);
  // Signed, because the direction is the finding: deep reading the same work
  // DOWN is as interesting a result as reading it up, and an unsigned number
  // hides which happened.
  const signed = (value) => (Number(value) > 0 ? `+${value}` : String(value));
  console.log(`\n  score delta   final ${signed(Number(d.final) - Number(q.final))}`
    + `   code ${signed(Number(d.code) - Number(q.code))}`
    + `   completeness ${signed(Number(d.comp) - Number(q.comp))}`);
  console.log(`  cost delta    reasoning ${signed(d.chars - q.chars)} chars`
    + `   settle time ${signed(d.seconds - q.seconds)}s`
    + ` (${q.seconds ? (d.seconds / q.seconds).toFixed(1) : "?"}x)`);
}
