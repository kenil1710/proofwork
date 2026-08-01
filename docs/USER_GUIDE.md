# ProofWork — User Guide

## For Clients (Job Posters)

### What you need to provide:

**1. Job Title**
Clear and specific. "Build a Portfolio Website" not "Make something cool."

**2. Requirements (IMPORTANT — this is what the AI evaluates against)**
Be detailed. The AI checks the deliverable against EXACTLY what you write here.

Good example:
```

Build a responsive portfolio website using React and Tailwind CSS.
Must include: homepage with hero section, about page, projects gallery
with filtering, contact form with email validation, dark/light mode toggle.
Mobile responsive. Deploy on Vercel.
```

Bad example:
```
Make me a nice website
```

**3. Mockup/Design URL (optional but recommended)**
This is how the AI compares visual output. Options:
- Figma public link (Share → Anyone with the link → Copy link)
- Hosted image URL of your wireframe/design
- A reference website URL you want it to look like
- Type `none` if this is a backend-only project

**4. Milestones**
Break the job into stages. Each milestone has a description and payment percentage.

Example:
```
Milestone 1: "Homepage and navigation setup" — 30%
Milestone 2: "All pages built with responsive design" — 40%  
Milestone 3: "Contact form, dark mode, deployment" — 30%
```

**5. GEN Deposit**
Total payment goes into escrow when you create the job.

**6. Deadline (in days)**
Every milestone must be verified before this passes. It is computed on chain
from the transaction's own clock, so it is fixed once the job exists.

Nothing happens automatically when it expires — work can still be submitted and
verified, and if you are happy to wait, do nothing. What expiry gives you is the
option to **abandon** the job (see below).

**7. Freelancer stake (0–50% of escrow)**
How much a freelancer must deposit *from their own wallet* to accept the job.
This is the anti-scam mechanism: without it, someone can accept your job, do
nothing, and cost you the whole delivery window at no cost to themselves.

| What happens | Where the stake goes |
|---|---|
| Every milestone verified | Returned to the freelancer with the final payment |
| A milestone is rejected | Stays locked — they resubmit and carry on |
| You abandon after the deadline | Forfeited to you |
| You cancel before anyone accepts | No stake exists yet |

Sensible starting points: **7 days / 10%** for a small first job, **14–30 days /
10–20%** for something substantial. If you are struggling to attract anyone,
lower the stake before you raise the pay. A stake of **0** is allowed and means
anyone can accept at no risk to themselves.

The 50% cap is deliberate: past roughly half the escrow, a stake stops deterring
no-shows and becomes a way to take more from a freelancer than the job pays —
the same scam running the other direction.

### Quick review or deep review

You pick one when you post the job. It sets **how much of the repository the AI
reviewer is handed** — not how strictly it judges what it sees. Both depths use
the same scoring bands and the same calibration.

| | Quick review (default) | Deep review |
|---|---|---|
| Files read | ~15, ranked by relevance | Up to 40 |
| How much of each | Excerpts; long files truncated | Most files whole |
| Evidence budget | Up to 36,000 characters | Up to 200,000 characters |
| Asked of the reviewer | Per-requirement citations | The same, plus a line per file and how they connect |
| Verification time | 27s and 55s, measured | 25s and 26s — no slower, despite ~2x the fetching |

Measured on `vercel/commerce` (65 source files): quick fills 10 slots with
30,000 characters and truncates the three largest files; deep fills 25 with
80,000 and reads them whole. On a small repository such as `Uniswap/v2-core`
(11 files) both read every file, and the difference is that quick truncates
`UniswapV2Pair.sol` at 6,000 of its 9,788 characters while deep reads all of it.

Two A/B pairs on that repository, identical but for the depth: quick scored
97 then 84, deep scored 97 both times, and deep's write-up ran 3,200-3,500
characters against quick's 1,400-1,500 — quick hit the 1,500-character cap and
was truncated mid-sentence. The scores are the same LLM on the same work, so
treat the spread as model variance rather than as a rule; what the depth
reliably changed was the evidence, not the number.

Choose deep when the milestone cannot be judged from a few files — a protocol
where the collateral check is in one contract and the liquidation path in
another. Choose quick for a landing page.

**The depth is fixed at creation.** Every validator has to derive the same
reading plan from stored state; if it could change, one node would read 40 files
while another read 15 and they would disagree about the evidence rather than
about the work.

### Abandoning a job

Once the deadline has passed **and at least one milestone is still unverified**,
you can abandon the job. You get back:

- whatever is left of the escrow, **plus**
- the freelancer's stake.

Milestones already verified are **not** clawed back — the freelancer keeps what
they actually delivered and loses only the stake. Because score bands can release
70% or 80% of a milestone rather than all of it, the leftover from partial
payouts stays in escrow and comes back to you as well.

Abandoning is your choice, not an automatic consequence. A freelancer who is late
but communicating is a negotiation; the contract just makes sure you are never
stuck waiting forever with your money locked up.

---

## For Freelancers (Workers)

### Before you accept: the stake and the deadline

Accepting a job may cost you money up front. If the client set a stake, you must
deposit **exactly** that amount from your own wallet in the same transaction —
the job page shows the figure on the Accept button. Accepting without it fails.

You get the stake back in full when every milestone is verified. You lose it if
the deadline passes with work still outstanding **and** the client chooses to
abandon the job.

So before accepting, check:

- **Can you finish inside the deadline?** The countdown on the job page is the
  chain's own clock, not your computer's.
- **Can you afford the stake?** It is locked until the job completes. A rejected
  milestone does not release it — only finishing does.
- **Is the escrow worth the risk?** A large stake on a small job is a bad trade.

If you are late but talking to the client, nothing happens automatically. The
client has to actively abandon the job to take your stake.

### What you need to submit per milestone:

**1. GitHub URL (required for code jobs)**
- Must be a PUBLIC repository
- Use the main repo page URL: `https://github.com/username/repo`
- The AI reads the code as text — it checks structure, quality, and whether it matches requirements
- Make sure your README is clear

**2. Deployed Site URL (required for frontend jobs)**
- Must be PUBLICLY accessible (no login required)
- The AI takes a SCREENSHOT and reads the page content
- Deploy on: Vercel, Netlify, GitHub Pages, Railway — anywhere public
- If your site has Cloudflare protection, it may block the AI — use a platform without it

**3. Mockup URL (same URL the client provided)**
- The AI screenshots BOTH your site AND the mockup, then compares them visually
- Type `none` if no mockup was provided

### What can you skip?

| Job Type | GitHub | Site URL | Mockup |
|---|---|---|---|
| Full-stack web app | Required | Required | Recommended |
| Backend/API only | Required | `none` | `none` |
| Design/frontend only | Optional | Required | Required |
| Smart contract | Required | `none` | `none` |

---

## How Scoring Works

### The 4 Criteria

| Check | What AI Does | How It Verifies |
|---|---|---|
| **Code Quality** | Reads GitHub repo as text | Checks structure, readability, patterns, obvious bugs |
| **Design Match** | Screenshots site AND mockup | Visually compares the two images side by side |
| **Functionality** | Screenshots site + reads content | Checks if features are present, page renders correctly |
| **Completeness** | Reads both code and site | Checks all requirements are addressed |

### Dynamic Weights

Weights adjust based on what evidence is provided:

| Evidence Provided | Code | Design | Functionality | Completeness |
|---|---|---|---|---|
| GitHub + Site + Mockup | 25% | 25% | 25% | 25% |
| GitHub + Site (no mockup) | 35% | 0% | 35% | 30% |
| GitHub only (backend) | 50% | 0% | 0% | 50% |
| Site only (no code) | 0% | 30% | 40% | 30% |

### Score → Payment

| Final Score | Payment Released | What Happens |
|---|---|---|
| 90-100% | 100% of milestone | Full payment |
| 80-89% | 80% of milestone | Good but room for improvement |
| 70-79% | 70% of milestone | Minimum acceptable quality |
| Below 70% | 0% — REJECTED | Freelancer can resubmit or appeal |

---

## Important Rules & Limitations

### URLs must be public
- Private GitHub repos → AI can't read them → code check fails
- Sites behind login → AI can't screenshot → functionality check fails
- Figma files must be shared publicly

### Cloudflare can block screenshots
- Some hosting platforms use Cloudflare protection
- This can block `gl.nondet.web.render()` from taking screenshots
- Use platforms like Vercel, Netlify, GitHub Pages that don't block bots

### Requirements matter
- Write detailed, specific requirements
- The AI scores AGAINST what you wrote
- Vague requirements = unpredictable scores

### Appeals
- Either party can appeal a verdict
- Appeal triggers MORE validators to re-evaluate
- Built into GenLayer's Optimistic Democracy — not a custom feature

### One-time evaluation
- Each `verify_milestone` call runs the AI evaluation once
- The score is final unless appealed
- Rejected milestones can be resubmitted with updated evidence

---

## FAQ

**Q: Can the AI run my code?**
A: No. The AI reads code as text. It checks structure, patterns, and whether it addresses the requirements. The deployed site URL is what proves the code works.

**Q: What if my site uses client-side rendering?**
A: The AI uses `web.render()` which renders JavaScript. Single-page apps (React, Vue, etc.) will render correctly.

**Q: What if the client writes bad requirements?**
A: The AI evaluates against what the client wrote. Vague requirements lead to unreliable scores. This incentivizes clients to be specific.

**Q: Can I resubmit a rejected milestone?**
A: Yes. Fix the issues and call `submit_milestone` again with updated URLs.

**Q: Who pays gas for verification?**
A: Anyone can call `verify_milestone`. Typically the freelancer triggers it after submitting evidence.

**Q: What if there's no frontend work?**
A: Set site_url and mockup_url to "none". The contract adjusts weights automatically — code and completeness get 50% each.
