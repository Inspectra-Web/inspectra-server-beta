import envConfig from "../config/env.config.js";

/**
 * LambaCard's purchase API: naira already paid into LambaCard's account buys LBT for a
 * wallet. The environment (SANDBOX or LIVE) comes from the API key alone.
 */

export interface LambaPurchase {
  id: string;
  /** CREATED, VERIFYING_PAYMENT, PAYMENT_VERIFIED, QUEUED, SUBMITTING, SUBMITTED, CONFIRMED,
   * REJECTED, RETRYABLE_FAILURE or RECONCILIATION_REQUIRED. */
  status: string;
  transactionReference: string;
  walletAddress: string;
  fiatAmountMinor: string;
  /** LBT in base units, 18 decimals. */
  customerTokenUnits: string;
  settlementMode: "SIMULATED" | "ON_CHAIN";
  settlement: {
    status: string | null;
    transactionHash: string | null;
    chainId: string | null;
    confirmedBlock: string | null;
    explorerUrl: string | null;
  };
}

/** LambaCard answered and turned the request down, so no purchase was made. */
export class LambaRefused extends Error {}

const isSandbox = () => envConfig.LAMBACARD_API_KEY.startsWith("lbt_test_");

const lambacard = async (path: string, method = "GET", body?: object) => {
  const route = `LambaCard ${method} ${path}`;

  const response = await fetch(`${envConfig.LAMBACARD_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${envConfig.LAMBACARD_API_KEY}`,
    },
    body: body && JSON.stringify(body),
  }).catch((error) => {
    throw new Error(`${route} unreachable: ${(error.cause ?? error).message}`);
  });

  const result: any = await response.json().catch(() => ({}));

  if (!result.success) {
    const message = `${route} failed (${response.status}): ${result.error?.message ?? "no message"}`;
    const refused = response.status >= 400 && response.status < 500;
    throw refused ? new LambaRefused(message) : new Error(message);
  }

  return result.data;
};

/**
 * Buys tokens with a payment already made. The reference is the payment's own and doubles
 * as LambaCard's idempotency key: the same body again replays the first purchase.
 */
export const createPurchase = (input: {
  transactionReference: string;
  amountKobo: number;
  walletAddress: string;
}): Promise<LambaPurchase> =>
  lambacard("/purchases", "POST", {
    transactionReference: input.transactionReference,
    fiatAmountMinor: String(input.amountKobo),
    currency: "NGN",
    walletAddress: input.walletAddress,
    // Sandbox only: settle on BSC Testnet instead of simulating. A live key never sends it.
    ...(isSandbox() && envConfig.LAMBACARD_EXECUTE_ON_CHAIN && { executeOnChain: true }),
  });

export const getPurchase = (id: string): Promise<LambaPurchase> =>
  lambacard(`/purchases/${encodeURIComponent(id)}`);
