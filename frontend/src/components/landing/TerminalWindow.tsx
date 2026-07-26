import { CodeBlock } from "@/components/docs/CodeBlock";

/**
 * Terminal window chrome around a code sample.
 *
 * The code inside is copied verbatim from `contracts/proof_work.py` — the real
 * payout branch, comments and all. A landing page that shows invented code to
 * a developer audience gets caught immediately, and this contract is deployed
 * and readable on the explorer, so the honest version is also the more
 * impressive one.
 */
export function TerminalWindow({
  title,
  code,
}: {
  title: string;
  code: string;
}) {
  return (
    <div className="chrome-code overflow-hidden rounded-[16px] border border-surface-800">
      {/* Title bar. The dots are recognisable chrome, not controls — nothing
          here is interactive, so they carry aria-hidden and no button roles. */}
      <div className="flex items-center gap-3 border-b border-surface-800 bg-surface-900/70 px-4 py-2.5">
        <span aria-hidden className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-status-rejected/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-status-progress/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-orchid-400/70" />
        </span>
        <span className="text-xs tracking-[0.12em] text-surface-500">
          {title}
        </span>
      </div>

      <div className="[&_figure]:mt-0 [&_figure]:rounded-none [&_figure]:border-0">
        <CodeBlock code={code} />
      </div>
    </div>
  );
}

/** The payout branch, verbatim from the deployed contract. */
export const PAYOUT_SNIPPET = `# ── Determine payment based on score ──
# Same threshold the validator gates on, deliberately — if these
# two ever disagree, validators would be agreeing about a payment
# decision the contract then makes differently.
if final >= u32(PASS_THRESHOLD):
    ms.status = "verified"
    job.completed_milestones = u32(job.completed_milestones + u32(1))

    milestone_amount = u64(
        u64(job.total_amount) // u64(100) * u64(ms.percentage)
    )

    if final >= u32(90):
        payout = milestone_amount
    elif final >= u32(80):
        payout = u64(milestone_amount // u64(100) * u64(80))
    else:
        payout = u64(milestone_amount // u64(100) * u64(70))

    # Paying a wallet is an external message, so it needs an EVM
    # contract interface even though no contract lives there.
    _Payee(job.freelancer).emit_transfer(value=u256(int(payout)))
else:
    ms.status = "rejected"
`;
