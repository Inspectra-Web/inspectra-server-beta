import envConfig from "../config/env.config.js";

/**
 * Flutterwave v3 transfers, over plain fetch like the checkout in payment.controller.
 * Escrow releases go out through here: money leaves INSPECTRA's Flutterwave balance
 * for a realtor's account.
 */

export type TransferStatus = "NEW" | "PENDING" | "SUCCESSFUL" | "FAILED";

export interface FlwTransfer {
  id: number;
  reference: string;
  amount: number;
  status: TransferStatus;
  complete_message?: string;
}

/**
 * Flutterwave answered and said no: nothing was sent, so trying again later is safe.
 * Anything else that goes wrong (a timeout, a 5xx) leaves it unknown whether the
 * transfer exists, and that must not be retried blind.
 */
export class TransferRejected extends Error {}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${envConfig.FLW_SECRET_KEY}`,
};

export const createTransfer = async (input: {
  bankCode: string;
  accountNumber: string;
  amount: number;
  reference: string;
  narration: string;
}): Promise<FlwTransfer> => {
  const response = await fetch(`${envConfig.FLW_BASE_URL}/transfers`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      account_bank: input.bankCode,
      account_number: input.accountNumber,
      amount: input.amount,
      narration: input.narration,
      currency: "NGN",
      debit_currency: "NGN",
      reference: input.reference,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    status?: string;
    message?: string;
    data?: FlwTransfer;
  };

  if (response.status >= 400 && response.status < 500)
    throw new TransferRejected(body.message ?? `Transfer refused (${response.status})`);

  if (!response.ok || body.status !== "success" || !body.data)
    throw new Error(body.message ?? `Transfer service error (${response.status})`);

  return body.data;
};

/** The transfer as Flutterwave holds it. Trusted over any webhook body. */
export const getTransfer = async (id: number): Promise<FlwTransfer> => {
  const response = await fetch(`${envConfig.FLW_BASE_URL}/transfers/${id}`, { headers });
  const body = (await response.json().catch(() => ({}))) as { data?: FlwTransfer };

  if (!response.ok || !body.data) throw new Error(`Could not read transfer ${id}`);

  return body.data;
};
