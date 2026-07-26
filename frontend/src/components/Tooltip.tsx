"use client";

import { useId, useState } from "react";
import { IS_GASLESS } from "@/lib/genlayer";

/**
 * Explains a term inline, for the crypto vocabulary this app cannot avoid.
 *
 * Opens on hover *and* on focus, and closes on Escape, so it is reachable
 * without a mouse. The trigger is a real `<button>` rather than a styled span:
 * a dotted underline that only responds to hover is invisible to anyone
 * tabbing through the page.
 */
export function Tooltip({
  term,
  children,
}: {
  /** The word being explained, shown with a dotted underline. */
  term: string;
  /** The explanation. One or two plain sentences — this is not a footnote. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className="cursor-help border-b border-dotted border-surface-600 text-surface-200 transition-colors hover:border-orchid-400 hover:text-surface-100"
      >
        {term}
      </button>

      {open ? (
        <span
          role="tooltip"
          id={id}
          className="absolute bottom-full left-0 z-30 mb-2 block w-64 rounded-[12px] border border-surface-700 bg-surface-850 p-3 text-sm leading-relaxed font-normal text-surface-300"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The handful of terms this app keeps having to explain, written once so the
 * wording cannot drift between pages.
 */
export const GLOSSARY = {
  gen: IS_GASLESS
    ? "GEN is the native token of the GenLayer network. This network is gasless — transactions cost nothing and the balances here have no real-world value."
    : "GEN is the native token of the GenLayer network. On this testnet it is free from the faucet and has no real-world value.",
  escrow:
    "Money the contract holds while the work happens. Neither side can take it — it is released to the freelancer by the score, or refunded if the job is cancelled before anyone accepts it.",
  gas: "The small fee paid to the network for running a transaction. It is separate from the escrow and is not refunded.",
  validator:
    "An independent node that checks a transaction. For verification, several of them fetch the same evidence and must agree before a score is written.",
  finalization:
    "The point at which a transaction becomes irreversible. Payouts leave escrow on finalization, which happens later than acceptance — on this testnet it can take hours.",
  milestone:
    "One checkpoint of a job, with its own description and its own share of the escrow. Each is verified and paid separately.",
} as const;
