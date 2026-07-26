/**
 * Deploys probe_consensus.py and runs its three methods, which differ only in
 * validator cost, to find out why verify_milestone never commits.
 *
 * Reads results by polling transaction status directly rather than through the
 * harness, so each variant reports its own round-by-round progression.
 *
 * Do NOT pipe this through `tail` — that buffers everything and you lose the
 * live progression, which is the whole point.
 *
 * Usage: node probe-consensus-run.mjs
 */
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { transactionsStatusNumberToName } from "genlayer-js/types";
import { readFileSync } from "node:fs";

const URL_UNDER_TEST = "https://example.com";
const PER_METHOD_MS = 12 * 60_000;
const NUDGE_AFTER_MS = 60_000;

const acc = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const read = createClient({ chain: testnetBradbury });

// Deliberately the freelancer, not the client. A sender with an unsettled
// transaction in its slot has every new submission reverted by the consensus
// contract before the Intelligent Contract runs — and the client account is
// wedged behind the stuck verify_milestone tx
// (0x9013c470b34ed714ebdca93fc7808b8c9f32e921f9691e3859243c6588bac820,
// APPEAL_COMMITTING). Using the client here reverts every call, which looks
// exactly like a contract bug and is not one.
const ROLE = process.env.PROBE_ROLE ?? "freelancer";
const wallet = createClient({
  chain: testnetBradbury,
  account: createAccount(acc[ROLE].key),
});

// Reuse an already-deployed probe when given one, so a rerun costs 3 txs not 4.
const EXISTING = process.env.PROBE_ADDRESS ?? process.argv[2] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + "\n");

const TERMINAL = new Set(["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"]);

log(`sending from ${ROLE} (${acc[ROLE].address})`);
const code = readFileSync(new URL("./probe_consensus.py", import.meta.url), "utf8");
let deployHash = null;
if (!EXISTING) {
  log(`deploying probe (${code.length} bytes)…`);
  deployHash = await wallet.deployContract({ code, args: [] });
}

async function drive(hash, label) {
  const started = Date.now();
  let lastSeen = "";
  let lastNudge = Date.now();
  let nudges = 0;

  while (Date.now() - started < PER_METHOD_MS) {
    const tx = await read.getTransaction({ hash }).catch(() => null);
    // Lookup object, NOT a function, despite the name — same for
    // executionResultNumberToName and transactionsStatusNameToNumber.
    const status = tx?.statusName ?? transactionsStatusNumberToName[tx?.status] ?? "?";
    const secs = ((Date.now() - started) / 1000).toFixed(0);

    if (status !== lastSeen) {
      const r = tx?.lastRound;
      const votes = r ? ` [round ${r.round} committed=${r.votesCommitted} revealed=${r.votesRevealed}]` : "";
      log(`    ${secs}s ${status}${votes}`);
      lastSeen = status;
    }

    if (TERMINAL.has(status)) {
      return { status, tx, secs, nudges };
    }

    if (Date.now() - lastNudge >= NUDGE_AFTER_MS) {
      nudges += 1;
      lastNudge = Date.now();
      log(`    ${secs}s nudge ${nudges}`);
      await Promise.race([
        wallet.finalizeIdlenessTxs?.().catch(() => {}) ?? Promise.resolve(),
        sleep(30_000),
      ]);
    }
    await sleep(5_000);
  }
  const tx = await read.getTransaction({ hash }).catch(() => null);
  return { status: tx?.statusName ?? "TIMED_OUT", tx, secs: "timeout", nudges };
}

let address = EXISTING;
if (!address) {
  log(`deploy tx ${deployHash}`);
  const dep = await drive(deployHash, "deploy");
  if (!["ACCEPTED", "FINALIZED"].includes(dep.status)) {
    log(`deploy did not settle: ${dep.status}`);
    process.exit(1);
  }
  // Checking statusName alone is not enough: the first probe deploy was
  // ACCEPTED *and* FINISHED_WITH_ERROR, so no contract existed and every
  // later call returned invalid_contract/absent_runner_comment — which reads
  // exactly like a consensus failure and is not one.
  if (dep.tx?.txExecutionResultName !== "FINISHED_WITH_RETURN") {
    log(`deploy executed with error: ${dep.tx?.txExecutionResultName}`);
    process.exit(1);
  }
  address = dep.tx?.txDataDecoded?.contractAddress ?? dep.tx?.recipient;
  log(`probe deployed at ${address}\n`);
} else {
  log(`reusing probe at ${address}\n`);
}

const results = {};
for (const method of ["no_llm", "no_rerun", "with_rerun"]) {
  log(`── ${method} ──`);
  let hash = null;
  for (let attempt = 1; attempt <= 4 && !hash; attempt++) {
    try {
      hash = await wallet.writeContract({
        address,
        functionName: method,
        args: [URL_UNDER_TEST],
        value: 0n,
      });
    } catch (e) {
      // The outer EVM call to the consensus contract, not the contract itself.
      // Happens while this sender still has an unsettled tx in its slot.
      if (attempt === 4) throw e;
      log(`    submit attempt ${attempt} reverted, retrying in ${20 * attempt}s`);
      await sleep(20_000 * attempt);
    }
  }
  log(`    tx ${hash}`);
  const r = await drive(hash, method);
  let stored = "(unread)";
  try {
    stored = String(await read.readContract({ address, functionName: "get_runs", args: [] }));
  } catch (e) {
    stored = `read failed: ${e.message.slice(0, 60)}`;
  }
  results[method] = {
    status: r.status,
    exec: r.tx?.txExecutionResultName,
    eq: (r.tx?.eqBlocksOutputs ?? "").slice(0, 60),
    secs: r.secs,
    nudges: r.nudges,
    stored,
  };
  log(`    => ${r.status} / ${r.tx?.txExecutionResultName} after ${r.secs}s, runs=${stored}, eq=${(r.tx?.eqBlocksOutputs ?? "").slice(0, 40)}\n`);
}

log("=== SUMMARY ===");
for (const [k, v] of Object.entries(results)) {
  log(`${k.padEnd(11)} ${String(v.status).padEnd(18)} exec=${String(v.exec).padEnd(22)} ${v.secs}s runs=${v.stored}`);
}
log(`
Reading it:
  all three settle          -> the network is fine; verify_milestone's problem is its own workload
  no_llm only               -> any LLM call in a nondet block stalls on Bradbury right now
  no_llm + no_rerun settle  -> the rerunning validator is the cause; make validation cheaper
  none settle               -> Bradbury cannot commit heavy nondet txs; not a contract problem`);
