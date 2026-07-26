"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CHAIN_ID_HEX,
  addNetworkToWallet,
  ensureCorrectNetwork,
  getWalletChainId,
  hasInjectedWallet,
  requestAccount,
  switchToNetwork,
} from "@/lib/genlayer";

// Wallet injection settles before hydration, so there is nothing to subscribe
// to — but reading it through useSyncExternalStore lets React reconcile the
// server and client answers without a setState-in-effect.
const subscribeToWallet = () => () => {};

type WalletContextValue = {
  /** Connected address, or null when disconnected. */
  account: `0x${string}` | null;
  /** True once an injected EIP-1193 provider is confirmed present. */
  walletAvailable: boolean;
  connecting: boolean;
  /** Last connection failure, already phrased for display. */
  error: string | null;
  connect: () => Promise<void>;
  /**
   * Clears the app's view of the account. Wallets have no programmatic
   * disconnect — the user stays connected in the extension itself.
   */
  disconnect: () => void;

  /** Hex chain id the wallet is on, or null before it has been read. */
  walletChainId: string | null;
  /**
   * True only when the wallet is demonstrably on some *other* chain.
   *
   * Deliberately false while `walletChainId` is null: "not read yet" is not the
   * same as "wrong", and treating it as wrong flashes a scary banner on every
   * first paint before the wallet has answered.
   */
  networkMismatch: boolean;
  /** A switch or add prompt is open in the wallet. */
  networkBusy: boolean;
  /** Last network-change failure, already phrased for display. */
  networkError: string | null;
  /** Prompt to switch, adding the network first if the wallet lacks it. */
  switchNetwork: () => Promise<void>;
  /** Prompt to add the network. MetaMask offers to switch if it already exists. */
  addNetwork: () => Promise<void>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

/** Turns a wallet rejection into something worth showing a person. */
function networkErrorMessage(cause: unknown): string {
  const code = (cause as { code?: number })?.code;
  // 4001 user rejected; -32002 a prompt is already open and unanswered.
  if (code === 4001) return "Network change cancelled.";
  if (code === -32002) return "Check your wallet — a request is already open.";
  return cause instanceof Error ? cause.message : "Could not change network.";
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<string | null>(null);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);

  // Server renders optimistically (`true`) so the connect button doesn't flash
  // as "Install a wallet" before hydration corrects it.
  const walletAvailable = useSyncExternalStore(
    subscribeToWallet,
    hasInjectedWallet,
    () => true,
  );

  // Reflect account switches made from inside the wallet itself.
  useEffect(() => {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider?.on) return;

    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      setAccount(accounts?.length ? (accounts[0] as `0x${string}`) : null);
    };

    provider.on("accountsChanged", onAccountsChanged);
    return () => provider.removeListener?.("accountsChanged", onAccountsChanged);
  }, []);

  // Track the wallet's chain. `eth_chainId` needs no permission, so this works
  // before the user connects — which is the point: the "add network" prompt is
  // most useful *before* someone tries to transact on the wrong chain.
  useEffect(() => {
    let cancelled = false;
    void getWalletChainId().then((id) => {
      if (!cancelled) setWalletChainId(id);
    });

    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider?.on) return () => { cancelled = true; };

    const onChainChanged = (...args: unknown[]) => {
      const next = args[0];
      if (typeof next === "string") setWalletChainId(next.toLowerCase());
      // The switch succeeded, so whatever the last attempt complained about is
      // no longer true.
      setNetworkError(null);
    };

    provider.on("chainChanged", onChainChanged);
    return () => {
      cancelled = true;
      provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const next = await requestAccount();
      await ensureCorrectNetwork();
      setAccount(next);
    } catch (cause) {
      // 4001 is the EIP-1193 code for "user rejected" — not worth an alarm.
      const code = (cause as { code?: number })?.code;
      setError(
        code === 4001
          ? "Connection cancelled."
          : cause instanceof Error
            ? cause.message
            : "Could not connect to your wallet.",
      );
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAccount(null);
    setError(null);
  }, []);

  /**
   * Shared body for both network prompts.
   *
   * The chain id is re-read afterwards rather than assumed: `chainChanged` is
   * the normal path, but a wallet that was already on the right chain fires
   * nothing at all, which would otherwise leave the banner up after a
   * successful switch.
   */
  const runNetworkAction = useCallback(async (action: () => Promise<void>) => {
    setNetworkBusy(true);
    setNetworkError(null);
    try {
      await action();
      setWalletChainId(await getWalletChainId());
    } catch (cause) {
      setNetworkError(networkErrorMessage(cause));
    } finally {
      setNetworkBusy(false);
    }
  }, []);

  const switchNetwork = useCallback(
    () => runNetworkAction(switchToNetwork),
    [runNetworkAction],
  );
  const addNetwork = useCallback(
    () => runNetworkAction(addNetworkToWallet),
    [runNetworkAction],
  );

  const networkMismatch =
    walletAvailable && walletChainId !== null && walletChainId !== CHAIN_ID_HEX;

  const value = useMemo(
    () => ({
      account,
      walletAvailable,
      connecting,
      error,
      connect,
      disconnect,
      walletChainId,
      networkMismatch,
      networkBusy,
      networkError,
      switchNetwork,
      addNetwork,
    }),
    [
      account,
      walletAvailable,
      connecting,
      error,
      connect,
      disconnect,
      walletChainId,
      networkMismatch,
      networkBusy,
      networkError,
      switchNetwork,
      addNetwork,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

/** Connected-wallet state. Throws outside <WalletProvider>. */
export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used inside <WalletProvider>.");
  }
  return context;
}
