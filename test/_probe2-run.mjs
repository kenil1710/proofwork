import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { DECIDED_STATES, transactionsStatusNumberToName } from "genlayer-js/types";
import { readFileSync } from "node:fs";

const ADDRESS = process.argv[2];
const acc = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const read = createClient({ chain: testnetBradbury });
const wallet = createClient({ chain: testnetBradbury, account: createAccount(acc.client.key) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(fn) {
  process.stdout.write(`\n${fn}: `);
  let hash;
  for (let a = 1; ; a++) {
    try {
      hash = await wallet.writeContract({ address: ADDRESS, functionName: fn, args: [], value: 0n });
      break;
    } catch (e) {
      if (a >= 5) { console.log("SUBMIT FAILED:", e.message.slice(0, 120)); return "SUBMIT_FAILED"; }
      process.stdout.write(`retry${a} `);
      await sleep(15_000 * a);
    }
  }
  const started = Date.now();
  let lastNudge = Date.now(), nudges = 0;
  for (;;) {
    const tx = await read.getTransaction({ hash }).catch(() => null);
    const st = transactionsStatusNumberToName[tx?.status];
    if (st && DECIDED_STATES.includes(st)) {
      const exec = tx?.txExecutionResultName;
      console.log(`${st}/${exec} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
      const t = await read.debugTraceTransaction({ hash }).catch(() => null);
      console.log(`    run_time=${t?.run_time} eq_outputs=${JSON.stringify(t?.eq_outputs ?? [])}`);
      console.log(`    stderr=${JSON.stringify((t?.stderr ?? "").slice(0, 160))}`);
      return exec;
    }
    if (Date.now() - lastNudge >= 45_000 && nudges < 8) {
      nudges++; lastNudge = Date.now(); process.stdout.write(`n${nudges} `);
      await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
    }
    if (Date.now() - started > 900_000) { console.log("TIMEOUT"); return "TIMEOUT"; }
    await sleep(5_000);
  }
}

console.log(`probe2 ${ADDRESS}`);
const results = {};
for (const fn of ["raw_plain_field", "copied_dataclass_raw", "copied_dataclass_str"]) {
  results[fn] = await call(fn);
}
console.log(`\n=== RESULTS ===`);
for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`  get_last: ${await read.readContract({ address: ADDRESS, functionName: "get_last", args: [] }).catch((e) => e.message)}`);
