import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import {
  PAYOUT_SNIPPET,
  TerminalWindow,
} from "@/components/landing/TerminalWindow";
import { HeroSphere } from "@/components/landing/HeroSphere";
import { CONTRACT_ADDRESS, explorerUrl } from "@/lib/genlayer";
import { PAYOUT_BANDS } from "@/types";

/**
 * Marketing landing page. Deliberately reads nothing from the chain, so the
 * page is fully static, never shows a loading state, and cannot be wrong when
 * the node is down. Live data lives at /app.
 *
 * It also shows no example figures at all. Every number that survives here is a
 * rule the contract enforces — the pass threshold, the payout bands, the count
 * of criteria — never a sample score, because a visitor cannot tell an
 * illustrative 85 from a real one and a caption saying "example" does not stop
 * them reading it as a result the product produced. Worked verdicts live in
 * /docs, where the surrounding text makes their status unmistakable.
 */

const BADGES = ["Verified", "Secure", "Autonomous"] as const;

const STATS = [
  { value: "4", label: "Scoring criteria", detail: "code · design · function · completeness" },
  { value: "0", label: "Human arbitrators", detail: "nobody adjudicates" },
  { value: "70", label: "Score to get paid", detail: "below that, resubmit" },
  { value: "24/7", label: "On chain", detail: "no business hours" },
] as const;

const STEPS = [
  {
    title: "Post the job",
    actor: "Client",
    body: "Write what the work has to do, split it into milestones, and lock the GEN in escrow. That text becomes the specification every validator scores against.",
  },
  {
    title: "Accept and build",
    actor: "Freelancer",
    body: "Any wallet but the client's can take an open job. When a milestone is done, submit the evidence: a repository, a deployed URL, a mockup.",
  },
  {
    title: "Validators verify",
    actor: "GenLayer",
    body: "Independent validators fetch the repository and render the site, score it against the requirements, and confirm they all saw the same evidence.",
  },
  {
    title: "Escrow releases",
    actor: "Contract",
    body: "The weighted score decides the payout with nobody in the middle. Above 70 releases the milestone's share; below it, the work is resubmitted.",
  },
] as const;

const CRITERIA = [
  {
    label: "Code quality",
    detail: "Structure, readability, obvious bugs, and whether the code addresses the spec.",
    reads: "Reads the repository as text",
  },
  {
    label: "Design match",
    detail: "Holds the site and the mockup together and compares layout, colour, and typography.",
    reads: "Screenshots the site and the mockup",
  },
  {
    label: "Functionality",
    detail: "Whether the page loads and the stated features are actually present.",
    reads: "Renders the deployed site",
  },
  {
    label: "Completeness",
    detail: "How much of the milestone is delivered, versus stubbed or missing.",
    reads: "Reads code and site together",
  },
] as const;

const WHY = [
  {
    title: "Decentralized AI consensus",
    body: "The verdict comes from independent validators agreeing on chain, not from a support queue at a marketplace deciding who it believes today.",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <circle cx="4" cy="6" r="2" />
        <circle cx="20" cy="6" r="2" />
        <circle cx="4" cy="18" r="2" />
        <circle cx="20" cy="18" r="2" />
        <path d="M6 7l4 3M18 7l-4 3M6 17l4-3M18 17l-4-3" />
      </>
    ),
  },
  {
    title: "On-chain reputation",
    body: "Every score is written to the chain against the freelancer's address. It is a record of assessed work, not a star rating somebody typed in.",
    icon: (
      <>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </>
    ),
  },
  {
    title: "No human disputes",
    body: "The contract holds the money and the payout follows the score. There is nothing to argue about, because the release rule was agreed before the work began.",
    icon: (
      <>
        <path d="M12 3l8 4v5c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V7z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
] as const;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="eyebrow text-orchid-400">
      {children}
    </p>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-5 max-w-3xl text-3xl leading-tight font-semibold tracking-tight text-surface-100 sm:text-4xl">
      {children}
    </h2>
  );
}

export default function Home() {
  return (
    <main className="flex-1">
      {/* ── 1. Hero ──────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-surface-800/60">
        {/* No ambient wash behind this section: the sphere is the hero's only
            visual, and the finish is matte throughout — no bloom, no light
            pools. Absolutely positioned rather than a grid cell so the render
            can use the section's full height. */}
        <HeroSphere />

        <div className="relative mx-auto flex min-h-[88svh] w-full max-w-6xl flex-col justify-center px-6 py-20">
          <div className="grid items-center gap-16 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <Reveal>
                <div className="flex flex-wrap gap-2">
                  {BADGES.map((badge) => (
                    <span
                      key={badge}
                      className="rounded-full border border-orchid-400/25 bg-orchid-400/10 px-3 py-1 text-xs font-medium text-orchid-200"
                    >
                      {badge}
                    </span>
                  ))}
                </div>
              </Reveal>

              <Reveal delayMs={60}>
                {/* `.title-hero` carries the weight and the negative tracking a
                    grotesque needs at this size — set it loose and the words
                    drift apart. */}
                <h1 className="title-hero mt-8 text-5xl text-surface-100 sm:text-6xl lg:text-7xl">
                  Get paid on the evidence.
                  <span className="mt-2 block text-orchid-400">
                    Not on the argument.
                  </span>
                </h1>
              </Reveal>

              <Reveal delayMs={120}>
                <p className="mt-8 max-w-xl text-sm leading-relaxed text-surface-400 sm:text-base">
                  Freelance escrow where AI validators read the repository,
                  render the site, and score the work against the requirements
                  the client wrote. The score releases the money.
                </p>
              </Reveal>

              <Reveal delayMs={180}>
                <div className="mt-10 flex flex-wrap items-center gap-3">
                  <Link href="/app" className="btn btn-primary">
                    Launch app
                  </Link>
                  <Link href="/docs" className="btn btn-ghost">
                    Read docs
                  </Link>
                </div>
              </Reveal>
            </div>

            {/* Empty column: the sphere fills this half from the section layer
                above, so the grid only has to reserve the space. */}
            <div aria-hidden className="hidden md:block" />
          </div>
        </div>
      </section>

      {/* ── 2. Stats bar ─────────────────────────────────────────────────── */}
      <section className="border-b border-surface-800/60 bg-surface-900/20">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-px px-6 lg:grid-cols-4">
          {STATS.map((stat, index) => (
            <Reveal key={stat.label} delayMs={index * 60}>
              <div className="px-2 py-10 text-center lg:px-6">
                <p className="title-hero text-4xl text-orchid-400 tabular-nums sm:text-5xl">
                  {stat.value}
                </p>
                <p className="mt-3 text-xs tracking-[0.2em] text-surface-200 uppercase">
                  {stat.label}
                </p>
                <p className="mt-1.5 text-[11px] text-surface-600">
                  {stat.detail}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── 3. How it works ──────────────────────────────────────────────── */}
      <section id="how-it-works" className="scroll-mt-20 border-b border-surface-800/60">
        <div className="mx-auto w-full max-w-6xl px-6 py-24">
          <Reveal>
            <Eyebrow>Protocol flow</Eyebrow>
            <SectionHeading>
              Four steps, and only one involves trusting anybody.
            </SectionHeading>
          </Reveal>

          <ol className="relative mt-16 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {/* Connector, drawn behind the cards on wide screens only — at
                narrow widths the cards stack and a horizontal rail would point
                nowhere. */}
            <div
              aria-hidden
              className="absolute top-[3.25rem] right-0 left-0 hidden h-px bg-gradient-to-r from-transparent via-orchid-400/25 to-transparent lg:block"
            />

            {STEPS.map((step, index) => (
              <Reveal as="li" key={step.title} delayMs={index * 80}>
                <div className="card relative h-full p-6">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-orchid-400/40 bg-surface-950 text-sm text-orchid-300">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[10px] tracking-[0.22em] text-surface-600 uppercase">
                      {step.actor}
                    </span>
                  </div>
                  <h3 className="mt-5 text-lg font-medium text-surface-100">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-surface-400">
                    {step.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ── 4. Verification protocol ─────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-surface-800/60 bg-surface-900/20">
        <div className="relative mx-auto w-full max-w-6xl px-6 py-24">
          <Reveal>
            <Eyebrow>The verification protocol</Eyebrow>
            <SectionHeading>Every score shows its working.</SectionHeading>
            <p className="mt-6 max-w-2xl leading-relaxed text-surface-400">
              Four criteria, each weighted by the evidence actually supplied. A
              backend job with no site is never marked down for design — the
              weights move instead.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-4 md:grid-cols-2">
            {CRITERIA.map((criterion, index) => (
              <Reveal key={criterion.label} delayMs={index * 70}>
                {/* Column layout so the "what it reads" line sits on the floor
                    of every card, aligned across the row regardless of how far
                    the description above it wraps. */}
                <div className="card flex h-full flex-col p-6">
                  <h3 className="text-base font-medium text-surface-100">
                    {criterion.label}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-surface-400">
                    {criterion.detail}
                  </p>

                  <div className="mt-auto pt-6">
                    <div
                      aria-hidden
                      className="h-px bg-gradient-to-r from-orchid-400/40 to-transparent"
                    />
                    <p className="mt-4 text-[11px] tracking-[0.15em] text-surface-600 uppercase">
                      {criterion.reads}
                    </p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delayMs={80}>
            <div className="mt-16">
              <h3 className="text-lg font-medium text-surface-100">
                What a score releases
              </h3>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-surface-400">
                These are thresholds, not results. They are written into the
                contract, apply identically to every milestone on the platform,
                and are known before any work begins.
              </p>

              <div className="mt-6 grid gap-px border border-surface-800 sm:grid-cols-4">
                {PAYOUT_BANDS.map((band) => (
                  <div key={band.min} className="bg-surface-950/60 px-5 py-6">
                    <p className="text-xs tracking-[0.18em] text-surface-500 uppercase">
                      {band.min === 0
                        ? "Below 70"
                        : `${band.min}–${band.min === 90 ? 100 : band.min + 9}`}
                    </p>
                    <p
                      className={`title-hero mt-2 text-3xl tabular-nums ${
                        band.payoutPct === 0
                          ? "text-status-rejected"
                          : "text-orchid-400"
                      }`}
                    >
                      {band.payoutPct === 0 ? "—" : `${band.payoutPct}%`}
                    </p>
                    <p className="mt-2 text-[11px] text-surface-600">
                      {band.payoutPct === 0
                        ? "Rejected · resubmit"
                        : "of the milestone"}
                    </p>
                  </div>
                ))}
              </div>

              <Link
                href="/docs#scoring"
                className="mt-6 inline-block text-xs tracking-[0.15em] text-orchid-400 uppercase transition-colors hover:text-orchid-300"
              >
                See a milestone scored end to end →
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 5. Why GenLayer ──────────────────────────────────────────────── */}
      <section className="border-b border-surface-800/60">
        <div className="mx-auto w-full max-w-6xl px-6 py-24">
          <Reveal>
            <Eyebrow>Why GenLayer</Eyebrow>
            <SectionHeading>
              Not another escrow. Actual AI-verified trust.
            </SectionHeading>
          </Reveal>

          <div className="mt-16 grid gap-4 md:grid-cols-3">
            {WHY.map((item, index) => (
              <Reveal key={item.title} delayMs={index * 80}>
                <div className="card h-full p-8">
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    strokeWidth="1.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-8 w-8 stroke-orchid-400"
                  >
                    {item.icon}
                  </svg>
                  <h3 className="mt-6 text-lg font-medium text-surface-100">
                    {item.title}
                  </h3>
                  <p className="mt-3 leading-relaxed text-surface-400">
                    {item.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 6. Code showcase ─────────────────────────────────────────────── */}
      <section className="border-b border-surface-800/60 bg-surface-900/20">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-6 py-24 lg:grid-cols-[0.85fr_1.15fr]">
          <Reveal>
            <Eyebrow>On chain</Eyebrow>
            <SectionHeading>This is what verifies your work.</SectionHeading>
            <p className="mt-6 leading-relaxed text-surface-400">
              Not a backend service with an API key. The payout branch runs
              inside the Intelligent Contract, where every validator executes it
              and has to agree on the result.
            </p>
            <a
              href={explorerUrl("address", CONTRACT_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost mt-8"
            >
              View contract
            </a>
          </Reveal>

          <Reveal delayMs={100}>
            <TerminalWindow
              title="contracts/proof_work.py — verify_milestone"
              code={PAYOUT_SNIPPET}
            />
          </Reveal>
        </div>
      </section>

      {/* ── 7. Closing CTA ───────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden">
        <div className="relative mx-auto w-full max-w-3xl px-6 py-28 text-center">
          <Reveal>
            <h2 className="title-hero text-4xl text-surface-100 sm:text-6xl">
              Ready to build?
            </h2>
            <p className="mx-auto mt-6 max-w-lg text-sm leading-relaxed text-surface-400">
              Post a job, take one, or read how the scoring works before you
              commit anything.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Link href="/app" className="btn btn-primary">
                Launch app
              </Link>
              <a
                href={explorerUrl("address", CONTRACT_ADDRESS)}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost"
              >
                View contract
              </a>
            </div>
          </Reveal>
        </div>
      </section>
    </main>
  );
}
