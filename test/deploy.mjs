/**
 * Deploys contracts/proof_work.py and rewrites frontend/.env.local.
 *
 * Uses the SDK rather than `genlayer deploy` because the CLI has no nudge
 * logic: Bradbury deploys park in COMMITTING and the CLI just times out, even
 * though the deploy is fine and only needs `finalizeIdlenessTxs` to proceed.
 *
 * Deploys from the `client` test account — the contract has no owner concept,
 * so the deployer is not privileged. Studionet is gasless, so a 0 GEN balance
 * there is expected and deploys anyway.
 *
 * Usage: node deploy.mjs [--network=studionet|bradbury] [--write-env]
 *
 * Defaults to studionet: it settles in seconds, where Bradbury takes minutes.
 * Pass --network=bradbury for the submission deploy.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet, testnetBradbury } from "genlayer-js/chains";
import { DECIDED_STATES, transactionsStatusNumberToName } from "genlayer-js/types";
import { readFileSync, writeFileSync } from "node:fs";

const CHAINS = { studionet, bradbury: testnetBradbury };

const WRITE_ENV = process.argv.includes("--write-env");
const networkArg = process.argv.find((a) => a.startsWith("--network="));
const networkName = networkArg ? networkArg.split("=")[1] : "studionet";
const chain = CHAINS[networkName];
if (!chain) {
  throw new Error(`unknown --network=${networkName}; expected one of ${Object.keys(CHAINS).join(", ")}`);
}

const codePath = new URL("../contracts/proof_work.py", import.meta.url);
const envPath = new URL("../frontend/.env.local", import.meta.url);

const acc = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const read = createClient({ chain });
const wallet = createClient({ chain, account: createAccount(acc.client.key) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Studio settles on its own; the idleness nudge is a Bradbury-only workaround
 * and there is no idle queue on Studio to nudge. Poll faster and give up sooner
 * there, so a genuine failure surfaces in seconds instead of 20 minutes.
 */
const NUDGE = !chain.isStudio;
const POLL_MS = chain.isStudio ? 1_000 : 5_000;
const DEADLINE_MS = chain.isStudio ? 120_000 : 1_200_000;

console.log(`network: ${chain.name} (id ${chain.id}) via ${chain.rpcUrls.default.http[0]}`);

const code = readFileSync(codePath, "utf8");
console.log(`deploying ${code.length} bytes from ${acc.client.address}`);

let hash;
for (let attempt = 1; ; attempt++) {
  try {
    hash = await wallet.deployContract({ code, args: [] });
    break;
  } catch (e) {
    if (attempt >= 4) throw e;
    console.log(`  submit attempt ${attempt} rejected, retrying: ${e.message.slice(0, 100)}`);
    await sleep(15_000 * attempt);
  }
}
console.log(`deploy tx ${hash}`);

const started = Date.now();
let lastNudge = Date.now();
let nudges = 0;
let tx;
for (;;) {
  tx = await read.getTransaction({ hash }).catch(() => null);
  const status = transactionsStatusNumberToName[tx?.status];
  if (status && DECIDED_STATES.includes(status)) {
    console.log(`  ${status} / ${tx?.txExecutionResultName} after ${((Date.now() - started) / 1000).toFixed(0)}s, ${nudges} nudge(s)`);
    if (status !== "ACCEPTED" && status !== "FINALIZED") throw new Error(`deploy settled as ${status}`);
    if (tx?.txExecutionResultName === "FINISHED_WITH_ERROR") throw new Error("deploy reverted");
    break;
  }
  if (NUDGE && Date.now() - lastNudge >= 45_000 && nudges < 10) {
    nudges++;
    lastNudge = Date.now();
    console.log(`  nudge ${nudges} (status ${status})`);
    await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
  }
  if (Date.now() - started > DEADLINE_MS) throw new Error("deploy never settled");
  await sleep(POLL_MS);
}

const address = tx?.to_address ?? tx?.recipient;
if (!address) throw new Error(`could not read deployed address from tx: ${JSON.stringify(Object.keys(tx ?? {}))}`);
console.log(`\ncontract address: ${address}`);

// Sanity: the new contract must answer a view call before we point anything at it.
const count = await read.readContract({ address, functionName: "get_job_count", args: [] });
console.log(`get_job_count() -> ${count}  (a fresh deploy should read 0)`);

if (WRITE_ENV) {
  const env = readFileSync(envPath, "utf8");
  const updated = env.replace(
    /^NEXT_PUBLIC_CONTRACT_ADDRESS\s*=.*$/m,
    `NEXT_PUBLIC_CONTRACT_ADDRESS=${address}`,
  );
  if (updated === env) throw new Error("NEXT_PUBLIC_CONTRACT_ADDRESS not found in .env.local");
  writeFileSync(envPath, updated);
  console.log(`wrote ${address} to frontend/.env.local`);
} else {
  console.log(`(re-run with --write-env to update frontend/.env.local)`);
}
