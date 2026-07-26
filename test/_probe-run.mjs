/**
 * Runs both probe methods and reports which reverts.
 * Usage: node _probe-run.mjs <probeAddress>
 */
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { DECIDED_STATES, transactionsStatusNumberToName } from "genlayer-js/types";
import { readFileSync } from "node:fs";

const ADDRESS = process.argv[2];
const accounts = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const read = createClient({ chain: testnetBradbury });
const wallet = createClient({ chain: testnetBradbury, account: createAccount(accounts.client.key) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(fn) {
  process.stdout.write(`\n${fn}: submitting… `);
  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await wallet.writeContract({ address: ADDRESS, functionName: fn, args: [], value: 0n });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      process.stdout.write(`retry(${attempt}) `);
      await sleep(15_000 * attempt);
    }
  }
  process.stdout.write(`${hash.slice(0, 12)}… `);

  const started = Date.now();
  let lastNudge = Date.now();
  let nudges = 0;
  for (;;) {
    const tx = await read.getTransaction({ hash }).catch(() => null);
    const status = transactionsStatusNumberToName[tx?.status];
    if (status && DECIDED_STATES.includes(status)) {
      const exec = tx?.txExecutionResultName;
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`\n  -> ${status} / ${exec} after ${secs}s, ${nudges} nudge(s)`);
      if (exec === "FINISHED_WITH_ERROR") {
        const trace = await read.debugTraceTransaction({ hash }).catch(() => null);
        console.log(`  stderr: ${JSON.stringify(trace?.stderr ?? "")}`);
        console.log(`  run_time: ${trace?.run_time}  eq_outputs: ${JSON.stringify(trace?.eq_outputs ?? [])}`);
      }
      return exec;
    }
    if (Date.now() - lastNudge >= 60_000 && nudges < 6) {
      nudges++;
      lastNudge = Date.now();
      process.stdout.write(`nudge${nudges} `);
      await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
    }
    if (Date.now() - started > 900_000) throw new Error("timeout");
    await sleep(5_000);
  }
}

console.log(`probe ${ADDRESS}`);
const a = await call("run_method_closure");
const b = await call("run_function_closure");

console.log(`\n=== RESULT ===`);
console.log(`  lambda capturing self (method):     ${a}`);
console.log(`  lambda capturing only str (module): ${b}`);
if (a === "FINISHED_WITH_ERROR" && b === "FINISHED_WITH_RETURN") {
  console.log(`  CONFIRMED: capturing self in the nondet lambda is the fault.`);
} else if (a === b) {
  console.log(`  NOT the differentiator — both behaved identically. Look elsewhere.`);
}
try {
  console.log(`  get_last: ${await read.readContract({ address: ADDRESS, functionName: "get_last", args: [] })}`);
} catch (e) {
  console.log(`  get_last failed: ${e.message}`);
}
