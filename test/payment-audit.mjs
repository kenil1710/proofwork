/**
 * Confirms the GM Striker milestone payment from Studio's transfer log.
 *
 * `eth_getBalance` on Studio ignores the block tag (latest, 0x1 and earliest all
 * return the same number), so a historical "before" cannot be read back after
 * the fact. The transfer records can — and they are the stronger evidence
 * anyway: they name sender, recipient and amount rather than a bare delta.
 *
 * A "before" is therefore *derived* — current balance minus the credits that
 * landed after it — and only transfers whose counterparty is the contract count
 * as payout. The `sim_fundAccount` mints that seeded the account are separate,
 * and folding them in is what makes a naive reconciliation read 0.
 *
 *   node payment-audit.mjs                        # job 0, milestone 0
 *   node payment-audit.mjs --job=2 --milestone=1
 *
 * Read-only: it sends no transaction and costs nothing to re-run.
 */
import { CLIENT, FREELANCER, CONTRACT_ADDRESS, getJob, getMilestone,
         getReputation, getContractBalance } from "./harness.mjs";

const RPC = "https://studio.genlayer.com/api";
const GEN = 10n ** 18n;
const fmt = (b) => { const f=(b%GEN).toString().padStart(18,"0").replace(/0+$/,""); return f?`${b/GEN}.${f}`:`${b/GEN}`; };
const isC = (a,b) => a?.toLowerCase() === b?.toLowerCase();

async function rpc(method, params) {
  const r = await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",method,params,id:1})});
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}

const arg = (name, fallback) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const JOB = arg("job", 0);
const MS = arg("milestone", 0);
let pass = 0, fail = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const job = await getJob(JOB);
const ms = await getMilestone(JOB, MS);
const flTxs = await rpc("sim_getTransactionsForAddress", [FREELANCER]);
const ctTxs = await rpc("sim_getTransactionsForAddress", [CONTRACT_ADDRESS]);

// The payout: a value transfer from the contract to the freelancer.
const payouts = flTxs.filter(t => BigInt(t.value??0) > 0n && isC(t.to_address, FREELANCER)
                                  && isC(t.from_address, CONTRACT_ADDRESS));
const paid = payouts.reduce((s,t)=>s+BigInt(t.value), 0n);
const funding = flTxs.filter(t => BigInt(t.value??0) > 0n && isC(t.to_address, FREELANCER)
                                  && !isC(t.from_address, CONTRACT_ADDRESS))
                     .reduce((s,t)=>s+BigInt(t.value), 0n);
const nowFl = BigInt(await rpc("eth_getBalance",[FREELANCER,"latest"]));

// Expected payout, recomputed from the contract's own rules.
const total = BigInt(job.total_amount);
const share = (total / 100n) * BigInt(ms.percentage);
const f = ms.scores.final_weighted;
const expected = f >= 90 ? share : f >= 80 ? (share/100n)*80n : f >= 70 ? (share/100n)*70n : 0n;

console.log(`GM STRIKER PAYMENT AUDIT — job ${JOB}, milestone ${MS}`);
console.log(`contract ${CONTRACT_ADDRESS}\n`);
console.log(`score ${f} -> band ${f>=90?"90-100 = 100%":f>=80?"80-89 = 80%":f>=70?"70-79 = 70%":"<70 = rejected"}`);
console.log(`escrow ${fmt(total)} GEN x ${ms.percentage}% milestone = ${fmt(share)} GEN share`);
console.log(`expected payout ${fmt(expected)} GEN\n`);

console.log(`1. FREELANCER WALLET BALANCE`);
console.log(`     funded (sim_fundAccount)  ${fmt(funding)} GEN`);
for (const p of payouts) console.log(`     payout ${p.created_at.slice(0,19)}  +${fmt(BigInt(p.value))} GEN  ${p.status}  credited=${p.value_credited}`);
console.log(`     ── before payout          ${fmt(nowFl - paid)} GEN`);
console.log(`     ── after  payout          ${fmt(nowFl)} GEN`);
console.log(`     ── delta                  +${fmt(paid)} GEN`);
check(paid === expected, `freelancer credited exactly the expected payout`,
      `+${fmt(paid)} GEN received vs ${fmt(expected)} GEN expected`);
check(payouts.every(p=>p.value_credited===true && p.status==="FINALIZED"),
      `transfer FINALIZED and value_credited`,
      payouts.map(p=>`${p.hash.slice(0,18)}… ${p.status} credited=${p.value_credited}`).join("\n          "));

console.log(`\n2. CONTRACT BALANCE`);
const deposits = ctTxs.filter(t=>BigInt(t.value??0)>0n && isC(t.to_address,CONTRACT_ADDRESS)).reduce((s,t)=>s+BigInt(t.value),0n);
const outflows = ctTxs.filter(t=>BigInt(t.value??0)>0n && isC(t.from_address,CONTRACT_ADDRESS)).reduce((s,t)=>s+BigInt(t.value),0n);
const nowCt = await getContractBalance();
console.log(`     deposits in (create_job)  ${fmt(deposits)} GEN`);
console.log(`     transfers out             ${fmt(outflows)} GEN`);
console.log(`     ── before payout          ${fmt(nowCt + outflows)} GEN`);
console.log(`     ── after  payout          ${fmt(nowCt)} GEN`);
console.log(`     ── delta                  -${fmt(outflows)} GEN`);
check(outflows === expected, `contract balance decreased by exactly the payout`,
      `-${fmt(outflows)} GEN out vs ${fmt(expected)} GEN expected`);
check(nowCt === deposits - outflows, `contract balance reconciles (in − out)`,
      `${fmt(nowCt)} == ${fmt(deposits)} − ${fmt(outflows)}`);
check(BigInt(job.paid_out) === paid, `contract's paid_out matches GEN actually moved`,
      `paid_out=${fmt(BigInt(job.paid_out))} GEN, transferred=${fmt(paid)} GEN`);

console.log(`\n3. MILESTONE STATUS`);
check(ms.status === "verified", `milestone status is "verified"`, `got "${ms.status}", scores ${ms.scores.code_quality}/${ms.scores.design_match}/${ms.scores.functionality}/${ms.scores.completeness} -> ${f}`);

console.log(`\n4. JOB STATUS`);
check(job.status === "completed", `job status is "completed"`, `got "${job.status}"`);
check(Number(job.completed_milestones) === Number(job.milestone_count),
      `all milestones completed`, `${job.completed_milestones}/${job.milestone_count}`);

console.log(`\n5. REPUTATION`);
const rep = await getReputation(FREELANCER);
console.log(`     ${JSON.stringify(rep)}`);
check(rep.jobs_completed >= 1, `jobs_completed recorded`, `jobs_completed=${rep.jobs_completed}`);
check(rep.scores.includes(f), `this milestone's score is in the history`, `scores=[${rep.scores}] contains ${f}`);
check(rep.avg_score === f, `avg_score matches`, `avg=${rep.avg_score}`);
check(isC(rep.address, FREELANCER), `reputation is keyed to the freelancer`, rep.address);

// The transfer must descend from verify_milestone, not from a cancel/refund path.
console.log(`\nTRIGGER`);
for (const p of payouts) {
  const trig = p.triggered_by ? await rpc("eth_getTransactionByHash",[p.triggered_by]) : null;
  let method = "?";
  // Calldata is msgpack-ish: the method name trails a "method" key separated by
  // a couple of non-printable length bytes, so the gap must be skipped, not
  // assumed to be one character.
  try {
    method = Buffer.from(trig.data.calldata, "base64").toString("latin1")
      .match(/method[^\x20-\x7e]*([a-z_]{4,})/)?.[1] ?? "?";
  } catch {}
  console.log(`     payout  ${p.hash}`);
  console.log(`     triggered_by ${p.triggered_by} -> ${method}  from ${isC(trig?.from_address,CLIENT)?"CLIENT":trig?.from_address}`);
  check(method === "verify_milestone", `payout was triggered by verify_milestone`,
        `method="${method}", leader ${trig?.consensus_data?.leader_receipt?.[0]?.execution_result}, ${trig?.status}`);
  check((trig?.triggered_transactions ?? []).includes(p.hash),
        `verify_milestone lists this transfer as its own child`,
        `triggered_transactions=${JSON.stringify(trig?.triggered_transactions)}`);
}

console.log(`\n${"─".repeat(60)}\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES PRESENT"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
