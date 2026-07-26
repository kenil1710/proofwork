/**
 * Patiently drives one transaction to a real outcome.
 *
 * Two Bradbury behaviours make the naive wait wrong for heavy calls:
 *
 *  1. LEADER_TIMEOUT is in the SDK's DECIDED_STATES, but it is NOT terminal —
 *     the round rotates to a new leader and the transaction carries on. Treating
 *     it as decided reports failure on a transaction that is still running.
 *     `verify_milestone` hits this routinely because rendering pages, taking
 *     screenshots and running several LLM prompts can outlast a leader's slot.
 *  2. Rounds then park in COMMITTING with zero votes and need nudging.
 *
 * So: only ACCEPTED / FINALIZED / UNDETERMINED / CANCELED end the wait, and
 * LEADER_TIMEOUT / VALIDATORS_TIMEOUT keep going while rotations remain.
 *
 * Usage: node watch-tx.mjs <txHash> [timeoutMinutes]
 */
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { transactionsStatusNumberToName } from "genlayer-js/types";
import { readFileSync } from "node:fs";

const hash = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 30) * 60_000;

const acc = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const read = createClient({ chain: testnetBradbury });
const wallet = createClient({ chain: testnetBradbury, account: createAccount(acc.client.key) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Genuinely terminal — a leader timeout is not among them. */
const TERMINAL = new Set(["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"]);

const started = Date.now();
let lastNudge = Date.now();
let nudges = 0;
let lastReport = "";

console.log(`watching ${hash} for up to ${timeoutMs / 60_000} min`);

for (;;) {
  const tx = await read.getTransaction({ hash }).catch(() => null);
  const status = transactionsStatusNumberToName[tx?.status] ?? tx?.statusName;
  const round = tx?.numOfRounds;
  const rotations = tx?.lastRound?.rotationsLeft;
  const revealed = tx?.lastRound?.votesRevealed;

  const line = `${status} round=${round} rotationsLeft=${rotations} revealed=${revealed}`;
  if (line !== lastReport) {
    console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s  ${line}`);
    lastReport = line;
  }

  if (status && TERMINAL.has(status)) {
    console.log(`\nSETTLED: ${status} / ${tx?.txExecutionResultName}`);
    process.exit(status === "ACCEPTED" || status === "FINALIZED" ? 0 : 1);
  }

  if (Date.now() - lastNudge >= 45_000) {
    nudges++;
    lastNudge = Date.now();
    process.stdout.write(`       nudge ${nudges}… `);
    await wallet
      .finalizeIdlenessTxs({ txIds: [hash] })
      .then(() => console.log("sent"))
      .catch((e) => console.log(`(${e.message.slice(0, 60)})`));
  }

  if (Date.now() - started > timeoutMs) {
    console.log(`\nGAVE UP after ${nudges} nudges — last: ${lastReport}`);
    process.exit(1);
  }
  await sleep(10_000);
}
