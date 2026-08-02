/**
 * What does gl.nondet.web.render actually return for a given URL?
 *
 * Deploys contracts/render_probe.py, renders one URL in every mode, and prints
 * the length and head of each. The question cannot be answered from outside
 * GenVM: an off-chain fetch sees whatever the server sent, while GenVM drives a
 * real browser.
 *
 *   node render-probe.mjs [url]        # defaults to the GM Striker site
 *
 * Measured 2026-07-30 against gritual-striker.vercel.app, a client-rendered Vite
 * SPA: mode="text" returned 174 characters of HYDRATED page text where a plain
 * GET yields 22, so JavaScript does run. It renders as an anonymous visitor
 * though — no wallet, no clicks — so a wallet-gated dApp shows its connect
 * prompt and its on-chain counters come back as placeholders. mode="html"
 * returned 3324 characters, mostly injected style variables, and is worse
 * evidence for judging a deliverable.
 */
import { readFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { transactionsStatusNumberToName } from "genlayer-js/types";

const acc = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const client = createClient({ chain: studionet, account: createAccount(acc.client.key) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = readFileSync(new URL("../contracts/render_probe.py", import.meta.url));

async function settle(hash, label, timeoutMs = 300000) {
  const started = Date.now();
  for (;;) {
    const tx = await client.getTransaction({ hash });
    const name = transactionsStatusNumberToName[tx?.status] ?? String(tx?.status);
    if (["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"].includes(name)
        || String(name).includes("ERROR")) {
      const lr = tx.consensus_data?.leader_receipt?.[0];
      console.log(`  ${label}: ${name} after ${Math.round((Date.now()-started)/1000)}s`
        + (lr ? ` | exec=${lr.execution_result} status=${lr.result?.status}` : ""));
      if (lr?.result?.status === "rollback") console.log("  payload:", lr.result?.payload);
      return name;
    }
    if (Date.now() - started > timeoutMs) { console.log(`  ${label}: TIMEOUT at ${name}`); return name; }
    await sleep(3000);
  }
}

const deployHash = await client.deployContract({ code, args: [] });
await settle(deployHash, "deploy");
const receipt = await client.getTransaction({ hash: deployHash });
const address = receipt.data?.contract_address ?? receipt.contract_address;
console.log("probe contract:", address);

const url = process.argv[2] ?? "https://gritual-striker.vercel.app/";
console.log("probing:", url);
const h = await client.writeContract({ address, functionName: "probe", args: [url], value: 0n });
await settle(h, "probe");

for (let i = 0; i < 10; i++) {
  const raw = await client.readContract({ address, functionName: "get_result", args: [] });
  if (raw && String(raw).length > 2) { console.log("\nRESULT:\n" + String(raw)); break; }
  await sleep(3000);
}
