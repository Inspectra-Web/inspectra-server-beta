import { createHmac, timingSafeEqual } from "node:crypto";

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

/** How old a signed delivery may be before it is treated as a replay. */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * `lbt-webhook-signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of `<t>.<raw body>`
 * keyed with the whole secret, `whsec_` included. Found by testing their sandbox; their spec
 * does not say.
 */
export const verifyWebhook = (rawBody: Buffer, header: string | undefined): boolean => {
  const secret = envConfig.LAMBACARD_WEBHOOK_SECRET;
  if (!secret || !header) return false;

  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");

  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();

  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
};
