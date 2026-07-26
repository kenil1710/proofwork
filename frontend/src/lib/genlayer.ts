/**
 * GenLayer client setup for ProofWork.
 *
 * Two client flavours:
 *   - `getReadClient()`   — no signer, for `@gl.public.view` methods. Safe anywhere.
 *   - `getWalletClient()` — browser-only, signs via an injected EIP-1193 wallet.
 */
import { createClient } from "genlayer-js";
import { studionet, testnetBradbury } from "genlayer-js/chains";

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only for *literal*
 * member access — `process.env[name]` silently yields undefined in the browser.
 * Hence the literal reads below rather than a lookup helper.
 */
const rawContractAddress = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;
const rawNetwork = process.env.NEXT_PUBLIC_GENLAYER_NETWORK;

/**
 * Always use the SDK's built-in chain definitions rather than hand-rolling a
 * chain object: they carry the consensus/staking/fee-manager/appeals contract
 * addresses and `isStudio`, which the SDK needs to poll transactions. A
 * hand-written `{ id, name, rpcUrls, nativeCurrency }` omits all of that and
 * breaks receipt polling.
 */
const CHAINS = {
  studionet,
  bradbury: testnetBradbury,
} as const;

export type NetworkName = keyof typeof CHAINS;

/**
 * Which network the app talks to, from `NEXT_PUBLIC_GENLAYER_NETWORK`.
 *
 * Defaults to `studionet`: it settles transactions in seconds where Bradbury
 * takes minutes, so it is the only sane target for iterating. Set
 * `NEXT_PUBLIC_GENLAYER_NETWORK=bradbury` (with the matching Bradbury contract
 * address) for the real-testnet build.
 *
 * The contract address is *not* interchangeable between the two — each network
 * has its own deploy. Changing one without the other points the UI at an
 * address that does not exist, which surfaces as every read returning null.
 */
function resolveNetwork(value: string | undefined): NetworkName {
  if (!value) return "studionet";
  if (value in CHAINS) return value as NetworkName;
  throw new Error(
    `NEXT_PUBLIC_GENLAYER_NETWORK must be one of ${Object.keys(CHAINS).join(" | ")}, got: ${value}`,
  );
}

export const NETWORK = resolveNetwork(rawNetwork);
export const chain = CHAINS[NETWORK];

/**
 * Studio networks are gasless and have no faucet — a 0 GEN balance is normal
 * and does not block writes. The UI uses this to suppress "fund your wallet"
 * guidance that only applies to Bradbury.
 */
export const IS_GASLESS = Boolean(chain.isStudio);

/**
 * `chain.id` as the hex string EIP-1193 expects — 61999 becomes "0xf22f".
 *
 * Derived, never written by hand. Transcribing it is a genuinely easy mistake
 * (0xf23f is 62015, not 61999) and the failure is confusing rather than loud:
 * the wallet happily adds a network at the wrong id, then every request is
 * rejected for a chain mismatch that looks like an RPC fault.
 */
export const CHAIN_ID_HEX = `0x${chain.id.toString(16)}`;

/** Short name for buttons and prose: "Studionet", not "Genlayer Studio Network". */
export const NETWORK_LABEL: string = { studionet: "Studionet", bradbury: "Bradbury" }[
  NETWORK
];

/**
 * What the wallet is told about this network.
 *
 * Separate from the SDK chain object because the two audiences differ: MetaMask
 * shows `chainName` in its network list, where "GenLayer Studionet" reads better
 * than the SDK's "Genlayer Studio Network", and its explorer link should go to
 * the Studio UI rather than the SDK's declared `genlayer-explorer.vercel.app`.
 * In-app links keep using the chain's own explorer via `explorerUrl`.
 */
const WALLET_NETWORK: Record<NetworkName, { name: string; explorer?: string }> = {
  studionet: { name: "GenLayer Studionet", explorer: "https://studio.genlayer.com" },
  bradbury: { name: "GenLayer Bradbury Testnet" },
};

function addChainParams() {
  const profile = WALLET_NETWORK[NETWORK];
  const explorer = profile.explorer ?? chain.blockExplorers?.default?.url;
  return {
    chainId: CHAIN_ID_HEX,
    chainName: profile.name,
    rpcUrls: [...chain.rpcUrls.default.http],
    nativeCurrency: {
      name: chain.nativeCurrency.name,
      symbol: chain.nativeCurrency.symbol,
      decimals: chain.nativeCurrency.decimals,
    },
    // Omitted rather than sent empty: MetaMask rejects a malformed entry.
    ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
  };
}

/** The chain the wallet is currently on, as a hex id, or null if unavailable. */
export async function getWalletChainId(): Promise<string | null> {
  if (!hasInjectedWallet()) return null;
  try {
    const id = await window.ethereum!.request({ method: "eth_chainId" });
    return typeof id === "string" ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Asks the wallet to add this network.
 *
 * MetaMask treats this as add-and-switch: if the chain is already known it
 * simply offers to switch instead of duplicating it, so this is safe to call
 * even when the network is present.
 */
export async function addNetworkToWallet(): Promise<void> {
  if (!hasInjectedWallet()) {
    throw new Error("No injected wallet found. Install MetaMask to continue.");
  }
  await window.ethereum!.request({
    method: "wallet_addEthereumChain",
    params: [addChainParams()],
  });
}

/**
 * Switches the wallet to this network, adding it first if the wallet does not
 * know it (error 4902).
 */
export async function switchToNetwork(): Promise<void> {
  if (!hasInjectedWallet()) {
    throw new Error("No injected wallet found. Install MetaMask to continue.");
  }
  try {
    await window.ethereum!.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code !== 4902) throw error;
    await addNetworkToWallet();
  }
}

function assertAddress(value: string | undefined, name: string): `0x${string}` {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy frontend/.env.example to frontend/.env.local and set it.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is not a 20-byte hex address: ${value}`);
  }
  return value as `0x${string}`;
}

/** Deployed ProofWork Intelligent Contract on the selected network. */
export const CONTRACT_ADDRESS = assertAddress(
  rawContractAddress,
  "NEXT_PUBLIC_CONTRACT_ADDRESS",
);

/** Minimal EIP-1193 shape — avoids depending on wallet-specific typings. */
export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

/**
 * Read-only client for view methods. No account, so it can never sign.
 *
 * Cached: the consensus poll loop in `lib/contract.ts` calls this every few
 * seconds, and a fresh client per read is pure overhead. Safe to share because
 * it holds no account and no per-request state.
 *
 * Note every ProofWork view method returns a JSON *string*; callers must
 * `JSON.parse` the result. The typed wrappers belong in `lib/contract.ts`.
 */
let readClient: ReturnType<typeof createClient> | null = null;

export function getReadClient() {
  readClient ??= createClient({ chain });
  return readClient;
}

/** True when an injected EIP-1193 wallet is present. */
export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/**
 * Signing client backed by the injected wallet.
 *
 * @param account - the connected address, from `eth_requestAccounts`.
 * @throws if called during SSR or with no wallet installed.
 */
export function getWalletClient(account: `0x${string}`) {
  if (typeof window === "undefined") {
    throw new Error("getWalletClient is browser-only; guard it behind an effect.");
  }
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("No injected wallet found. Install MetaMask to send transactions.");
  }
  return createClient({ chain, provider, account });
}

/**
 * Prompts the wallet for access and returns the selected address.
 * Does not switch networks — do that separately once the user is connected.
 */
export async function requestAccount(): Promise<`0x${string}`> {
  if (!hasInjectedWallet()) {
    throw new Error("No injected wallet found. Install MetaMask to continue.");
  }
  const accounts = (await window.ethereum!.request({
    method: "eth_requestAccounts",
  })) as string[];

  if (!accounts?.length) {
    throw new Error("Wallet returned no accounts.");
  }
  return accounts[0] as `0x${string}`;
}

/**
 * Puts the wallet on the right network as part of connecting. Writes sent from
 * the wrong chain fail, so this runs before any signing.
 *
 * Unlike `switchToNetwork`, a missing wallet is not an error here — connecting
 * already reports that, and throwing twice for one cause is noise.
 */
export async function ensureCorrectNetwork(): Promise<void> {
  if (!hasInjectedWallet()) return;
  await switchToNetwork();
}

/** Explorer link for a tx hash or address, for surfacing in the UI. */
export function explorerUrl(kind: "tx" | "address", value: string): string {
  const base = chain.blockExplorers?.default?.url?.replace(/\/$/, "") ?? "";
  return `${base}/${kind}/${value}`;
}
