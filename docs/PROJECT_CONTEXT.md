# ProofWork — Complete Project Context

> **What this file is.** A single self-contained briefing on ProofWork: what it is, what
> is built, what works, what is broken, and what comes next. Written to be handed to a
> new collaborator who has never seen the repo. Everything here was
> verified against the code on **2026-07-26** — where something is unverified or
> suspected, it says so explicitly.

---

## 1. What ProofWork is

ProofWork is a **trustless freelance escrow platform** built on **GenLayer**, an AI-native
blockchain. A client locks GEN in a contract and writes down what the work must do. A
freelancer builds it and submits evidence — a repository, a deployed URL, a mockup. AI
validators then read that evidence, score it against the written requirements, and **the
score releases the money**. Nobody adjudicates.

The thing that makes this need a blockchain rather than a backend: a regular server with an
LLM could do the *analysis*. What it cannot do is make both parties believe the result
wasn't tampered with. GenLayer's multi-validator consensus is the trust, not the AI.

**Status in one line:** the protocol is complete and working end to end on two live
networks, the frontend is deployed, and the remaining work is cleanup, coverage, and
version control — not features.

---

## 2. Current state at a glance

| Area | Status |
|---|---|
| Intelligent Contract | ✅ Complete — 6 write methods, 4 views, 1061 lines |
| AI verification (`verify_milestone`) | ✅ Works end to end on-chain (194s, verified 2026-07-20) |
| Anti-scam layer (stake + deadline) | ✅ Shipped and tested 9/9 |
| Frontend (Next.js 16) | ✅ Complete — 5 routes, ~28 components |
| Live deployment | ✅ https://proofwork-opal.vercel.app |
| Integration tests | ⚠️ Main suite broken against current ABI — see §9 |
| Git version control | ❌ **Zero commits. No remote. Everything untracked.** |
| Docs (`README.md`) | ⚠️ Stale — predate the anti-scam layer |
| Escrow remainder on 70–89% jobs | ❌ **Permanently locked — see §10** |

**Honest summary:** the software is in substantially better shape than the documentation
describing it. The contract works, the frontend works, and the hard GenLayer problems are
solved. What is missing is everything *around* the code — version control, accurate docs,
a working regression suite — plus two real value-safety gaps in the contract that have never
been fixed (§10).

### Live addresses

| Network | Chain ID | RPC | Contract |
|---|---|---|---|
| **Studionet** (active dev) | 61999 | `https://studio.genlayer.com/api` | `0x809728c767A1f0d885879A15103FA196c2ebdAFe` |
| **Bradbury** (testnet, parked) | 4221 | `https://rpc-bradbury.genlayer.com` | `0x973e40D4b22eb7546CF8610856Ae2d9917BffD19` |

Superseded Bradbury deploy: `0x730d497df5Ed2F1396535430d6291BB950ED2bc8`.

**Frontend is currently pointed at Studionet.** Bradbury sits commented out in
`frontend/.env.local`. The network and the address are **not independent** — each network
has its own deploy, and a mismatch is *silent*: every read simply returns `null`. Always
swap both lines together.

---

## 3. Repository layout

```
proofwork/
├── README.md                    # Public project README (STALE — see §10)
├── contracts/
│   └── proof_work.py            # The Intelligent Contract — 1061 lines
├── frontend/                    # Next.js 16 app (Vercel root directory)
│   ├── src/app/                 # Routes
│   ├── src/components/          # ~28 components
│   ├── src/lib/                 # genlayer.ts, contract.ts, address.ts, units.ts
│   ├── src/hooks/               # useContractWrite, useSkipAnimation
│   ├── src/types/index.ts       # Contract payload types + mirrored scoring logic
│   └── .env.local               # Network + contract address (gitignored)
├── test/                        # Node integration suites + Python unit tests
└── docs/
    ├── USER_GUIDE.md            # End-user guide (current, includes stake/deadline)
    └── PROJECT_CONTEXT.md       # ← this file
```

---

## 4. The protocol

### Job lifecycle

```
create_job    (client, payable)     → status "open"
   ↓
accept_job    (freelancer, payable) → status "in_progress"   [stake deposited]
   ↓
submit_milestone (freelancer)       → milestone "submitted"
   ↓
verify_milestone (anyone)           → milestone "verified" | "rejected"
   ↓                                   ≥70 pays out; all done → "completed", stake returned
   ├── cancel_job  (client, only while "open")      → "cancelled",  escrow refunded
   └── abandon_job (client, past deadline)          → "abandoned",  escrow + stake to client
```

**Job statuses:** `open` · `in_progress` · `completed` · `cancelled` · `abandoned`
**Milestone statuses:** `pending` · `submitted` · `verified` · `rejected`

### Write methods

| Method | Caller | Payable | Signature |
|---|---|---|---|
| `create_job` | client | ✅ | `(title, requirements, milestone_descriptions, milestone_percentages, deadline_seconds, stake_percentage) -> u32` |
| `accept_job` | freelancer | ✅ | `(job_id: u32) -> None` |
| `submit_milestone` | freelancer | — | `(job_id, milestone_id, github_url, site_url, mockup_url) -> None` |
| `verify_milestone` | anyone | — | `(job_id, milestone_id) -> None` |
| `cancel_job` | client | — | `(job_id: u32) -> None` |
| `abandon_job` | client | — | `(job_id: u32) -> None` |

`milestone_descriptions` and `milestone_percentages` are **pipe-separated** strings
(`"Homepage\|Dashboard\|Polish"` / `"30\|40\|30"`), equal length, percentages summing to
exactly 100.

### View methods (all return JSON **strings** except `get_job_count`)

- `get_job(job_id)` → `client, freelancer, title, requirements, total_amount, status,
  milestone_count, completed_milestones, deadline, required_stake, freelancer_stake,
  accepted_at, paid_out, now`
- `get_milestone(job_id, milestone_id)` → `description, percentage, status, github_url,
  site_url, mockup_url, scores{code_quality, design_match, functionality, completeness,
  final_weighted}`
- `get_reputation(address)` → `address, jobs_completed, avg_score, scores[]`
- `get_job_count()` → bare `u32`

⚠️ **Reputation granularity is coarser than it looks.** `scores[]` holds **one integer per
completed job** — the *final milestone's* weighted score, appended only when every milestone
of that job verifies. It is not a per-milestone history, and a freelancer mid-job reads as
having completed nothing.

`now` is the **chain's own clock**, returned so a browser with a skewed system time can
never be told a deadline passed when the contract disagrees.

---

## 5. How verification actually works

This is the heart of the project and the part that took the most engineering to get right.

`verify_milestone` runs **one** `gl.vm.run_nondet` block with an asymmetric leader/validator split:

**Leader** (`_gather_and_score`):
1. `gl.nondet.web.render(github_url, mode="text")` → first 3000 chars
2. `gl.nondet.web.render(site_url, mode="text")` → first 2000 chars
3. If a mockup exists: two `mode="screenshot"` renders (site + mockup)
4. **One** `gl.nondet.exec_prompt(prompt, response_format="json", images=shots)` returning
   all four scores at once
5. Returns scores **plus a fingerprint** of the evidence they came from

**Validators** re-fetch the *text* evidence only and check that the leader scored the same
pages they can see — comparing a **fingerprint** (first 160 chars of whitespace-normalised
text) and page length within 10% (or a 64-char absolute floor). **No validator ever calls an
LLM.**

### Why the split exists — this is measured, not theoretical

| Design | Leader | Validator | Outcome |
|---|---|---|---|
| A | web render | `isinstance` check | ACCEPTED, 12s |
| B | render + 1 LLM prompt | `isinstance` check | ACCEPTED, 400s |
| C | render + 1 LLM prompt | reruns the same prompt | **never commits** |

One LLM call on the *leader* costs 33× but settles. One LLM call on *each validator* means
the transaction **never commits** — it dies in `APPEAL_COMMITTING` having revealed no votes.
This also rules out `gl.eq_principle.prompt_non_comparative()`, whose validators each run a
prompt too.

> ⚠️ **The single most important constraint in this codebase.** Any future change that puts
> an `exec_prompt` on the validator side will silently stop transactions committing, and the
> failure will look like a network problem, not a code problem.

**Trust boundary — state this honestly.** The validator confirms the evidence was *real and
unaltered*: a leader cannot invent a repo, swap the URL, or score a page it never fetched. It
**cannot** catch a leader that fetched real evidence and judged it badly.

### Dynamic weights

Weights shift so a backend job is never marked down for having no design:

| Evidence supplied | Code | Design | Functionality | Completeness |
|---|---|---|---|---|
| GitHub + Site + Mockup | 25 | 25 | 25 | 25 |
| GitHub + Site | 35 | 0 | 35 | 30 |
| GitHub only | 50 | 0 | 0 | 50 |
| Site + Mockup | 0 | 30 | 40 | 30 |
| Site only | 0 | 0 | 50 | 50 |

A criterion with zero weight was **never assessed** — which is a different fact from scoring
badly. The UI renders those as "not assessed" rather than a red 0/100 bar.

### Score → payout

| Final weighted score | Releases |
|---|---|
| 90–100 | 100% of the milestone's share |
| 80–89 | 80% |
| 70–79 | 70% |
| below 70 | **0% — rejected**, resubmit |

Pass threshold is 70, and the validator gates on the same constant deliberately: if those
two ever disagreed, validators would be agreeing about a payment decision the contract then
makes differently.

### Error classes

The leader prefixes failures so validators know how to treat a matching failure:

| Prefix | Meaning | Validator behaviour |
|---|---|---|
| `[EXPECTED]` | business rule | must match exactly |
| `[EXTERNAL]` | evidence unreachable / 4xx | must match exactly |
| `[TRANSIENT]` | network blip | both hitting one = agreement |
| `[LLM_ERROR]` | model misbehaved | **never** agreement — forces validator rotation |

---

## 6. The anti-scam layer (stake + deadline)

Escrow alone protects the client's money but not their *time*. Without it, anyone can accept
a job, do nothing, and burn the entire delivery window at zero cost to themselves.

**Client sets two things at creation:** a deadline (in days) and a stake percentage (0–50%
of escrow).

**Freelancer must deposit that stake — exactly — to accept.** Not a minimum: an overpayment
would sit in the contract with no rule saying who gets it back.

| Outcome | Where the stake goes |
|---|---|
| Every milestone verified | Returned with the final payment |
| A milestone rejected | Stays locked — resubmit and carry on |
| Client abandons after deadline | **Forfeited to the client** |
| Client cancels before anyone accepts | No stake exists yet |

**The 50% cap is deliberate.** Past roughly half the escrow, a stake stops deterring
no-shows and becomes a way to extract more from a freelancer than the job pays — the same
scam running the other direction.

**Abandonment refunds `total_amount - paid_out + freelancer_stake`.** `paid_out` is tracked
rather than recomputed from percentages because score bands mean a verified milestone may
have released only 70% or 80% of its share; the remainder stayed in escrow and belongs to
the client. Milestones already verified are **not** clawed back.

Nothing happens automatically at expiry — abandoning is the client's active choice. A
freelancer who is late but communicating is a negotiation; the contract just guarantees the
client is never stuck waiting forever.

### The clock

**GenVM has no `block.timestamp`.** The only time-like field is
`gl.message_raw['datetime']` — an ISO-8601 UTC string fixed in the transaction message, so
every validator executing a given transaction reads the identical value. That is what makes
it safe to branch on. `_epoch_now()` parses it with hand-written integer date math (Howard
Hinnant's civil-days algorithm) rather than importing `datetime`.

It returns `0` when unreadable, and **every caller raises rather than treating 0 as 1970** —
otherwise an unreadable clock would silently make every deadline appear to have passed.

---

## 7. Frontend

**Stack:** Next.js 16.2.10 (App Router) · React 19.2.4 · TypeScript · Tailwind CSS 4 ·
`genlayer-js` 1.1.8 · viem. No state management library — React state and context only.

### Routes

| Route | File | Rendering |
|---|---|---|
| `/` | `app/page.tsx` | Static marketing landing — reads nothing from chain |
| `/app` | `app/app/page.tsx` | Live job list + network readout |
| `/create` | `app/create/page.tsx` | Client job-creation form |
| `/job/[id]` | `app/job/[id]/page.tsx` | Job detail, milestones, all actions |
| `/reputation` | `app/reputation/page.tsx` | Freelancer lookup by address |
| `/docs` | `app/docs/page.tsx` | In-app documentation with search |

The landing page is **deliberately static** — it never shows a loading state and cannot be
wrong when the node is down. It also shows **no example figures at all**: every number on it
is a rule the contract enforces (the pass threshold, the payout bands, the count of
criteria), never a sample score, because a visitor cannot tell an illustrative 85 from a real
one. Worked verdicts live in `/docs`, where the surrounding text makes their status
unmistakable.

### Key library files

- **`lib/genlayer.ts`** — client setup, network resolution, wallet chain add/switch.
  Uses the SDK's **built-in chain definitions** (`studionet`, `testnetBradbury`), never a
  hand-rolled chain object — the built-ins carry the consensus/staking/appeals contract
  addresses the SDK needs for receipt polling.
- **`lib/contract.ts`** — every typed read and write, plus the whole consensus-waiting
  state machine. ~930 lines and the densest file in the frontend.
- **`lib/units.ts`** — GEN ↔ base units, enforcing the u64 escrow ceiling.
- **`lib/address.ts`** — EIP-55 checksumming and case-insensitive comparison.
- **`types/index.ts`** — contract payload types plus **mirrored** scoring logic
  (`evaluationWeights`, `payoutBand`, `milestonePayout`) so the UI can explain *why* a
  criterion scored zero. The payout math reproduces the contract's divide-before-multiply
  order exactly, truncation included.

### Transaction lifecycle UI

`useContractWrite` drives one write through: `idle → signing → waiting → settling → done`
(or `error`). `settling` is its own phase on purpose — acceptance is not the end, because
reads lag accepted writes, so the caller re-reads until the change actually appears.

`TxProgressModal` narrates it with **measured** estimates (10–40s ordinary, 194s for
verification), and cannot be dismissed while a transaction is in flight — closing it would
not cancel anything.

### Design system

Palette **sampled from the Spline ribbon-sphere hero render**, not chosen by eye: magenta
`#e56de5` (orchid, the accent), violet `#8a42ff` (its gradient partner), deep indigo
`#17074e` (the neutral base). Surfaces are numbered by **role, not lightness** — `950` is
page, `900` card, `800` border, `600` muted text, `100` heading — and the scale **inverts
wholesale** between themes, which is what lets one set of utilities serve light and dark
without a single `dark:` variant in any component.

One typeface (Geist) for everything a person reads. Mono is a **signal**, not a style: it
means "machine-emitted value you may need to compare character by character" — addresses,
hashes, chain ids, code.

---

## 8. Networks and their behaviour

**Studionet is the dev network.** Gasless (a 0 GEN balance deploys and writes fine, so no
faucet step), settles in seconds, nothing to install.

| | Studionet | Bradbury |
|---|---|---|
| deploy | 6s, 0 nudges | minutes + manual nudge |
| `create_job` → ACCEPTED | 6s | minutes, parks in COMMITTING |
| `create_job` → readable | 10s | longer still |
| `accept_job` → ACCEPTED | 14s | minutes |

### Four behaviours the code works around

**1. Bradbury rounds park in COMMITTING.** Votes committed, none revealed, indefinitely.
Only `finalizeIdlenessTxs` moves them, and on this testnet nobody else calls it — so
`waitForWrite` nudges the transaction itself. Disabled on Studio (`maxNudges: 0`), which
also keeps the suite under Studionet's rate limit.

**2. Reads lag accepted writes.** A transaction reaches ACCEPTED and the very next
`readContract` still returns the previous state. This is infrastructure, not a contract bug.
Every state assertion goes through `waitForState`, which polls until the expected value
appears. Asserting immediately after a write produces flaky failures.

**3. A `gl.vm.UserError` does not throw client-side — and is reported differently per
network.** On Bradbury: `txExecutionResultName === "FINISHED_WITH_ERROR"`, message only as
hex bytes in the debug trace. On Studio: `txExecutionResultName` is **`undefined`**, and the
outcome lives in `tx.consensus_data.leader_receipt[0]` with `result.payload` already decoded.
Do **not** read the top-level `result_name` — that is the *consensus* outcome and reads
`MAJORITY_AGREE` on a reverted call too, because validators agree unanimously that it
reverted. Both `lib/contract.ts` and `test/harness.mjs` handle both shapes.

**4. Payouts land on FINALIZATION, not acceptance.** Paying an EOA is an *external* message,
and those apply when the transaction finalizes. On Bradbury that was measured still ACCEPTED
at 8 minutes and FINALIZED around 2 hours. Nothing can hurry it —
`finalizeTransaction` reverts unless the round is already `READY_TO_FINALIZE`. The
`PayoutNotice` component states this plainly rather than showing a green tick over a balance
that has not changed.

**Studionet caveats:** rate-limited per IP (60/min, 1000/hr, 10000/day → `-32429`), capped at
32 in-flight transactions per sender (`-32028`), and **state is not durable** — if reads
suddenly return null for a job that existed, the deploy is gone; redeploy rather than
debugging the contract.

**Studionet accounting asymmetry:** Studio does **not debit the sender** on a payable call. A
wallet holding 0 GEN can `create_job` with a real deposit and the escrow still lands. So
**credits are real, debits are not** — `getBalance` on a participant proves nothing there,
while `getContractBalance` still behaves. Escrow accounting inside the contract is unaffected
and correct on both networks.

---

## 9. Testing

| Suite | Command | Covers | Status |
|---|---|---|---|
| `test/test_logic.py` | `python3 test/test_logic.py` | Pure scoring/parsing logic, 41 assertions, milliseconds | ✅ |
| `test/run.mjs` | `cd test && node run.mjs` | create/accept/submit/cancel + views + failure cases | ⚠️ **stale, see below** |
| `test/stake-e2e.mjs` | `node stake-e2e.mjs` | Stake + deadline + abandon, 9 tests | ✅ 9/9 green |
| `test/verify-e2e.mjs` | `node verify-e2e.mjs <jobId> <msId>` | Full AI verification (~194s) | ✅ |
| `test/payout-e2e.mjs` | `node payout-e2e.mjs` | The payout branch with real evidence | ⚠️ **stale** |
| `test/timing.mjs` | `node timing.mjs` | Write latency on the current network | ✅ |
| `test/deploy.mjs` | `node deploy.mjs --network=studionet --write-env` | Deploy + rewrite `.env.local` | ✅ |

Both the network and the contract address are read from `frontend/.env.local`, so the suite
always exercises the same deployment the app points at.

### ⚠️ Known stale tests — verified 2026-07-26

`test/run.mjs`, `test/payout-e2e.mjs` and `test/verify-minimal.mjs` were written against the
**pre-anti-scam ABI** and cannot pass. Two separate breaks:

1. **`create_job` is called with 4 arguments** — `["Portfolio site", REQUIREMENTS, MILESTONES,
   PERCENTAGES]`. The contract requires **6**; `deadline_seconds` and `stake_percentage` were
   added by the anti-scam layer.
2. **`accept_job` is called with no value** (`run.mjs:186`). The contract is now
   `@gl.public.write.payable` and reverts unless `msg.value == required_stake` exactly.

Only `stake-e2e.mjs` and `timing.mjs` use the current ABI. Tests 2–15 of the main suite are
effectively dead. **Fixing this is the highest-value piece of outstanding work**, because
`run.mjs` is the `npm test` target and the main regression suite.

Also broken: `test/probe-time.mjs` opens `contracts/_probe_time.py`, which has been deleted —
it throws `ENOENT`.

### Verification tests assert nothing

`verify-e2e.mjs`, `verify-minimal.mjs` and `payout-e2e.mjs` **print reports and exit 0**
unless the call itself reverted. A wrong score, a wrong weight branch, or a missing payout
would not fail anything. The `<70` rejection branch is never exercised, and no test covers a
multi-milestone job — so the completion path that returns the stake and writes reputation is
untested end to end.

### Not covered

- The **stake-returned-on-completion** path end to end (needs a full LLM round).
- Any frontend unit or component tests — there are none.
- No CI. Nothing runs automatically.

### Test accounts

Two throwaway keypairs in `test/.accounts.json` (gitignored — regenerate per `test/README.md`;
they are only good for burning testnet GEN). On Studionet there is nothing to fund. On
Bradbury use the faucet (100 GEN/24h, needs a browser for its Turnstile check) — and note
`genlayer account send` takes **wei**, not GEN.

---

## 10. Known issues and inaccuracies

### 🔴 Nothing is under version control

`git log` is empty. **Zero commits, no branches, no remote.** Every file in the project is
untracked. This is the single largest risk to the project — there is no history, no backup,
and no way to recover from a bad edit.

It also has a concrete downstream effect: Vercel **preview** environment variables cannot be
set (`vercel env add … preview` fails with `git_branch_required`, and supplying a branch then
fails with "Project does not have a connected Git repository"). Deploys upload the local
directory directly. Production is unaffected.

### 🟡 Root `README.md` is stale

It predates the anti-scam layer entirely:
- No mention of `abandon_job`, stakes, deadlines, or the `abandoned` status
- Its write-method table lists 5 methods; the contract has 6
- `create_job` is shown with 4 parameters; it takes 6
- Says "Network: GenLayer Bradbury Testnet" while the app runs on Studionet
- Describes verification as four separate AI checks; it is now **one** consensus round
- Claims `gl.eq_principle.prompt_non_comparative()` — that approach was **abandoned** because
  it never commits
- **Links section is still `[TBD]`** despite a live deployment at
  `https://proofwork-opal.vercel.app`

### 🟡 The method table the tests were written from is stale

`test/run.mjs` was written from an older method table and is now dead because of it.
Specifically stale: `create_job` shown with 4 args; `accept_job` shown as non-payable with no
stake note; no `abandon_job` row; `get_job` shown returning 8 keys (it returns 14); the SDK
snippets hand-roll a chain object and use `waitForTransactionReceipt` (the code deliberately
does neither); the project-structure tree lists `frontend/tailwind.config.ts` and a root
`.env.example` that do not exist; and `NEXT_PUBLIC_GENLAYER_NETWORK` — the var that actually
decides which chain the app talks to — is undocumented, while `NEXT_PUBLIC_GENLAYER_RPC_URL`
and `NEXT_PUBLIC_CHAIN_ID` are read by no source file at all.

It also still reads as a build spec ("Your job is to: build the frontend… deploy to Vercel"),
which makes a fresh reader think nothing has been built.

### 🟡 Appeals are documented but do not exist in this project

Both `README.md` and `docs/USER_GUIDE.md` describe appeals as a feature either party can
reach. There is **no appeal function in the contract and no appeal surface in the frontend**.
Appeals are a GenLayer network-level capability being presented to end users as a product
feature.

### 🟡 The weight table is documented four different ways

`README.md` says a flat 25/25/25/25. The contract computes a table with asterisks and
slash-alternatives. `docs/USER_GUIDE.md` gives a table whose last row is **mislabelled** — it
calls `0/30/40/30` "Site only (no code)", but that branch is reached only when a **mockup** is
present. Genuine site-only (no GitHub, no mockup) falls through to `0/0/50/50`, which is
documented nowhere outside the contract. The contract has five explicit branches; no two
documents agree. §5 of this file has the correct table.

Otherwise `docs/USER_GUIDE.md` is the most accurate of the three documents and does cover
stake/deadline/abandon correctly.

### 🟡 `frontend/README.md` is untouched `create-next-app` boilerplate

### 🟡 Smaller frontend issues

- **Three "back to dashboard" links point at `/`** — the static marketing landing page — not
  `/app`, which is the actual dashboard. (`JobDetail.tsx:169`, `app/job/[id]/page.tsx:27`,
  `app/create/page.tsx:303`.)
- **`VerdictCard.tsx` is dead code.** It is imported by nothing and contains hardcoded example
  scores, which violates the project's own "only contract-enforced numbers outside /docs" rule.
- **`docs/sections.tsx` omits the `abandoned` status** from its state table ("A job moves
  through four states") while the prose further down mentions abandonment — the page
  contradicts itself. This is hand-maintained drift from `docs/USER_GUIDE.md` with no shared
  source.
- **No `not-found.tsx`, `error.tsx` or `loading.tsx`** anywhere under `src/app`. `/job/[id]`
  and `/reputation` also export no `metadata`, so every job page shares the root tab title.
- **`JobList` caps at 12 with no pagination** and no auto-refresh.
- **`Modal.tsx` has no focus trap** — Tab walks out of the dialog into the page behind it,
  including while `TxProgressModal` is deliberately non-dismissible.
- **`CONTRACT_ERRORS` in `lib/contract.ts` is a hand-maintained mirror** of the contract's
  error strings with nothing linking the two; rewording an error in `proof_work.py` silently
  degrades the UI to a generic fallback.

### 🟡 Contract housekeeping

- `verify_milestone` computes `code_weight` / `design_weight` / `func_weight` / `comp_weight`
  as `u32` (lines 833–836) and **never reads any of them** — dead code in the most expensive
  method in the contract.
- **No events are emitted anywhere.** Combined with payouts applying on finalization, a
  reloaded page cannot tell whether money landed.
- `get_reputation`'s empty-scores branch hard-codes `jobs_completed: 0` despite having already
  read the real count one line earlier.
- Debris in `test/`: seven abandoned probe scripts, Bradbury-hardcoded and ignoring
  `.env.local`, plus `__pycache__` under both `contracts/` and `test/`.

### 🔴 A reverted `create_job` permanently strands the deposit

**Observed on chain, twice.** A `create_job` that reverts (e.g. percentages not summing to
100) keeps the GEN. There is no job record afterwards, so no `cancel_job` can ever refund it
— **the deposit is unrecoverable.**

`lib/contract.ts` validates percentages, description/percentage counts, deadline, stake
range, and a non-zero deposit **client-side before sending**. Those guards are
**load-bearing, not belt-and-braces**. A proper contract-side fix would require `create_job`
to refund `gl.message.value` on every error path.

### 🔴 Escrow is permanently locked when a job completes in the 70–89% bands

**Verified by reading the code 2026-07-26.** If every milestone verifies at a score of 70–89,
each releases only 70% or 80% of its share. The remainder stays in the contract — and when
`completed_milestones == milestone_count`, the job flips to `status = "completed"`.

`abandon_job` then cannot recover it: it requires `status == "in_progress"` **and**
`completed_milestones < milestone_count`, and reverts with *"Every milestone is verified;
nothing to abandon"*. There is no completion-time remainder refund anywhere.

**Consequence: 10–30% of the escrow is stranded in the contract permanently**, on the ordinary
happy path of a job that was merely good rather than excellent. Nothing in the UI warns a
client about this before they post a job.

Note `docs/USER_GUIDE.md` currently implies the opposite — "the leftover from partial payouts
stays in escrow and comes back to you as well". That is true **only** on the abandon path.

### 🟡 A rejected freelancer cannot recover their stake unilaterally

The stake is released only by completing every milestone, or forfeited by client abandonment.
Only the **client** can call `abandon_job`. If a milestone is rejected and the client simply
never acts, the stake sits locked indefinitely. The freelancer can at least resubmit and
self-trigger `verify_milestone`, so this is narrower than a full deadlock — but there is no
freelancer-side timeout or dispute path.

### 🟡 `verify_milestone` has no caller restriction and no deadline check

Anyone can trigger the most expensive operation in the contract, including after the deadline
has passed. This is intentional (the FAQ documents "anyone can call it") but worth knowing.

### 🟡 `create_job` raises raw `ValueError` on non-numeric percentages

`int(p.strip())` at lines 579 and 625 has no `try`/`except`, so a non-numeric or negative
percentage raises a raw conversion error rather than a `gl.vm.UserError`. Because that error
path **still keeps the deposit** (see above), the failure mode is both unhelpful and
expensive.

### 🟡 Escrow is capped at ~18.44 GEN

`Job.total_amount` is `u64` and `create_job` does `u64(gl.message.value)` on 18-decimal base
units, so u64 max = ~18.446744 GEN. `parseGen` enforces this client-side. A related
~0.184 GEN intermediate-overflow hazard **was fixed** by dividing before multiplying
everywhere money is scaled, but has not been exercised at runtime above that threshold.

### 🟡 `total_amount` exceeds `Number.MAX_SAFE_INTEGER` above ~0.009 GEN

The contract emits it as a JSON *number*. `getJob` quotes the base-unit fields with a regex
before `JSON.parse` and converts to `bigint`, or every amount shown and every payout derived
from it would be quietly wrong.

### 🟡 Reputation lookups need checksummed addresses

`freelancer_scores` is keyed by Python's `str(Address)` — the EIP-55 checksummed form. An
unknown key reads as **zeroed rather than erroring**, so a lowercase address silently reports
"no completed jobs". Normalise with `toContractAddress` first.

---

## 11. Hard constraints — do not break these

These are all encoded as comments in the contract. Each one
cost real debugging time.

1. **Line 1 of `proof_work.py` must be the runner pin**, nothing above it. A comment on
   line 2 makes the contract undeployable — lint passes, and deploy says only
   `invalid_contract`.
2. **Never declare a `u256` storage field.** Deployment fails with `invalid_contract`. Store
   `u64` and cast to `u256` at the `emit_transfer` call site.
3. **The AI evaluators must stay module-level functions, never methods.** A lambda calling
   `self._method()` captures a storage-backed instance; GenVM tries to pickle it and dies
   with *"Detected pickling storage class"* at run_time 0s with empty eq_outputs — which
   looks nothing like a scoring problem.
4. **Call `str()` on every `copy_to_memory`'d attribute before it enters a nondet closure.**
   `copy_to_memory` does not hand back plain Python strings; the attributes stay
   storage-backed. Every verification reverted this way until 2026-07-20.
5. **Paying an EOA needs `@gl.evm.contract_interface`.** Not `gl.ContractAt` (a removed
   v0.1.0 name) and not `gl.get_contract_at` (IC-to-IC internal messages only). Both raise a
   VmError that rolls the whole call back.
6. **Validators must never call an LLM.** See §5.
7. **Divide before multiplying** everywhere money is scaled — the multiply-first form
   overflows u64 once the operand passes `u64_max/100`.
8. **New `Job` fields go at the end.** Storage layout is positional.
9. **Do not use deprecated GenLayer APIs** — `gl.get_webpage`, `gl.exec_prompt`,
   `gl.eq_principle_strict_eq` are all gone. The `simulator` chain name is
   also gone; the exports are `studionet` / `localnet` / `testnetBradbury`.
10. **`isDecidedState()` is broken in genlayer-js 1.1.8** — it returns false for every input
    including `"ACCEPTED"`, so a loop using it never exits. And do **not** treat
    `LEADER_TIMEOUT` / `VALIDATORS_TIMEOUT` as terminal: the round rotates to a new leader
    and carries on.
11. **The genvm-lint "nested non-deterministic block" errors on `proof_work.py` are false
    positives.** Do not restructure the contract to silence them.
12. **`node -e "import('./some-test.mjs')"` executes the module** and fires real
    transactions. Use `node --check <file>` for a syntax check.

---

## 12. Working with the project

### Run the frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

`NEXT_PUBLIC_CONTRACT_ADDRESS` is read at module load and the pages are statically
prerendered, so a missing or malformed value **fails the build** rather than degrading at
runtime.

### Deploy the contract

```bash
node test/deploy.mjs --network=studionet --write-env   # rewrites frontend/.env.local
node test/deploy.mjs --network=bradbury  --write-env
```

Uses the SDK rather than `genlayer deploy`, because the CLI has no nudge logic and Bradbury
deploys park in COMMITTING until `finalizeIdlenessTxs` moves them.

### Deploy the frontend

```bash
cd frontend
vercel --prod --yes
```

**There is no connected Git repo, so nothing auto-deploys.** Local edits are invisible to
production until someone runs `vercel --prod`. When production "still" looks wrong, check
`vercel ls` for the deployment age and `curl` the live URL *before* editing anything — on
2026-07-21 a request to change the homepage turned out to be already done in code, with
production 10 hours stale. The fix was a deploy, not a code change.

Verify a deploy by **rendering the live page with JS**, not by trusting `readyState: READY` —
pages fetch the chain client-side, so a broken contract address still returns HTTP 200 with
an empty shell.

### Switch networks

Edit **both** lines in `frontend/.env.local` together, then redeploy the frontend if the
change should reach production:

```env
NEXT_PUBLIC_GENLAYER_NETWORK=studionet
NEXT_PUBLIC_CONTRACT_ADDRESS=0x809728c767A1f0d885879A15103FA196c2ebdAFe
```

---

## 13. What comes next

Ordered by value. None of these are new features — the protocol is done.

### Immediate

1. **`git init` and commit everything.** Zero commits today. This is the biggest risk in the
   project and takes minutes to fix. Connecting a remote also unblocks Vercel preview
   environments and auto-deploy.
2. **Fix the stale test ABI** in `test/run.mjs`, `test/payout-e2e.mjs` and
   `test/verify-minimal.mjs` — add `deadline_seconds` + `stake_percentage` to `create_job`,
   and send the exact stake on `accept_job`. The main regression suite is currently
   non-functional against the deployed contract.
3. **Decide what to do about the stranded 70–89% remainder.** This is the most serious
   *behavioural* issue in the project: an ordinary successful job silently locks 10–30% of the
   escrow forever. Either release the remainder to the client on completion, or pay the full
   milestone share and drop the score-band discount — but the current middle ground loses
   real money on the happy path.
4. **Rewrite the root `README.md`** to match the shipped protocol: six write methods, the
   stake/deadline/abandon mechanism, the dynamic weight table, the single-nondet-block
   verification design (not `prompt_non_comparative`, which provably never converged), and
   the live URL and contract addresses in place of `[TBD]`.

### Short term

6. **Remove the appeals claims** from `README.md` and `docs/USER_GUIDE.md`, or build an
   appeals surface. Right now the docs promise a feature the product does not have.
7. **Fix the mislabelled weight row** in `docs/USER_GUIDE.md` and document the genuine
   site-only branch (`0/0/50/50`).
8. **Make the verification tests assert.** They currently print and exit 0 — a wrong score or
   a missing payout fails nothing.
9. **Cover the stake-returned-on-completion path** end to end, and add a multi-milestone job
   and a `<70` rejection case.
10. **Point the three "back to dashboard" links at `/app`**, delete `VerdictCard.tsx`, and add
    `abandoned` to the docs state table.
11. **Replace `frontend/README.md`** boilerplate with something real.
12. **Decide the submission network.** Bradbury is the real testnet and the contract there
    carries every fix; Studionet is faster but its state is not durable. If Bradbury is the
    target, swap `.env.local`, update the Vercel env var, and redeploy.

### Medium term

13. **Contract-side fix for the stranded-deposit bug** — have `create_job` refund
    `gl.message.value` on its error paths (and wrap the `int(p.strip())` calls), so the
    client-side guards stop being the only thing standing between a typo and an unrecoverable
    loss.
14. **Give the freelancer a stake-recovery path** that does not depend on the client acting.
15. **Emit events** so a reloaded page can tell whether a payout landed.
16. **Frontend tests.** There are none. `lib/contract.ts`, `lib/units.ts`, `lib/address.ts`
    and the pure arithmetic in `types/index.ts` are all verified end-to-end only.
17. **CI.** Nothing runs automatically — no `.github/`, no root `package.json`, no script
    tying lint + typecheck + test together.
18. **Exercise the escrow ceiling** — create a job above ~0.19 GEN and verify a milestone, to
    confirm the divide-before-multiply fix end to end at scale.
19. **Add `not-found.tsx` / `error.tsx`**, per-page `metadata`, `JobList` pagination, and a
    focus trap in `Modal.tsx`.
20. **Clean out `test/` debris** — seven abandoned probe scripts and the `__pycache__`
    directories.

---

## 14. Quick reference

```
Studionet   chain 61999   https://studio.genlayer.com/api
            0x809728c767A1f0d885879A15103FA196c2ebdAFe

Bradbury    chain 4221    https://rpc-bradbury.genlayer.com
            0x973e40D4b22eb7546CF8610856Ae2d9917BffD19
            explorer: https://explorer-bradbury.genlayer.com
            faucet:   https://testnet-faucet.genlayer.foundation

Live app    https://proofwork-opal.vercel.app
Vercel      project "proofwork", scope kenils-projects-a3f732d1, root frontend/

Pass threshold   70
Payout bands     ≥90 → 100%   ≥80 → 80%   ≥70 → 70%   <70 → rejected
Max stake        50% of escrow
Max escrow       ~18.446744 GEN (u64 ceiling)
Verify duration  ~194s measured on Bradbury
```
