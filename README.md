# ProofWork — AI-Verified Freelance Escrow on GenLayer

ProofWork is a trustless freelance escrow platform where GenLayer Intelligent Contracts verify deliverables using code analysis, visual design comparison, and multi-criteria AI scoring — replacing subjective disputes with consensus-backed verdicts.

## The Problem

Freelancing is broken:

- **Clients** pay for work and have no guarantee of quality
- **Freelancers** deliver work and risk not getting paid
- **Platforms** (Upwork, Fiverr) take 20% cuts and disputes take weeks
- **Escrow alone** doesn't solve quality — someone still has to judge "was this good enough?"

Traditional escrow holds funds but can't evaluate whether a deliverable actually meets the spec. That requires human judgment — exactly what GenLayer was built for.

## How ProofWork Solves It

1. **Client** creates a job with requirements and milestones, deposits GEN into escrow
2. **Freelancer** accepts the job and works through milestones
3. **Freelancer** submits evidence: GitHub repo link, deployed site URL, and mockup/design URL
4. **Intelligent Contract** verifies the work using 4 AI-powered checks:
   - **Code Quality** (25%) — fetches code from GitHub, evaluates structure and correctness
   - **Design Match** (25%) — screenshots deployed site AND mockup, compares them visually
   - **Functionality** (25%) — checks if the site loads, renders, and has required features
   - **Completeness** (25%) — evaluates overall milestone completion against requirements
5. **Validators** independently perform the same checks and reach consensus
6. **Score determines payment**: 90%+ = full pay, 80-89% = 80% pay, 70-79% = 70% pay, <70% = rejected
7. **Freelancer builds on-chain reputation** from completed job scores

## Why GenLayer (Not a Regular Backend)

- The **escrow decision** must not depend on either party's server — GenLayer validators are neutral
- **Web fetching** happens inside the contract — code from GitHub, screenshots from deployed sites
- **Image comparison** via `gl.nondet.exec_prompt(images=[...])` — validators compare mockup vs reality
- **Multi-validator consensus** ensures no single AI model's bias determines the outcome
- **Appeals** are built into Optimistic Democracy — either party can challenge a verdict

A regular backend AI could do the analysis. But the **trust** that neither party manipulated the result — that's what only GenLayer provides.

## Architecture

```
Frontend (Next.js + GenLayerJS SDK)
    │
    ├── Client: Create Job → Define Milestones → Deposit GEN
    ├── Freelancer: Accept Job → Submit Evidence → View Scores
    └── Anyone: View Reputation
    │
    ▼
Intelligent Contract (ProofWork.py)
    │
    ├── create_job() ──────── payable, stores milestones
    ├── accept_job() ──────── freelancer claims the job
    ├── submit_milestone() ── freelancer provides evidence URLs
    ├── verify_milestone() ── THE CORE: 4-criteria AI verification
    │   ├── gl.nondet.web.render(github_url, mode="text")
    │   ├── gl.nondet.web.render(site_url, mode="screenshot")
    │   ├── gl.nondet.web.render(mockup_url, mode="screenshot")
    │   ├── gl.nondet.exec_prompt(images=[site, mockup])
    │   └── Score → Payment release
    ├── cancel_job() ──────── client refund for open jobs
    ├── get_job() ─────────── view job details
    ├── get_milestone() ───── view milestone scores
    └── get_reputation() ──── view freelancer track record
```

## Scoring Rubric

| Criteria | Weight | What Gets Evaluated |
|---|---|---|
| Code Quality | 25% | Structure, readability, bugs, best practices |
| Design Match | 25% | Visual comparison: mockup screenshot vs deployed site screenshot |
| Functionality | 25% | Site loads, features present, content matches spec |
| Completeness | 25% | All requirements addressed, documentation, edge cases |

### Score → Payment

| Final Score | Payment | Status |
|---|---|---|
| 90–100% | 100% of milestone amount | Verified |
| 80–89% | 80% of milestone amount | Verified |
| 70–79% | 70% of milestone amount | Verified |
| Below 70% | 0% — resubmit or appeal | Rejected |

## What Makes This Different

| Feature | AutoBounty | Apolo | BuildersClaw | **ProofWork** |
|---|---|---|---|---|
| Code verification | ✅ PR vs Issue | ❌ | ✅ Challenge eval | ✅ Full repo review |
| Visual comparison | ❌ | ❌ | ❌ | ✅ Screenshot vs mockup |
| Image processing | ❌ | ❌ | ❌ | ✅ `exec_prompt(images=[])` |
| Multi-criteria scoring | ❌ | ❌ (YES/NO) | ❌ | ✅ 4 weighted criteria |
| Milestone-based | ❌ | ❌ | ❌ | ✅ Progressive releases |
| Reputation system | ❌ | ❌ | ❌ | ✅ On-chain scores |
| Partial payment | ❌ | ❌ | ❌ | ✅ Score-based % |

## Setup & Deployment

### Prerequisites

- Node.js 18+
- npm

### Quick Start (GenLayer Studio)

1. Go to [studio.genlayer.com](https://studio.genlayer.com)
2. Paste `contracts/proof_work.py` into the editor
3. Deploy to Studionet or Bradbury
4. Interact with Write Methods

### CLI Deployment (Bradbury Testnet)

```bash
# Install GenLayer CLI
npm install -g genlayer

# Initialize project
genlayer init

# Deploy contract
genlayer deploy --contract contracts/proof_work.py --network bradbury
```

### Frontend Setup

```bash
cd frontend
cp .env.example .env
# Add your deployed contract address to .env
npm install
npm run dev
```

## Contract Methods

### Write Methods

| Method | Caller | Description |
|---|---|---|
| `create_job` | Client | Create job with milestones, deposit GEN |
| `accept_job` | Freelancer | Accept an open job |
| `submit_milestone` | Freelancer | Submit GitHub, site, mockup URLs |
| `verify_milestone` | Anyone | Trigger AI verification |
| `cancel_job` | Client | Cancel open job, refund escrow |

### View Methods

| Method | Returns |
|---|---|
| `get_job` | Job details (client, freelancer, status, amounts) |
| `get_milestone` | Milestone details with all 4 scores |
| `get_reputation` | Freelancer's score history and average |
| `get_job_count` | Total jobs created |

## Tech Stack

- **Contract**: Python (GenLayer Intelligent Contract)
- **Frontend**: Next.js + TypeScript + GenLayerJS SDK
- **Verification**: `gl.nondet.web.render()` + `gl.nondet.exec_prompt(images=[...])`
- **Consensus**: `gl.eq_principle.prompt_non_comparative()` with per-criteria evaluation
- **Network**: GenLayer Bradbury Testnet

## Links

- **Live Demo**: [TBD]
- **Contract on Explorer**: [TBD]
- **Demo Video**: [TBD]
- **Twitter/X Post**: [TBD]

## License

MIT
