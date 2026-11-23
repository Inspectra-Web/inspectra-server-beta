import { constants, publicEncrypt } from "node:crypto";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";

export interface PlanbokAccount {
  id: string;
  refId: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankCode: string;
  status: string;
}

export interface Holder {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
  address: string;
  dateOfBirth: string;
  bvn: string;
  nin: string;
}

const UNREACHABLE = "We could not reach the payments service. Try again.";

/** Planbok answered and turned the request down, so nothing was done. */
export class PlanbokRefused extends AppError {
  /** Planbok's own reason, for an admin. The public message stays generic. */
  constructor(
    message: string,
    statusCode: number,
    public readonly reason: string,
  ) {
    super(message, statusCode);
  }
}

const planbok = async (path: string, method = "GET", body?: object, apiKey = envConfig.PLANBOK_API_KEY) => {
  // Logs carry the error message only: Planbok's replies and query strings hold customer data.
  const route = `Planbok ${method} ${path.split("?")[0]}`;

  const response = await fetch(`${envConfig.PLANBOK_BASE_URL}/v2${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "PLANBOK-X-API-KEY": apiKey,
    },
    body: body && JSON.stringify(body),
  }).catch((error) => {
    console.error(`${route} unreachable: ${(error.cause ?? error).message}`);
    throw new AppError(UNREACHABLE, 502);
  });

  const result: any = await response.json().catch(() => ({}));

  if (!result.success) {
    const message = result.errors?.message ?? result.message ?? "no message";
    console.error(`${route} failed (${response.status}): ${message}`);

    // Only a 4xx is a definite no; a 5xx or an unreadable reply may have done the work.
    const refused = response.status >= 400 && response.status < 500;
    throw refused ? new PlanbokRefused(UNREACHABLE, 502, String(message)) : new AppError(UNREACHABLE, 502);
  }

  return result.data;
};

export interface PlanbokWallet {
  id: string;
  refId: string;
  address: string;
  blockchain: string;
  state: string;
}

let publicKey = "";

// A fresh ciphertext per call: Planbok rejects one older than 5 minutes. Virtual accounts
// take `verify`, wallets take `sign`.
const encryptedSecret = async (context: "verify" | "sign") => {
  if (!publicKey) publicKey = (await planbok("/config/organization/public-key")).publicKey;

  const payload = JSON.stringify({
    secret: envConfig.PLANBOK_ORG_SECRET,
    timestamp: Date.now(),
    context,
  });

  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(payload),
  ).toString("base64");
};

// Money is integer kobo everywhere except here: Planbok speaks naira.
export const toNaira = (kobo: number) => (kobo / 100).toFixed(2);
export const toKobo = (naira: number | string) => Math.round(Number(naira) * 100);

export const createAccount = async (
  idempotencyKey: string,
  refId: string,
  name: string,
  holder: Holder,
): Promise<PlanbokAccount | undefined> => {
  const data = await planbok("/virtual-accounts", "POST", {
    idempotencyKey,
    encryptedOrganizationSecret: await encryptedSecret("verify"),
    count: 1,
    metadata: [{ name, refId, currencies: ["NGN"], holderDetails: holder }],
  });

  if (data.failed.length) console.error(`Planbok did not open virtual account ${refId}.`);

  return data.created[0];
};

// This one owner's virtual account details are read with a separate Planbok API key.
const SPECIAL_EMAIL = "devfranklinandrew@gmail.com";

const accountKey = (email: string) =>
  email.toLowerCase() === SPECIAL_EMAIL ? envConfig.PLANBOK_API_KEY_SPECIAL : envConfig.PLANBOK_API_KEY;

export const findAccount = async (refId: string, email: string): Promise<PlanbokAccount | undefined> => {
  const data = await planbok(`/virtual-accounts?refId=${encodeURIComponent(refId)}`, "GET", undefined, accountKey(email));

  return data.items[0];
};

/** No email reads with the main key, which is the one our own incentive account is under. */
export const getBalance = async (accountId: string, email = "") => {
  const { balance } = await planbok(`/virtual-accounts/${accountId}/balance`, "GET", undefined, accountKey(email));

  return { booked: toKobo(balance.bookedBalance), available: toKobo(balance.availableBalance) };
};

export const listBanks = async (): Promise<{ code: string; name: string }[]> =>
  (await planbok("/virtual-accounts/banks?order=ASC")).banks;

export interface BankAccountName {
  accountNumber: string;
  accountName: string;
  bankCode: string;
}

/**
 * An account at any bank, by number and sort code. Planbok nests it under `account`; an
 * account the bank cannot resolve is a 400, so it throws `PlanbokRefused`.
 */
export const nameEnquiry = async (accountNumber: string, sortCode: string): Promise<BankAccountName> => {
  const query = new URLSearchParams({ accountNumber, sortCode });
  const { account } = await planbok(`/virtual-accounts/name/enquiry?${query}`);

  return { accountNumber: account.accountNumber, accountName: account.accountName, bankCode: account.bankCode };
};

export interface PlanbokTransfer {
  transferId: string;
  status: string;
  amount: string;
  currency: string;
  destinationType: string;
  /** Not the transaction's reference: Planbok's own lookup refuses it (2026-11-23). Unused. */
  providerReference: string;
}

/** A virtual account transaction. A settled one reads `SUCCESS`; `entry` is CREDIT or DEBIT. */
export interface PlanbokTransaction {
  id: string;
  amount: string;
  currency: string;
  entry: string;
  reference: string;
  status: string;
}

export const transfer = async (
  accountId: string,
  idempotencyKey: string,
  amount: number,
  destinationType: "same-bank" | "other-banks",
  destination: { accountNumber: string; sortCode: string; accountName: string },
  narration: string,
): Promise<PlanbokTransfer> =>
  planbok(`/virtual-accounts/${accountId}/transfer`, "POST", {
    idempotencyKey,
    encryptedOrganizationSecret: await encryptedSecret("verify"),
    amount: toNaira(amount),
    destinationType,
    destination,
    narration,
  });

/**
 * Our own transfer, found by the idempotency key we sent: Planbok echoes it back as
 * `CustomerReference`. The transfer reply's `providerReference` cannot be looked up, so the
 * key, which we hold before the call, is the one reliable handle. Undefined while Planbok
 * has not listed it (or never got it). The latest 50 are plenty: we look the moment after
 * sending, and on every sweep after.
 */
export const findTransfer = async (accountId: string, key: string): Promise<PlanbokTransaction | undefined> => {
  const { items } = await planbok(`/virtual-accounts/${accountId}/transactions?limit=50`);
  const found = (items as (PlanbokTransaction & { CustomerReference?: string })[]).find(
    (item) => item.CustomerReference === key,
  );
  if (!found) return undefined;

  const { id, amount, currency, entry, reference, status } = found;
  return { id, amount, currency, entry, reference, status };
};

export const createWallet = async (
  idempotencyKey: string,
  refId: string,
  name: string,
): Promise<PlanbokWallet | undefined> => {
  const data: { wallets: PlanbokWallet[] } = await planbok("/organization/wallets", "POST", {
    idempotencyKey,
    encryptedOrganizationSecret: await encryptedSecret("sign"),
    walletSetId: envConfig.PLANBOK_WALLET_SET_ID,
    blockchains: ["BSC"],
    count: 1,
    accountType: "eoa",
    metadata: [{ name, refId }],
  });

  // Only a wallet carrying our refId is ours: Planbok has answered a create with another
  // realtor's existing wallet (2026-11-21), which must never be handed to this one.
  const wallets = data.wallets ?? [];
  const created = wallets.find((wallet) => wallet.refId === refId);

  if (!created)
    console.error(
      wallets.length
        ? `Planbok answered the wallet create for ${refId} with another customer's wallet.`
        : `Planbok created no wallet for ${refId}.`,
    );

  return created;
};

interface PlanbokTokenBalance {
  amount: string;
  token: { name: string; symbol: string; decimals: number; standard: string };
}

// `amount` is a decimal string in token units and stays one: 18 decimals overflow a number.
export const getWalletBalances = async (walletId: string) => {
  const data: PlanbokTokenBalance[] = await planbok(`/wallets/${walletId}/balances?limit=50`);

  return data.map(({ amount, token }) => ({
    amount,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    standard: token.standard,
  }));
};
