/**
 * Address normalisation.
 *
 * The contract writes addresses out with Python's `str(Address)`, which is
 * EIP-55 checksummed — `get_job` on a live job returns
 * `0x4EAEC8070fF1460eB4460d9FD251Fd350A11a76a`, mixed case. Wallets, meanwhile,
 * hand back `eth_requestAccounts` results in lowercase. So the two never match
 * as raw strings, and both of the things the UI does with addresses need
 * deliberate handling:
 *
 *   - Deciding whether the connected wallet is the client or the freelancer:
 *     compare case-insensitively with `sameAddress`.
 *   - Looking up reputation: `freelancer_scores` is keyed by the checksummed
 *     string, so a lowercase argument silently reads as "no completed jobs"
 *     rather than erroring. Normalise with `toContractAddress` before querying.
 */
import { getAddress } from "viem";
import { UNASSIGNED_ADDRESS } from "@/types";

export class InvalidAddressError extends Error {}

/**
 * Parses user input into the checksummed form the contract stores.
 *
 * @throws {InvalidAddressError} on anything that isn't a 20-byte hex address.
 */
export function toContractAddress(input: string): `0x${string}` {
  const trimmed = input.trim();

  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new InvalidAddressError(
      "Enter a 20-byte address — 0x followed by 40 hex characters.",
    );
  }

  try {
    // Re-checksums from scratch, so mixed-case input with a *wrong* checksum
    // is corrected rather than rejected. The regex above already bounds it.
    return getAddress(trimmed.toLowerCase());
  } catch {
    throw new InvalidAddressError("That is not a valid address.");
  }
}

/** Case-insensitive address equality. Either side may be null/undefined. */
export function sameAddress(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** True while a job still has no freelancer assigned. */
export function isUnassigned(address: string | null | undefined): boolean {
  return !address || sameAddress(address, UNASSIGNED_ADDRESS);
}

/** Middle-truncated address for dense UI. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
