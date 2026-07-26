/**
 * Mints GEN to an address on Studionet.
 *
 * You very likely do not need this. Studio does not debit the sender on a
 * payable call — a wallet holding 0 GEN can `create_job` with a real deposit
 * and the escrow still lands (verified: a fresh 0-balance account created a job
 * with a 0.001 GEN deposit; the contract balance rose by exactly that and the
 * sender stayed at 0). Fund an account only when you want a non-zero balance
 * for its own sake, e.g. so the wallet UI looks realistic in a demo.
 *
 * Usage: node fund.mjs <address> [amountGEN]     # default 10 GEN
 *
 * Deliberately self-contained rather than importing harness.mjs: this is the
 * script you reach for *before* test accounts exist, and harness reads
 * .accounts.json at import time.
 */
import { readFileSync } from "node:fs";

const RPC = "https://studio.genlayer.com/api";

const [, , address, amountArg] = process.argv;
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error("Usage: node fund.mjs <0xaddress> [amountGEN]");
  process.exit(1);
}

// `sim_fundAccount` is a Studio method; Bradbury has no such thing and needs
// the real faucet. Read the network from the same place everything else does.
const envText = readFileSync(new URL("../frontend/.env.local", import.meta.url), "utf8");
const network =
  envText.match(/^NEXT_PUBLIC_GENLAYER_NETWORK\s*=\s*(\S+)\s*$/m)?.[1] ?? "studionet";
if (network !== "studionet") {
  console.error(
    `frontend/.env.local points at ${network}, which has no sim_fundAccount.\n` +
      "Use the faucet instead: https://testnet-faucet.genlayer.foundation",
  );
  process.exit(1);
}

const amountGen = amountArg ?? "10";
const wei = BigInt(Math.round(Number(amountGen) * 1e18));

/**
 * The RPC types `amount` as a JSON number, so anything past 2^53 is subject to
 * float rounding. Round GEN figures survive it (1e18 is exactly representable),
 * but say so plainly when a value would not, rather than quietly crediting a
 * different number.
 */
const asNumber = Number(wei);
if (BigInt(asNumber) !== wei) {
  console.warn(
    `note: ${wei} wei is not exactly representable as a JSON number; ` +
      `${BigInt(asNumber)} wei will be credited instead.`,
  );
}

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const balance = async () => BigInt(await rpc("eth_getBalance", [address, "latest"]));
const gen = (v) => `${(Number(v) / 1e18).toFixed(6)} GEN`;

const before = await balance();
console.log(`${address} before: ${gen(before)}`);

// Not `client.fundAccount()` from genlayer-js: that helper hard-codes a
// `chain.id !== localnet.id` guard and throws "Client is not connected to the
// localnet" on Studionet, even though this very RPC serves the method.
const hash = await rpc("sim_fundAccount", [address, asNumber]);
console.log(`sim_fundAccount tx: ${hash}`);

const after = await balance();
console.log(`${address} after:  ${gen(after)}  (+${gen(after - before)})`);

// It mints on top of the current balance rather than setting it, so running
// this twice doubles up.
if (after === before) {
  console.error("balance did not change — the mint did not land");
  process.exit(1);
}
