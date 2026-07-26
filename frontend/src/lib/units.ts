/**
 * GEN <-> base-unit conversion.
 *
 * GEN has 18 decimals, and `gl.message.value` arrives at the contract in base
 * units, so a UI figure of "1.5" has to become 1500000000000000000n.
 */

export const GEN_DECIMALS = 18n;
const SCALE = 10n ** GEN_DECIMALS;

/**
 * Largest escrow the contract can hold.
 *
 * `Job.total_amount` is a `u64` and `create_job` does `u64(gl.message.value)`,
 * so anything above this overflows on deposit.
 */
export const MAX_ESCROW_BASE_UNITS = 2n ** 64n - 1n;

export class InvalidAmountError extends Error {}

/**
 * Parses a decimal GEN string into base units.
 *
 * @throws {InvalidAmountError} on anything that isn't a positive decimal, or
 * that carries more precision than GEN can represent.
 */
export function parseGen(input: string): bigint {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new InvalidAmountError("Enter a deposit amount.");
  }
  // No sign, no exponent — those would silently misparse into wrong amounts.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidAmountError("Enter a positive number, for example 0.05.");
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (BigInt(fraction.length) > GEN_DECIMALS) {
    throw new InvalidAmountError("GEN supports at most 18 decimal places.");
  }

  const padded = fraction.padEnd(Number(GEN_DECIMALS), "0");
  const value = BigInt(whole) * SCALE + BigInt(padded || "0");

  if (value === 0n) {
    // Mirrors the contract's own "Must deposit GEN for escrow".
    throw new InvalidAmountError("The deposit must be greater than zero.");
  }
  if (value > MAX_ESCROW_BASE_UNITS) {
    throw new InvalidAmountError(
      "That exceeds the largest escrow the contract can hold (~18.44 GEN).",
    );
  }

  return value;
}

/** Formats base units back to a trimmed decimal GEN string. */
export function formatGen(baseUnits: bigint): string {
  const whole = baseUnits / SCALE;
  const fraction = (baseUnits % SCALE).toString().padStart(Number(GEN_DECIMALS), "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}
