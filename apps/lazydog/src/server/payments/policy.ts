/** Base Sepolia (testnet) — the only network LazyDog will pay on. */
export const PAYMENT_NETWORK = "eip155:84532";
/** Circle's test USDC on Base Sepolia (6 decimals). */
export const TEST_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PREMIUM_BRIEF_PRICE_USD = 0.01;
/** Hard ceiling per call, in USD, regardless of what a server asks for. */
export const MAX_PAYMENT_USD = 0.05;

export type PaymentRequirementLike = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
};

export type PaymentDecision =
  | { pay: true; requirement: PaymentRequirementLike; usd: number }
  | { pay: false; reason: string };

/**
 * Decide whether the agent may sign one of the server's payment options.
 * The human has already approved the tool call; this is the machine-side
 * guard: testnet only, test USDC only, our configured recipient only, and
 * never more than MAX_PAYMENT_USD.
 */
export function choosePayment(
  requirements: readonly PaymentRequirementLike[],
  expectedPayTo: string
): PaymentDecision {
  const maxUnits = BigInt(Math.round(MAX_PAYMENT_USD * 1_000_000));
  for (const r of requirements) {
    if (r.network !== PAYMENT_NETWORK) continue;
    if (r.asset.toLowerCase() !== TEST_USDC.toLowerCase()) continue;
    if (r.payTo.toLowerCase() !== expectedPayTo.toLowerCase()) continue;
    let units: bigint;
    try {
      units = BigInt(r.amount);
    } catch {
      continue;
    }
    if (units <= 0n || units > maxUnits) continue;
    return { pay: true, requirement: r, usd: Number(units) / 1_000_000 };
  }
  return {
    pay: false,
    reason: `no acceptable payment option (need ${PAYMENT_NETWORK} test USDC to ${expectedPayTo}, ≤ $${MAX_PAYMENT_USD})`
  };
}
