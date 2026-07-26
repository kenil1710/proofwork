# ProofWork integration tests

Runs the non-AI contract paths against the deployed contract: `create_job`,
`accept_job`, `submit_milestone`, `cancel_job`, and the view methods, including
the failure cases for each.

`verify_milestone` is **not** covered here. It renders pages, screenshots them,
and runs four LLM prompts across validators — routinely 30-60s per call and
costly — so it belongs in a separate suite.

## Running

```bash
cd test
npm install
node run.mjs         # whole suite
node run.mjs 6 7     # only the numbered tests
node run.mjs --slow  # also assert the refund really leaves the contract
node timing.mjs      # measure write latency on the current network
```

## Which network the suite hits

Both the contract address and the network come from `frontend/.env.local`
(`NEXT_PUBLIC_CONTRACT_ADDRESS` and `NEXT_PUBLIC_GENLAYER_NETWORK`), so the
suite always exercises the same deployment the app points at. They are read
from the same file deliberately — each network has its own deploy, so the two
are not independent, and a mismatch is silent: every read simply returns null.

Default is **Studionet** (`https://studio.genlayer.com/api`, chain 61999), the
public hosted Studio. It needs no install and is gasless, so the funding step
below does not apply there. Writes settle in ~6s against Bradbury's minutes.

To redeploy and repoint in one step:

```bash
node deploy.mjs --network=studionet --write-env
node deploy.mjs --network=bradbury  --write-env
```

Two Studionet limits worth knowing: it is rate-limited per IP (60 req/min,
1000/hr, 10000/day — `-32429`), and capped at 32 in-flight transactions per
sender (`-32028`). The harness disables the idleness nudge there partly to stay
under the first. Studio state is also not durable the way a testnet is; if
reads start returning null for a job that existed, redeploy rather than
debugging the contract.

## Test accounts

The suite needs two funded accounts — a client and a freelancer — and the
CLI keystores are password-protected, so it uses throwaway keypairs held in
`test/.accounts.json` (gitignored; they are only good for burning testnet GEN).

To regenerate them:

```bash
cd test
node -e "
const {generatePrivateKey, createAccount} = require('genlayer-js');
const fs = require('fs');
const mk = () => { const key = generatePrivateKey(); return {key, address: createAccount(key).address}; };
fs.writeFileSync('.accounts.json', JSON.stringify({client: mk(), freelancer: mk()}, null, 2) + '\n');
"
```

**On Studionet there is nothing to fund.** Studio does not debit the sender on
a payable call: a wallet holding 0 GEN can `create_job` with a real deposit and
the escrow still lands. Verified directly — a fresh 0-balance account created a
job with a 0.001 GEN deposit, the contract balance rose by exactly that, and the
sender stayed at 0.

The asymmetry matters when writing assertions: **credits are real, debits are
not.** A refund genuinely increases the recipient's balance, but no deposit ever
decreases anyone's. So `getBalance` on a *participant* proves nothing on
Studionet, while `getContractBalance` still behaves. Escrow accounting inside
the contract (`total_amount`, `paid_out`, `freelancer_stake`) is unaffected and
correct on both networks.

If you want a non-zero balance anyway — a demo where the wallet UI should not
read 0 — mint one:

```bash
node fund.mjs <address> [amountGEN]   # default 10 GEN, Studionet only
```

That wraps the `sim_fundAccount` RPC, which **adds** to the balance rather than
setting it. Two notes: `genlayer-js` ships a `client.fundAccount()` helper that
refuses here — it guards on `chain.id !== localnet.id` and throws "Client is not
connected to the localnet" even though the Studionet RPC serves the method — so
`fund.mjs` calls the RPC directly. And the `genlayer` CLI has no fund/faucet
subcommand at all.

On **Bradbury** there is no `sim_fundAccount`; use the faucet
(<https://testnet-faucet.genlayer.foundation>, 100 GEN per 24h, needs a browser
for its Turnstile check) or send from the CLI wallet. Note the amount is in
**wei**, not GEN:

```bash
genlayer account send <client-address>     5000000000000000000 --account mywallet
genlayer account send <freelancer-address> 2000000000000000000 --account mywallet
```

The CLI cannot drive the suite directly: `genlayer write` has no `--value`
flag (only `--fee-value`, which is the fee deposit), so it cannot fund a
payable `create_job`.

## Payouts land on finalization, not acceptance

Paying a client or freelancer is an *external* message to an EOA, and those
apply when the transaction **finalizes**, not when it is accepted. At ACCEPTED
a cancelled job already reads `cancelled` while the GEN has not moved and the
contract still shows the full balance.

Bradbury finalizes on its own, but slowly — measured still ACCEPTED at 8
minutes old and FINALIZED by roughly 2 hours. `finalizeTransaction` reverts
unless the transaction is already `READY_TO_FINALIZE`, so it cannot be hurried.

That is why the escrow assertion is a separate `--slow` test: test 12 proves
the transfer was *emitted* (it used to revert with a VmError), and test 15
proves the GEN actually arrives. Expect test 15 to take up to a couple of
hours.

## Three Bradbury behaviours the harness works around

These are Bradbury-specific. On Studionet transactions settle on their own, so
the harness sets `maxNudges: 0` and polls faster there.

**Rounds park in COMMITTING.** Votes are committed but never revealed, and the
round sits there indefinitely with leader rotations still available. Only
`finalizeIdlenessTxs` moves it, and on this testnet nobody else calls it, so
`awaitConsensus` nudges the transaction itself.

**Reads lag accepted writes.** A transaction can reach `ACCEPTED` and the very
next `readContract` still returns the previous state. This is network
infrastructure, not a contract bug. Every state assertion goes through
`waitForState`, which polls the view method until the expected value appears.
Asserting immediately after a write produces flaky failures.

**A `gl.vm.UserError` does not throw client-side.** The transaction is
`ACCEPTED` with `txExecutionResultName === "FINISHED_WITH_ERROR"`, and the
message exists only as hex-encoded bytes inside the debug trace's
`return_data`. `send()` normalises both outcomes into `{ reverted,
errorMessage }` so tests can assert on the specific message.

## Escrow amounts

Test jobs deposit 0.001 GEN. `get_job` reports `total_amount` inside a JSON
string, so any amount above `Number.MAX_SAFE_INTEGER` base units (~0.009 GEN)
would lose precision in `JSON.parse` and make the amount assertions unreliable.
