import Link from "next/link";
import { CodeBlock, DocTable, GoodBad } from "@/components/docs/CodeBlock";
import { chain } from "@/lib/genlayer";

/**
 * Documentation content.
 *
 * Sourced from docs/USER_GUIDE.md, restructured so the reference material —
 * weights, bands, evidence requirements — is in tables you can scan rather
 * than prose you have to read twice. `keywords` backs the search box; it holds
 * the words someone would actually type, including ones that never appear in
 * the visible copy ("wallet", "money", "reject").
 */

export interface DocSection {
  id: string;
  title: string;
  /** Shown in the sidebar; kept short enough not to wrap on two lines. */
  navLabel: string;
  keywords: string;
  body: React.ReactNode;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 leading-relaxed text-surface-300">{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-10 text-lg font-medium text-surface-100">
      {children}
    </h3>
  );
}

function Callout({
  tone = "note",
  children,
}: {
  tone?: "note" | "warn";
  children: React.ReactNode;
}) {
  const styles =
    tone === "warn"
      ? "border-status-progress/30 bg-status-progress/5"
      : "border-orchid-400/25 bg-orchid-400/5";
  return (
    <div className={`mt-5 border p-4 ${styles}`}>
      <p className="text-sm leading-relaxed text-surface-300">{children}</p>
    </div>
  );
}

export const DOC_SECTIONS: DocSection[] = [
  {
    id: "what-is-proofwork",
    title: "What is ProofWork",
    navLabel: "What is ProofWork",
    keywords:
      "intro introduction overview what is proofwork escrow genlayer ai verified freelance trustless money wallet",
    body: (
      <>
        <P>
          ProofWork is freelance escrow where the payout is decided by evidence
          rather than by argument. A client locks GEN in a contract and writes
          down what the work has to do. A freelancer builds it and submits the
          evidence. AI validators then read that evidence, score it against the
          written requirements, and the score releases the money.
        </P>
        <P>
          The part worth understanding is that nobody adjudicates. There is no
          support queue deciding who to believe, because the release condition
          was written down before the work started and the contract applies it.
        </P>

        <H3>What makes it different</H3>
        <DocTable
          head={["", "Ordinary escrow", "ProofWork"]}
          rows={[
            [
              "Who decides",
              "A platform moderator, eventually",
              "Independent validators, on chain",
            ],
            [
              "What decides",
              "Whoever argues better",
              "The requirements text, written up front",
            ],
            [
              "Reputation",
              "Star ratings people type in",
              "Scores the contract recorded",
            ],
            ["Appeal", "Support ticket", "More validators re-run the evidence"],
          ]}
        />

        <Callout tone="warn">
          This runs on {chain.name}, a GenLayer test network. GEN here is free
          and has no real-world value — do not treat any of it as money.
        </Callout>
      </>
    ),
  },

  {
    id: "how-it-works",
    title: "How it works",
    navLabel: "How it works",
    keywords:
      "how it works deep dive lifecycle flow steps accept submit verify payout consensus validators rounds nudge stall",
    body: (
      <>
        <P>
          A job moves through four states, and each transition is a transaction
          somebody signs.
        </P>

        <DocTable
          head={["State", "Set by", "What it means"]}
          rows={[
            ["open", "create_job", "Escrow is locked. Anyone but the client can accept."],
            [
              "in_progress",
              "accept_job",
              "A freelancer owns the job and can submit milestones.",
            ],
            [
              "completed",
              "verify_milestone",
              "Every milestone verified. Reputation is written at this point.",
            ],
            [
              "cancelled",
              "cancel_job",
              "Client withdrew before anyone accepted. Escrow refunded.",
            ],
          ]}
        />

        <H3>What verification actually does</H3>
        <P>
          One validator — the leader — fetches the evidence and runs a single
          scoring pass over all four criteria. Every other validator
          independently re-fetches the same pages and confirms the score was
          based on what they can see too. If the evidence does not match, they
          disagree and the round rotates to a different set.
        </P>
        <Callout>
          This means a leader cannot invent evidence, point the scorer at a
          different page, or score a repository it never fetched. It does not
          mean validators re-score the work — the subjective judgement is the
          leader&rsquo;s, and the others verify the inputs it used.
        </Callout>

        <H3>Why transactions take a while</H3>
        <P>
          Verification renders web pages and runs a language model, so it is far
          slower than an ordinary transfer. Measured on Bradbury: an ordinary
          write settles in 10–40 seconds, a verification took 194 seconds.
        </P>
        <P>
          Consensus rounds on this testnet also stall — votes get committed and
          then nothing happens. The app detects that and sends a nudge to
          restart the round, which is why your wallet may prompt you more than
          once for a single action. Approving a nudge is safe and costs a little
          gas.
        </P>
      </>
    ),
  },

  {
    id: "for-clients",
    title: "For clients",
    navLabel: "For clients",
    keywords:
      "clients post job requirements milestones deposit escrow mockup figma design brief write good requirements percentages cancel refund quick review deep review depth thorough how many files read budget defi protocol",
    body: (
      <>
        <P>
          Everything you write in the requirements field is the specification
          validators score against. It is the single highest-leverage thing on
          the form — vague requirements do not produce lenient scores, they
          produce unpredictable ones.
        </P>

        <H3>Writing requirements that score well</H3>
        <GoodBad
          good={{
            // Lines kept short: this renders in a half-width column, and
            // anything longer wraps mid-sentence and reads as sloppy.
            code: `Responsive portfolio site in React
and Tailwind.

Must include:
- homepage with hero section
- about page
- projects gallery with filtering
- contact form with email validation
- dark/light mode toggle

Responsive down to 375px.
Deployed and publicly reachable.`,
          }}
          bad={{ code: `Make me a nice website` }}
        />
        <P>
          Name things that either exist or do not. &ldquo;Contact form with
          email validation&rdquo; can be checked; &ldquo;polished UX&rdquo;
          cannot, and a validator asked to score it will guess.
        </P>

        <H3>Milestones</H3>
        <P>
          Split the job into checkpoints, each with a description and a share of
          the escrow. Shares must total exactly 100. Each milestone is verified
          and paid on its own, so a freelancer is not waiting on the whole job
          to get paid for the first piece.
        </P>
        <CodeBlock
          label="A three-milestone split"
          plain
          code={`Homepage and navigation setup            30%
All pages built, responsive             40%
Contact form, dark mode, deployment     30%`}
        />
        <Callout tone="warn">
          Milestone descriptions cannot contain the <code>|</code> character.
          The contract uses it to separate them, so a stray pipe silently
          creates extra milestones and the transaction reverts.
        </Callout>

        <H3>Reference design</H3>
        <P>
          Optional, and only useful if you have one. A public Figma link, a
          hosted image of a wireframe, or a site you want it to resemble. Supply
          it and design match becomes a scored criterion; leave it out and its
          weight moves to the other three.
        </P>

        <H3>Quick review or deep review</H3>
        <P>
          You choose one when you post the job, and it applies to every
          milestone on it. It sets how much of the repository the AI reviewer is
          actually handed — which is a different question from how strictly it
          judges what it sees. Both depths use the same scoring bands and the
          same calibration; a deep review is not a harsher grader, it is a
          better-read one.
        </P>
        <DocTable
          head={["", "Quick review — default", "Deep review"]}
          rows={[
            ["Files read", "Around 15, ranked by relevance", "Up to 40"],
            [
              "How much of each",
              "Excerpts — long files are truncated",
              "Most files whole",
            ],
            ["Evidence budget", "Up to 36,000 characters", "Up to 200,000 characters"],
            [
              "What the reviewer is asked for",
              "Per-requirement citations",
              "The same, plus a line accounting for every file and how they connect",
            ],
            [
              "Verification time",
              "27s and 55s, measured",
              "25s and 26s — no slower here, though it fetches roughly twice as much",
            ],
            [
              "Worth it for",
              "Small and medium work turning on a handful of files",
              "High-value work — DeFi protocols, large dApps — where behaviour spans files",
            ],
          ]}
        />
        <P>
          The honest test is whether the milestone can be judged from a few
          files. A landing page can; a lending protocol where the collateral
          check lives in one contract and the liquidation path in another cannot
          — a quick review sees each file&rsquo;s first few thousand characters
          and cannot follow the call between them.
        </P>
        <Callout tone="warn">
          The depth is fixed at creation and cannot be changed later, not even
          by re-running verification. Every validator has to derive the same
          reading plan from the job&rsquo;s stored state — if the depth could
          move, one node would read 40 files while another read 15, and they
          would disagree about evidence rather than about the work.
        </Callout>

        <H3>Cancelling</H3>
        <P>
          You can cancel while a job is still <code>open</code> and the escrow
          is refunded in full. Once a freelancer has accepted, you cannot — the
          money is committed to the work.
        </P>
        <Callout tone="warn">
          A <code>create_job</code> that reverts keeps the deposit. There is no
          job record afterwards, so nothing can refund it. Check that the
          milestone total reads 100 before you sign.
        </Callout>
      </>
    ),
  },

  {
    id: "for-freelancers",
    title: "For freelancers",
    navLabel: "For freelancers",
    keywords:
      "freelancers submit evidence github repo url site deployed mockup public private cloudflare screenshot resubmit rejected accept job insufficient evidence not scored verification stopped could not read repository rate limited retry",
    body: (
      <>
        <P>
          You submit evidence per milestone: a repository, a deployed site, and
          a mockup. At least one of the repository or the site is required —
          validators need something to look at.
        </P>

        <H3>What to supply</H3>
        <DocTable
          head={["Job type", "Repository", "Site", "Mockup"]}
          rows={[
            ["Full-stack web app", "Required", "Required", "Recommended"],
            ["Backend or API only", "Required", "none", "none"],
            ["Design or frontend only", "Optional", "Required", "Required"],
            ["Smart contract", "Required", "none", "none"],
          ]}
        />

        <H3>Everything must be publicly reachable</H3>
        <P>
          This is the most common reason a verification fails. Validators fetch
          your URLs anonymously, with no session and no credentials.
        </P>
        <DocTable
          head={["Problem", "What happens"]}
          rows={[
            [
              "Private repository",
              "The repository cannot even be listed, so verification stops with insufficient evidence. Nothing is scored and the milestone stays submitted",
            ],
            [
              "Repository readable but its files are not",
              "If too few files come back, verification stops rather than scoring what little it saw",
            ],
            [
              "Site behind a login",
              "The page cannot be rendered. With a repository supplied the milestone is still scored on that; with no other evidence, verification stops",
            ],
            ["Figma not shared publicly", "Design match cannot be assessed"],
            [
              "Host uses bot protection",
              "Screenshots get blocked. Vercel, Netlify and GitHub Pages are safe; some hosts front everything with a challenge page",
            ],
          ]}
        />

        <H3>How much of your repository gets read</H3>
        <P>
          The client chose a review depth when they posted the job, and it is
          shown on the job page. It decides how much of the repository the
          reviewer is handed — which is worth knowing before you submit, because
          it is what separates &ldquo;that file was reviewed&rdquo; from
          &ldquo;that file exists but was not read&rdquo;.
        </P>
        <DocTable
          head={["Depth", "What the reviewer sees", "Put your work where"]}
          rows={[
            [
              "Quick review",
              "Around 15 files, ranked by relevance to the milestone, most of them as excerpts",
              "The files that implement the milestone should be obvious from its description — that is what the ranking reads",
            ],
            [
              "Deep review",
              "Up to 40 files, most of them whole, plus a demand to account for each one and for how they connect",
              "Cross-file work pays off here: a guard in one file used by another is visible",
            ],
          ]}
        />

        <H3>Insufficient evidence is not a bad score</H3>
        <P>
          These two outcomes look similar from the button and are completely
          different underneath. A <strong>score</strong> means validators read
          your work and judged it. <strong>Insufficient evidence</strong> means
          they could not read enough of it to judge anything, so the contract
          refuses to score rather than publishing a low number that reads like a
          verdict on your work.
        </P>
        <DocTable
          head={["Outcome", "Milestone becomes", "What to do"]}
          rows={[
            ["Scored 70 or above", "Verified, and its share pays out", "Nothing"],
            [
              "Scored below 70",
              "Rejected — the work was read and found short",
              "Improve the work and submit again",
            ],
            [
              "Insufficient evidence",
              "Unchanged: still submitted, nothing recorded",
              "Fix the URL or its permissions, then verify again — no resubmission needed",
            ],
          ]}
        />
        <P>
          Nothing is spent from escrow when verification stops this way, and no
          score is written against your reputation. It costs only the gas of the
          attempt, so retrying after fixing access is cheap. A verification that
          fails because GitHub was briefly unreachable or rate-limited behaves
          the same way — wait a moment and trigger it again.
        </P>

        <H3>If a milestone is rejected</H3>
        <P>
          Scoring below 70 rejects the milestone and releases nothing, but it
          does not end the job. Fix the work, submit the milestone again with
          updated URLs, and it is re-verified from scratch.
        </P>

        <H3>Who pays for verification</H3>
        <P>
          Anyone can trigger it and whoever does pays the gas. Usually that is
          you, straight after submitting, because you want the milestone
          assessed.
        </P>
      </>
    ),
  },

  {
    id: "scoring",
    title: "Scoring system",
    navLabel: "Scoring system",
    keywords:
      "scoring score criteria weights code quality design match functionality completeness payout bands 90 80 70 rejected percentage weighted final example verdict sample output worked example get_milestone json what a verdict looks like",
    body: (
      <>
        <P>
          Four criteria, each scored 0–100, combined into one weighted final. The
          weights are not fixed — they follow the evidence you actually
          supplied, so a backend job is never marked down for having no design.
        </P>

        <H3>The four criteria</H3>
        <DocTable
          head={["Criterion", "What it reads", "What it judges"]}
          rows={[
            [
              "Code quality",
              "The repository, as text",
              "Structure, readability, obvious bugs, and whether the code addresses the requirements",
            ],
            [
              "Design match",
              "Screenshots of the site and the mockup",
              "How closely the built site matches the intended design in layout, colour and typography",
            ],
            [
              "Functionality",
              "The rendered site",
              "Whether it loads, the stated features are present, and the content matches the spec",
            ],
            [
              "Completeness",
              "Code and site together",
              "What fraction of the milestone is actually delivered rather than stubbed",
            ],
          ]}
        />

        <H3>How weights move</H3>
        <DocTable
          head={["Evidence supplied", "Code", "Design", "Function", "Complete"]}
          rows={[
            ["Repository + site + mockup", "25%", "25%", "25%", "25%"],
            ["Repository + site", "35%", "—", "35%", "30%"],
            ["Repository only", "50%", "—", "—", "50%"],
            ["Site + mockup", "—", "30%", "40%", "30%"],
            ["Site only", "—", "—", "50%", "50%"],
          ]}
        />

        <H3>What the final score pays</H3>
        <DocTable
          head={["Final score", "Released", "Meaning"]}
          rows={[
            ["90 – 100", "100% of the milestone", "Meets the milestone in full"],
            ["80 – 89", "80%", "Meets it with minor gaps"],
            ["70 – 79", "70%", "Substantially delivered, real gaps remain"],
            [
              "Below 70",
              "Nothing — rejected",
              "Key parts missing or broken. Resubmit after fixing",
            ],
          ]}
        />

        <H3>What a verdict looks like</H3>
        <P>
          The figures below are invented — no job produced them. The arithmetic
          around them is not: it is exactly what the contract runs. Take a
          milestone submitted with a repository, a live site and a mockup, so
          all four criteria carry 25%.
        </P>
        <DocTable
          head={["Criterion", "Score", "Weight", "Contributes"]}
          rows={[
            ["Code quality", "85", "25%", "21.25"],
            ["Design match", "90", "25%", "22.50"],
            ["Functionality", "80", "25%", "20.00"],
            ["Completeness", "88", "25%", "22.00"],
          ]}
        />
        <P>
          Those contributions total 85.75, and the contract works in whole
          numbers, so the final score is 85. That lands in the 80–89 band, and
          the milestone releases 80% of its share of the escrow. A single strong
          criterion cannot carry a weak one across a band boundary — the weights
          decide how much each is allowed to move the result.
        </P>
        <CodeBlock
          label="What get_milestone returns for that verdict"
          code={`{
  "description": "Homepage and navigation",
  "percentage": 30,
  "status": "verified",
  "github_url": "https://github.com/example/portfolio",
  "site_url": "https://example.vercel.app",
  "mockup_url": "https://figma.com/file/example",
  "scores": {
    "code_quality": 85,
    "design_match": 90,
    "functionality": 80,
    "completeness": 88,
    "final_weighted": 85
  }
}`}
        />

        <H3>The same milestone with less evidence</H3>
        <P>
          Submit only a repository and the two criteria that need a rendered
          page drop out entirely. The remaining two split the whole weight
          between them, so each one now moves the final score twice as far.
        </P>
        <CodeBlock
          label="Worked example — repository only, no site"
          code={`code_quality  = 90    # weight 50%
completeness  = 80    # weight 50%

final = (90 * 50 + 80 * 50) / 100 = 85

# 85 falls in the 80-89 band, so the milestone
# releases 80% of its share of the escrow.`}
        />
      </>
    ),
  },

  {
    id: "deadlines-and-stakes",
    title: "Deadlines and stakes",
    navLabel: "Deadlines & stakes",
    keywords:
      "deadline stake abandon anti-scam scam countdown forfeit penalty accept deposit collateral timeout expired overdue reclaim escrow no-show ghosting",
    body: (
      <>
        <P>
          Scoring settles whether work was <em className="text-surface-200">good</em>.
          It says nothing about work that never arrives. A freelancer could
          accept a job, do nothing, and cost the client the whole delivery
          window at no cost to themselves. Two things close that gap: every job
          carries a deadline, and accepting one can require a stake.
        </P>

        <H3>The deadline</H3>
        <P>
          The client sets it when posting, as a number of days. The contract
          stores an absolute time computed from the transaction&rsquo;s own
          clock, so it is fixed on chain — not something a browser can
          reinterpret. Every milestone must be verified before it passes.
        </P>
        <P>
          Nothing happens automatically when a deadline expires. Work can still
          be submitted and verified, and if the client is happy to wait, they
          simply do not act. What expiry does is unlock one option for the
          client, described below.
        </P>

        <H3>The stake</H3>
        <P>
          The client also sets a stake, as a percentage of the escrow, capped at
          50%. A freelancer accepting the job must deposit exactly that amount
          from their own wallet in the same transaction. Accepting without it
          fails.
        </P>
        <DocTable
          head={["What happens", "Where the stake goes"]}
          rows={[
            ["Every milestone verified", "Returned in full with the final payment"],
            ["A milestone is rejected", "Stays locked — resubmit and carry on"],
            ["Client abandons after the deadline", "Forfeited to the client"],
            ["Client cancels before anyone accepts", "No stake exists yet"],
          ]}
        />
        <P>
          The cap matters. Past roughly half the escrow a stake stops deterring
          no-shows and becomes a way for a client to take more from a freelancer
          than the job pays — the same scam running the other direction.
        </P>

        <H3>Abandoning a job</H3>
        <P>
          Once the deadline has passed with at least one milestone still
          unverified, the client can abandon the job. That returns whatever is
          left of the escrow plus the freelancer&rsquo;s stake, and closes the
          job as <em className="text-surface-200">abandoned</em>.
        </P>
        <P>
          Milestones already verified are not clawed back. The freelancer keeps
          what they actually delivered and loses only the stake. And because
          score bands can release 70% or 80% of a milestone rather than all of
          it, the leftover from partial payouts stays in escrow and returns to
          the client too.
        </P>
        <Callout>
          Abandoning is the client&rsquo;s choice, not an automatic
          consequence. A freelancer who is late but communicating is a
          negotiation; the contract just makes sure the client is not stuck
          waiting forever with their money locked up.
        </Callout>

        <H3>Choosing numbers</H3>
        <DocTable
          head={["If you are", "Reasonable starting point"]}
          rows={[
            ["Posting a small first job", "7 days, 10% stake"],
            ["Posting something substantial", "14–30 days, 10–20% stake"],
            ["Struggling to attract freelancers", "Lower the stake before raising the pay"],
            ["Worried about no-shows specifically", "Raise the stake, keep the deadline generous"],
          ]}
        />
        <P>
          A stake of 0 is allowed and means anyone can accept at no risk to
          themselves. That is fine for a job where you would rather have a wide
          pool than a filtered one.
        </P>
      </>
    ),
  },

  {
    id: "reputation",
    title: "Reputation",
    navLabel: "Reputation",
    keywords:
      "reputation score history average jobs completed address track record freelancer rating on chain",
    body: (
      <>
        <P>
          Reputation is a record of assessed work, not a rating anyone typed in.
          Each entry is a score validators produced from evidence, written to the
          chain when a job finished.
        </P>

        <H3>What gets recorded</H3>
        <P>
          One entry per completed job — specifically the score of the milestone
          that finished it. A job only counts once{" "}
          <em className="text-surface-200">every</em> one of its milestones has
          been verified, so a freelancer part-way through their first job still
          reads as zero.
        </P>
        <CodeBlock
          label="What get_reputation returns"
          code={`{
  "address": "0x8415…8525",
  "jobs_completed": 1,
  "avg_score": 85,
  "scores": [85]
}`}
        />
        <P>
          Look anyone up by address on the{" "}
          <Link
            href="/reputation"
            className="text-orchid-400 transition-colors hover:text-orchid-300"
          >
            reputation page
          </Link>
          . It is public and permissionless — no account required.
        </P>
      </>
    ),
  },

  {
    id: "faq",
    title: "FAQ",
    navLabel: "FAQ",
    keywords:
      "faq questions answers can the ai run my code spa react rendering bad requirements resubmit gas who pays no frontend appeal dispute insufficient evidence could not be read scored badly",
    body: (
      <>
        <Faq
          q="Can the AI run my code?"
          a="No. It reads the code as text and judges structure, patterns, and whether it addresses the requirements. Your deployed site URL is what demonstrates the code actually works."
        />
        <Faq
          q="What if my site is a single-page app?"
          a="It renders fine. Validators use a real renderer that executes JavaScript, so React, Vue and similar frameworks are read the way a browser would see them."
        />
        <Faq
          q="What if the client wrote bad requirements?"
          a="The score is measured against what they wrote, so vague requirements produce unreliable scores. That is the incentive for clients to be specific — it is not something the system can paper over."
        />
        <Faq
          q="Can I resubmit a rejected milestone?"
          a="Yes. Submit it again with updated URLs and it is verified from scratch. Rejection releases nothing but does not end the job."
        />
        <Faq
          q="Verification failed saying the evidence could not be read. Was I scored badly?"
          a="No — nothing was scored. When too little of the repository or site can be read, the contract stops instead of publishing a number that would look like a judgement on your work. The milestone stays submitted, no score is recorded, and nothing leaves escrow. Fix the access problem and verify again; there is no need to resubmit."
        />
        <Faq
          q="Who pays gas for verification?"
          a="Whoever triggers it. Anyone can, but it is usually the freelancer straight after submitting."
        />
        <Faq
          q="What if there is no frontend work?"
          a="Submit the repository and leave the site and mockup blank. The weights move automatically — code quality and completeness take 50% each."
        />
        <Faq
          q="Why did my wallet prompt me twice for one action?"
          a="Consensus rounds on this testnet stall. The app sends a nudge to restart a stalled round, and that nudge is its own transaction. It is safe to approve and costs a little gas."
        />
        <Faq
          q="My milestone says verified but the balance has not changed."
          a="Payouts leave escrow on finalization, which happens later than acceptance — on this testnet it can take hours. The verdict is settled; the transfer is still pending."
        />
      </>
    ),
  },
];

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <div className="border-b border-surface-800 py-5 last:border-0">
      <p className="text-base text-surface-100">{q}</p>
      <p className="mt-2 leading-relaxed text-surface-400">{a}</p>
    </div>
  );
}
