/**
 * Establishes what clock a GenLayer contract can actually read.
 *
 * `gl.message` carries no timestamp — only contract/sender/origin address,
 * value and chain_id. The one time-like field is `gl.message_raw['datetime']`,
 * documented merely as "Transaction datetime". Before a deadline feature can
 * be built on it we need to know: does it exist at runtime, what format is it,
 * and does a write path see a sane value.
 */
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { DECIDED_STATES, transactionsStatusNumberToName } from "genlayer-js/types";
import { readFileSync } from "node:fs";

const code = readFileSync(new URL("../contracts/_probe_time.py", import.meta.url), "utf8");
const acc = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const read = createClient({ chain: testnetBradbury });
const wallet = createClient({ chain: testnetBradbury, account: createAccount(acc.client.key) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(hash, what) {
  const started = Date.now();
  let lastNudge = Date.now();
  let nudges = 0;
  for (;;) {
    const tx = await read.getTransaction({ hash }).catch(() => null);
    const status = transactionsStatusNumberToName[tx?.status];
    if (status && DECIDED_STATES.includes(status)) {
      console.log(
        `  ${what}: ${status} / ${tx?.txExecutionResultName} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      return tx;
    }
    if (Date.now() - lastNudge >= 45_000 && nudges < 10) {
      nudges++;
      lastNudge = Date.now();
      await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
    }
    if (Date.now() - started > 900_000) throw new Error(`${what} never settled`);
    await sleep(5_000);
  }
}

console.log("deploying probe…");
const hash = await wallet.deployContract({ code, args: [] });
const tx = await settle(hash, "deploy");
const address = tx?.to_address ?? tx?.recipient;
console.log(`probe at ${address}\n`);

const view = await read.readContract({ address, functionName: "probe_view", args: [] });
console.log("probe_view() ->", view);
const parsed = JSON.parse(view);
console.log("\n  message_raw keys:", parsed.keys.join(", "));
console.log("  datetime present:", parsed.has_datetime);
console.log("  datetime value  :", JSON.stringify(parsed.datetime));

// A write path is where a deadline check would actually run.
console.log("\ncalling probe_write…");
const wHash = await wallet.writeContract({ address, functionName: "probe_write", args: [], value: 0n });
await settle(wHash, "probe_write");
const seen = await read.readContract({ address, functionName: "get_seen", args: [] });
console.log("get_seen() ->", seen);

const dt = JSON.parse(seen).seen;
console.log(`\n  write path saw: ${JSON.stringify(dt)}`);
if (dt) {
  const asDate = new Date(dt);
  console.log(`  Date.parse -> ${asDate.toISOString()} (valid: ${!isNaN(asDate)})`);
  console.log(`  epoch seconds -> ${Math.floor(asDate.getTime() / 1000)}`);
  console.log(`  wall clock now -> ${Math.floor(Date.now() / 1000)}`);
  console.log(`  skew (s) -> ${Math.floor(Date.now() / 1000) - Math.floor(asDate.getTime() / 1000)}`);
}
