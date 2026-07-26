# ProofWork — AI-Verified Freelance Escrow on GenLayer

## PROJECT OVERVIEW

Build a complete DApp called **ProofWork** — a trustless freelance escrow platform on GenLayer where AI validators verify deliverables using code analysis, visual design comparison, and multi-criteria scoring.

The Intelligent Contract is already written at `contracts/proof_work.py`. Your job is to:
1. Build the frontend (Next.js + TypeScript + GenLayerJS SDK)
2. Write tests
3. Make it deployable to GenLayer Bradbury testnet
4. Create clean documentation

## WHAT IS GENLAYER

GenLayer is an AI-native blockchain. Smart contracts (called "Intelligent Contracts") are written in Python and can:
- Call LLMs via `gl.nondet.exec_prompt()`
- Fetch web pages via `gl.nondet.web.render(url, mode="text"|"html"|"screenshot")`
- Compare screenshots using `gl.nondet.exec_prompt(prompt, images=[img1, img2])`
- Reach consensus via multiple AI validators (Optimistic Democracy)

Contracts are deployed using the GenLayer CLI. The frontend interacts via the `genlayer-js` SDK (TypeScript, built on Viem).

## NETWORK DETAILS

```
Network: Bradbury Testnet
RPC URL: https://rpc-bradbury.genlayer.com
Chain ID: 4221
Currency: GEN
Explorer: https://explorer-bradbury.genlayer.com
Faucet: https://testnet-faucet.genlayer.foundation
```

## GENLAYERJS SDK PATTERNS

Install: `npm install genlayer-js`

### Client Setup
```typescript
import { createClient, createAccount } from 'genlayer-js';
import { simulator } from 'genlayer-js/chains';

// For testnet Bradbury:
const account = createAccount();
const client = createClient({
  chain: {
    id: 4221,
    name: 'GenLayer Bradbury',
    rpcUrls: {
      default: { http: ['https://rpc-bradbury.genlayer.com'] },
    },
    nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
  },
  account: account,
});
```

### Reading from contract
```typescript
const result = await client.readContract({
  address: contractAddress,
  functionName: 'get_job',
  args: [jobId],
});
// result is the return value from the Python contract
```

### Writing to contract
```typescript
const hash = await client.writeContract({
  address: contractAddress,
  functionName: 'accept_job',
  args: [jobId],
});

// Wait for finalization
const receipt = await client.waitForTransactionReceipt({
  hash,
  status: 'ACCEPTED', // or 'FINALIZED'
});
```

### Writing with value (payable)
```typescript
const hash = await client.writeContract({
  address: contractAddress,
  functionName: 'create_job',
  args: [title, requirements, milestoneDescs, milestonePcts],
  value: BigInt(amount), // GEN to deposit
});
```

## THE CONTRACT (already written)

The contract is at `contracts/proof_work.py`. Here are the methods the frontend must call:

### Write Methods (transactions)
| Method | Caller | Args | Notes |
|---|---|---|---|
| `create_job(title, requirements, milestone_descriptions, milestone_percentages)` | Client | milestone_descriptions: pipe-separated "desc1\|desc2\|desc3", milestone_percentages: pipe-separated "30\|40\|30" | PAYABLE — must send GEN value |
| `accept_job(job_id)` | Freelancer | job_id: u32 | |
| `submit_milestone(job_id, milestone_id, github_url, site_url, mockup_url)` | Freelancer | URLs as strings, use "none" if not applicable | |
| `verify_milestone(job_id, milestone_id)` | Anyone | Triggers AI verification | This is the heavy operation |
| `cancel_job(job_id)` | Client | Only works on "open" jobs | Refunds escrow |

### View Methods (reads, no gas)
| Method | Returns |
|---|---|
| `get_job(job_id)` | JSON string with job details |
| `get_milestone(job_id, milestone_id)` | JSON string with milestone + scores |
| `get_reputation(freelancer_address)` | JSON string with score history |
| `get_job_count()` | u32 total jobs |

### Return format for get_job:
```json
{
  "client": "0x...",
  "freelancer": "0x...",
  "title": "Build portfolio website",
  "requirements": "React + Tailwind...",
  "total_amount": 1000,
  "status": "open|in_progress|completed|cancelled",
  "milestone_count": 3,
  "completed_milestones": 1
}
```

### Return format for get_milestone:
```json
{
  "description": "Homepage and navigation",
  "percentage": 30,
  "status": "pending|submitted|verified|rejected",
  "github_url": "https://github.com/...",
  "site_url": "https://mysite.vercel.app",
  "mockup_url": "https://figma.com/...",
  "scores": {
    "code_quality": 85,
    "design_match": 90,
    "functionality": 80,
    "completeness": 88,
    "final_weighted": 85
  }
}
```

### Return format for get_reputation:
```json
{
  "address": "0x...",
  "jobs_completed": 3,
  "avg_score": 82,
  "scores": [78, 85, 84]
}
```

## FRONTEND REQUIREMENTS

### Tech Stack
- Next.js 14+ (App Router)
- TypeScript
- Tailwind CSS
- genlayer-js SDK
- Wallet connection (MetaMask or private key)

### Pages to Build

#### 1. Homepage / Dashboard
- Show total jobs count
- List of recent/open jobs
- Quick stats
- Connect wallet button

#### 2. Create Job Page (Client)
- Form fields:
  - Job title (text input)
  - Requirements (textarea — explain clearly this is what AI evaluates against)
  - Mockup/Design URL (text input, optional — explain this is for visual comparison)
  - Milestones section:
    - Add/remove milestones dynamically
    - Each milestone: description + percentage
    - Show validation that percentages sum to 100
  - GEN amount to deposit (number input)
- Submit → calls `create_job` with value

#### 3. Job Detail Page
- Show job info (title, requirements, status, amounts)
- Show all milestones with their status and scores
- For each milestone show:
  - Description and percentage
  - Status badge (pending/submitted/verified/rejected)
  - If verified: show all 4 scores as progress bars or score cards
  - Score breakdown: Code Quality, Design Match, Functionality, Completeness
  - Final weighted score
- Action buttons based on role:
  - Freelancer: "Accept Job" button (if job is open)
  - Freelancer: "Submit Milestone" form (GitHub URL, Site URL, Mockup URL inputs)
  - Anyone: "Verify Milestone" button (triggers AI evaluation)
  - Client: "Cancel Job" button (if job is open)

#### 4. Reputation Page
- Search by freelancer address
- Show: jobs completed, average score, score history
- Visual representation (chart or score cards)

### UI/UX Guidelines
- Clean, modern design with Tailwind
- Dark mode support preferred
- Clear status indicators for job/milestone states
- Loading states for transactions (GenLayer transactions take time due to AI consensus)
- Error handling with user-friendly messages
- Mobile responsive
- Show transaction status: Pending → Proposing → Accepted → Finalized

### Important Frontend Details
- GenLayer transactions are SLOW (AI validators need to run LLMs). Show proper loading/pending states.
- `verify_milestone` is the heaviest call — it fetches web pages, takes screenshots, runs 4 LLM prompts. Can take 30-60 seconds. Show a clear "Verifying..." state.
- All contract view methods return JSON STRINGS — parse them with `JSON.parse()` in the frontend.
- The `create_job` method is payable — must include `value` in the writeContract call.
- Milestone descriptions use pipe `|` separator, not commas.
- Milestone percentages also use pipe `|` separator and must sum to 100.

## PROJECT STRUCTURE

```
proofwork/
├── contracts/
│   └── proof_work.py              # Intelligent Contract (ALREADY DONE)
├── frontend/
│   ├── src/
│   │   ├── app/                   # Next.js app router pages
│   │   │   ├── page.tsx           # Homepage/dashboard
│   │   │   ├── create/page.tsx    # Create job form
│   │   │   ├── job/[id]/page.tsx  # Job detail page
│   │   │   └── reputation/page.tsx # Reputation lookup
│   │   ├── components/            # Reusable components
│   │   │   ├── Navbar.tsx
│   │   │   ├── JobCard.tsx
│   │   │   ├── MilestoneCard.tsx
│   │   │   ├── ScoreDisplay.tsx
│   │   │   ├── ConnectWallet.tsx
│   │   │   └── TransactionStatus.tsx
│   │   ├── lib/
│   │   │   ├── genlayer.ts        # GenLayer client setup
│   │   │   └── contract.ts        # Contract interaction helpers
│   │   └── types/
│   │       └── index.ts           # TypeScript types for Job, Milestone, etc.
│   ├── .env.example
│   ├── .env.local
│   ├── package.json
│   ├── tailwind.config.ts
│   └── tsconfig.json
├── test/                          # Python tests
├── docs/
│   └── USER_GUIDE.md             # User guide (ALREADY DONE)
├── README.md                     # Project documentation (ALREADY DONE)
└── .env.example
```

## ENV VARIABLES

```env
# frontend/.env.local
NEXT_PUBLIC_CONTRACT_ADDRESS=0x...  # Deployed contract address
NEXT_PUBLIC_GENLAYER_RPC_URL=https://rpc-bradbury.genlayer.com
NEXT_PUBLIC_CHAIN_ID=4221
```

## SCORING LOGIC (for UI display)

The contract uses dynamic weights based on what evidence is provided:

| Evidence | Code Weight | Design Weight | Func Weight | Comp Weight |
|---|---|---|---|---|
| GitHub + Site + Mockup | 25% | 25% | 25% | 25% |
| GitHub + Site (no mockup) | 35% | 0% | 35% | 30% |
| GitHub only | 50% | 0% | 0% | 50% |
| Site only | 0% | 30%* | 40%/50% | 30%/50% |

Score → Payment:
- 90-100% → 100% of milestone amount
- 80-89% → 80% of milestone amount
- 70-79% → 70% of milestone amount
- Below 70% → Rejected (0%)

Display these thresholds in the UI so users understand the scoring system.

## DESIGN INSPIRATION

Make it look professional. Think:
- Clean card-based layout
- Progress bars for scores (color-coded: green 90+, blue 80+, yellow 70+, red <70)
- Step indicators for milestone progress
- Status badges with colors (open=blue, in_progress=yellow, verified=green, rejected=red)
- Score breakdown as horizontal bar chart or radial chart

## DO NOT

- Do not use any state management library (keep it simple with React state/context)
- Do not use localStorage or sessionStorage
- Do not hardcode contract addresses in source (use env vars)
- Do not skip error handling on contract calls
- Do not forget loading states for write transactions
- Do not use old GenLayer API patterns (gl.get_webpage, gl.exec_prompt, gl.eq_principle_strict_eq are DEPRECATED)
- Do not pay an EOA with `gl.ContractAt` (a removed v0.1.0 name) or `gl.get_contract_at` (IC-to-IC internal messages only). Both raise a VmError that rolls the whole call back — this silently broke every payout until 2026-07-20. Sending GEN to a wallet is an *external* message and needs an EVM contract interface:

```python
@gl.evm.contract_interface
class _Payee:
    class View: pass
    class Write: pass

_Payee(job.client).emit_transfer(value=u256(int(job.total_amount)))
```

- Do not assume a payout is visible once a transaction is ACCEPTED. Transfers to EOAs apply on FINALIZATION, which on Bradbury can take hours. The UI must not imply funds have arrived at acceptance.
- Do not declare a `u256` storage field — deployment fails with `invalid_contract`. Store `u64` and cast at the call site.

## BUILD ORDER

1. Set up Next.js project with TypeScript + Tailwind
2. Install genlayer-js: `npm install genlayer-js`
3. Create the GenLayer client setup in `lib/genlayer.ts`
4. Create TypeScript types for Job, Milestone, Scores
5. Build the contract interaction helpers in `lib/contract.ts`
6. Build pages in order: Homepage → Create Job → Job Detail → Reputation
7. Add wallet connection flow
8. Test the full flow end-to-end
9. Deploy frontend to Vercel
