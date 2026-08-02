/**
 * Re-verify a milestone until it reaches a verdict, riding out [TRANSIENT].
 *
 * `verify_milestone` fails CLOSED on a rate-limited GitHub listing rather than
 * scoring whatever partial evidence it managed to fetch — see
 * `_fetch_github_code`. That is correct and it is also retryable, which is
 * precisely what this does. Only [TRANSIENT] is retried; a deterministic
 * [EXTERNAL] or [EXPECTED] failure is reported and left alone.
 *
 *   node verify-retry.mjs --job=1 --milestone=0 [--attempts=6] [--waitMs=45000]
 */
import { getMilestone, send, waitForState } from "./harness.mjs";

const arg = (n, d) => Number(process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d);
const job = arg("job", 1), ms = arg("milestone", 0);
const attempts = arg("attempts", 6), waitMs = arg("waitMs", 45000);

for (let i = 1; i <= attempts; i++) {
  process.stdout.write(`attempt ${i}/${attempts} — verify job ${job} milestone ${ms}… `);
  const r = await send("client", "verify_milestone", [job, ms]);
  if (!r.reverted) {
    const m = await waitForState(() => getMilestone(job, ms),
      (x) => x?.status === "verified" || x?.status === "rejected", "verdict");
    const s = m.scores;
    console.log(`\n  ${m.status.toUpperCase()}  code=${s.code_quality} design=${s.design_match} `
      + `func=${s.functionality} comp=${s.completeness} -> FINAL ${s.final_weighted}`);
    console.log(`\n  REASONING (${(m.reasoning ?? "").length} chars):\n  ${m.reasoning || "(none returned)"}`);
    process.exit(0);
  }
  console.log(`reverted: ${r.errorMessage}`);
  if (!String(r.errorMessage).startsWith("[TRANSIENT]")) {
    console.log("  not transient — not retrying.");
    process.exit(1);
  }
  if (i < attempts) await new Promise((res) => setTimeout(res, waitMs));
}
console.log("gave up: still rate-limited after every attempt");
process.exit(1);
