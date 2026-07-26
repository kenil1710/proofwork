"use client";

import { NETWORK_LABEL } from "@/lib/genlayer";
import { useWallet } from "./WalletProvider";

/**
 * Navbar control that asks the wallet to add this network.
 *
 * Shown only while the wallet is on a different chain — which is exactly when
 * it can do something. Once the network is added and active there is nothing
 * left to add, and a permanent button would be clutter in a header the layout
 * comment already describes as tight at 390px.
 *
 * The visible label stays short for that reason; the full sentence lives in
 * `aria-label` and the tooltip.
 */
export function AddNetworkButton() {
  const { networkMismatch, networkBusy, addNetwork } = useWallet();

  if (!networkMismatch) return null;

  // The responsive display lives on this wrapper, not on the button. `.btn`
  // sets `display: inline-flex` from inside `@layer utilities` and appears
  // later in the sheet than Tailwind's own utilities, so `hidden` on the
  // button itself loses the specificity tie and the button shows at every
  // width — which is precisely what breaks the header at 390px.
  return (
    <span className="hidden sm:inline-flex">
      <button
        type="button"
        onClick={() => void addNetwork()}
        disabled={networkBusy}
        aria-label={`Add ${NETWORK_LABEL} to MetaMask`}
        title={`Add ${NETWORK_LABEL} to MetaMask`}
        className="btn btn-ghost btn-sm gap-1.5"
      >
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
        <span className="whitespace-nowrap">
          {networkBusy ? "Check wallet…" : `Add ${NETWORK_LABEL}`}
        </span>
      </button>
    </span>
  );
}
