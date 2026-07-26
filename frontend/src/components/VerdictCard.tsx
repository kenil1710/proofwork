"use client";

import { useEffect, useRef, useState } from "react";
import { useSkipAnimation } from "@/hooks/useSkipAnimation";
import { payoutBand } from "@/types";

/**
 * The example verdict — the page's signature element.
 *
 * This is the product's whole argument in one object: four criteria, the weight
 * each carried, a weighted final, and the payout that falls out of it. So it
 * does not sit there as a static graphic — it *computes itself* once on view.
 * Bars grow in sequence, then the final score counts up, then the payout band
 * resolves. Evidence, then score, then money, in that order.
 *
 * It is an illustration of the rubric, not a real submission — labelled as such
 * so it can never be mistaken for on-chain data.
 */
const EXAMPLE_VERDICT = {
  milestone: "Homepage and navigation",
  criteria: [
    { label: "Code quality", score: 85, weight: 25 },
    { label: "Design match", score: 90, weight: 25 },
    { label: "Functionality", score: 80, weight: 25 },
    { label: "Completeness", score: 88, weight: 25 },
  ],
  final: 85,
} as const;

// Full class strings — Tailwind resolves these statically, so they cannot be
// assembled from fragments at runtime.
const BAR_COLOR = {
  high: "bg-score-high",
  good: "bg-score-good",
  fair: "bg-score-fair",
  fail: "bg-score-fail",
} as const;

function bandOf(score: number): keyof typeof BAR_COLOR {
  if (score >= 90) return "high";
  if (score >= 80) return "good";
  if (score >= 70) return "fair";
  return "fail";
}

export function VerdictCard({ size = "compact" }: { size?: "compact" | "feature" }) {
  const ref = useRef<HTMLElement | null>(null);
  const [observed, setObserved] = useState(false);
  const [counted, setCounted] = useState(0);
  const skip = useSkipAnimation();

  // Both derived rather than stored, so the reduced-motion path needs no
  // setState in the effect body — which React 19 rejects outright.
  const computed = skip || observed;
  const displayFinal = skip ? EXAMPLE_VERDICT.final : counted;

  // Run the sequence once, when the card first reaches the viewport.
  useEffect(() => {
    const node = ref.current;
    if (!node || skip) return;

    let frame = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setObserved(true);

        // Count the final up only after the bars have had time to grow, so the
        // order reads as "criteria settle, therefore this is the score".
        const startedAt = performance.now();
        const delay = 700;
        const duration = 900;
        const tick = (now: number) => {
          const elapsed = now - startedAt - delay;
          if (elapsed < 0) {
            frame = requestAnimationFrame(tick);
            return;
          }
          const progress = Math.min(1, elapsed / duration);
          // Ease out — fast at first, settling onto the number.
          const eased = 1 - Math.pow(1 - progress, 3);
          setCounted(Math.round(EXAMPLE_VERDICT.final * eased));
          if (progress < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.25 },
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [skip]);

  const band = payoutBand(EXAMPLE_VERDICT.final);
  const feature = size === "feature";

  return (
    <figure
      ref={ref as never}
      className={`card ${feature ? "p-7 sm:p-10" : "p-6 sm:p-8"}`}
    >
      <figcaption className="flex items-baseline justify-between gap-4 border-b border-surface-800 pb-4">
        <span className="text-xs tracking-[0.2em] text-surface-600 uppercase">
          Example verdict
        </span>
        <span className="text-xs text-surface-600">score · weight</span>
      </figcaption>

      <p className="mt-4 text-sm text-surface-400">
        Milestone —{" "}
        <span className="text-surface-200">{EXAMPLE_VERDICT.milestone}</span>
      </p>

      <div className={`mt-6 ${feature ? "space-y-6" : "space-y-5"}`}>
        {EXAMPLE_VERDICT.criteria.map((criterion, index) => (
          <div
            key={criterion.label}
            className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-2"
          >
            <span
              className={`text-surface-300 ${feature ? "text-base" : "text-sm"}`}
            >
              {criterion.label}
            </span>
            <span className="text-sm tabular-nums text-surface-400">
              <span className="text-surface-100">{criterion.score}</span>
              <span className="text-surface-600"> ·{criterion.weight}%</span>
            </span>
            <div
              aria-hidden
              className="col-span-2 h-1 overflow-hidden bg-surface-800"
            >
              <div
                className={`bar-fill h-full ${BAR_COLOR[bandOf(criterion.score)]}`}
                style={{
                  width: computed ? `${criterion.score}%` : "0%",
                  // Stagger so the four criteria resolve one after another.
                  transitionDelay: `${index * 110}ms`,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex items-end justify-between gap-4 border-t border-surface-800 pt-6">
        <div>
          <p className="text-xs tracking-[0.15em] text-surface-600 uppercase">
            Final weighted
          </p>
          <p
            className={`mt-1 font-semibold tabular-nums text-surface-100 ${ feature ?"text-6xl":"text-4xl"}`}
          >
            {displayFinal}
          </p>
        </div>
        <p
          className={`pb-1 text-right text-accent-400 transition-opacity duration-500 ${
            computed ? "opacity-100" : "opacity-0"
          } ${feature ? "text-base" : "text-sm"}`}
        >
          Releases {band.payoutPct}% of
          <br />
          the milestone
        </p>
      </div>
    </figure>
  );
}
