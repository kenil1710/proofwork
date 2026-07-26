"use client";

import { CHAIN_ID_HEX, NETWORK_LABEL, chain } from "@/lib/genlayer";
import { useWallet } from "./WalletProvider";

/** "0x1" -> "1". Falls back to the raw value if the wallet sends something odd. */
function decimalChainId(hex: string): string {
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? String(parsed) : hex;
}

/**
 * Full-width warning shown when the wallet is on a different chain.
 *
 * Rendered under the navbar on every route rather than per-page, because the
 * failure it prevents is not page-specific: a write signed on the wrong chain
 * does not reach the contract, and the resulting error names an RPC problem
 * rather than the actual cause.
 *
 * `switchNetwork` adds the network first if the wallet does not have it, so
 * this one button is sufficient in every case. The explicit "Add to MetaMask"
 * is only rendered below `sm`, where the navbar's copy of it is hidden — on
 * wider screens that would be two buttons for the same job.
 */
export function NetworkBanner() {
  const {
    networkMismatch,
    networkBusy,
    networkError,
    switchNetwork,
    addNetwork,
    walletChainId,
  } = useWallet();

  if (!networkMismatch) return null;

  return (
    <div
      role="alert"
      className="border-b border-status-progress/30 bg-status-progress/5"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        {/* `basis-full` below `sm` so the text takes its own row and the
            buttons wrap beneath it. With `flex-1` alone the text keeps sharing
            the row and, being shrinkable, collapses to one word per line. */}
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <p className="text-sm text-surface-200">
            Your wallet is on a different network. ProofWork runs on{" "}
            <span className="font-medium text-surface-100">{chain.name}</span>.
          </p>
          <p className="mt-0.5 text-xs text-surface-400">
            <span className="value-mono">
              chain {chain.id} ({CHAIN_ID_HEX})
            </span>
            {walletChainId ? (
              <>
                {" · wallet is on "}
                <span className="value-mono">
                  chain {decimalChainId(walletChainId)} ({walletChainId})
                </span>
              </>
            ) : null}
          </p>
          {networkError ? (
            <p className="mt-1 text-xs text-status-rejected">{networkError}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {/* Wrapper carries the responsive display: `.btn` would otherwise
              win the specificity tie against `sm:hidden`. See AddNetworkButton. */}
          <span className="inline-flex sm:hidden">
            <button
              type="button"
              onClick={() => void addNetwork()}
              disabled={networkBusy}
              className="btn btn-ghost btn-sm"
            >
              Add to MetaMask
            </button>
          </span>
          <button
            type="button"
            onClick={() => void switchNetwork()}
            disabled={networkBusy}
            className="btn btn-primary btn-sm whitespace-nowrap"
          >
            {networkBusy ? "Check wallet…" : `Switch to ${NETWORK_LABEL}`}
          </button>
        </div>
      </div>
    </div>
  );
}
