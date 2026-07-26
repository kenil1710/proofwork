"use client";

import { useWallet } from "./WalletProvider";

function truncate(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Header wallet control. All state lives in <WalletProvider> so every route
 * reads the same connected address.
 */
export function ConnectWallet() {
  const { account, walletAvailable, connecting, error, connect, disconnect } =
    useWallet();

  if (!walletAvailable) {
    return (
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer"
        className="btn btn-ghost btn-sm"
      >
        Install a wallet
      </a>
    );
  }

  if (account) {
    return (
      <button
        type="button"
        onClick={disconnect}
        title="Disconnect"
        className="btn btn-primary btn-sm group gap-2"
      >
        {/* Orchid, not emerald: a connected wallet is a live signal, and
            emerald is reserved for "this milestone passed". */}
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-orchid-400 animate-pulse-dot group-hover:bg-surface-500"
        />
        <span className="value-mono group-hover:hidden">{truncate(account)}</span>
        <span className="hidden group-hover:inline">Disconnect</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void connect()}
        disabled={connecting}
        className="btn btn-primary btn-sm"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {error ? (
        <span role="alert" className="max-w-56 text-right text-xs text-status-rejected">
          {error}
        </span>
      ) : null}
    </div>
  );
}
