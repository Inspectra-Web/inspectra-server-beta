import { trusted, type QueryFilter, type Types } from "mongoose";

import envConfig from "../config/env.config.js";
import Enrollment, {
  INCENTIVE_PAYOUT,
  INCENTIVE_REFERENCE_PREFIX,
  type IEnrollment,
  type IIncentive,
} from "../models/enrollment.model.js";
import {
  createTransfer,
  getTransfer,
  TransferRejected,
  type FlwTransfer,
} from "./flutterwave.service.js";
import { getTransaction, PlanbokRefused, toKobo, transfer } from "./planbok.service.js";

/**
 * The course incentive: ₦10,000 of every paid course buys the realtor's LambaCard tokens.
 * Its first hop is one Flutterwave transfer into our Planbok account, sent the moment the
 * payment is claimed, with the same discipline as an escrow release: a refusal is retried,
 * an unknown outcome is never resent blind.
 */

/** Only a price that clears the payout owes one; a checkout opened at ₦10,000 never does. */
export const incentiveFor = (amount: number): IIncentive | undefined =>
  amount > INCENTIVE_PAYOUT
    ? { amount: INCENTIVE_PAYOUT, status: "due", funding: { reference: "", attempts: 0 } }
    : undefined;

export const startIncentive = async (id: Types.ObjectId): Promise<boolean> => {
  const { PLANBOK_BANK_CODE: bankCode, PLANBOK_ACCOUNT_NUMBER: accountNumber } = envConfig;

  if (!bankCode || !accountNumber) {
    console.error(`Incentive for enrollment ${String(id)} waits: no Planbok account is set.`);
    return false;
  }

  const current = await Enrollment.findOne({ _id: id, "incentive.status": "due" }).select("incentive");
  if (!current?.incentive) return false;

  const { attempts } = current.incentive.funding;
  const reference = `${INCENTIVE_REFERENCE_PREFIX}${String(id).slice(-8).toUpperCase()}-${attempts + 1}`;

  // Conditional on the attempt count too, so two callers can never send under one reference.
  // A row due before the stages existed has no funding record yet, so a first attempt
  // matches a missing count as well as 0.
  const claimed = await Enrollment.findOneAndUpdate(
    {
      _id: id,
      "incentive.status": "due",
      "incentive.funding.attempts": attempts || trusted({ $in: [0, null] }),
    },
    {
      $set: { "incentive.status": "funding", "incentive.funding.reference": reference },
      $inc: { "incentive.funding.attempts": 1 },
    },
    { returnDocument: "after" },
  );

  if (!claimed?.incentive) return false;

  try {
    const transfer = await createTransfer({
      bankCode,
      accountNumber,
      amount: claimed.incentive.amount,
      reference,
      narration: `INSPECTRA COURSE ${claimed.reference}`,
    });

    await Enrollment.updateOne(
      { _id: id, "incentive.funding.reference": reference },
      { $set: { "incentive.funding.transferId": transfer.id } },
    );
  } catch (error) {
    if (error instanceof TransferRejected) {
      // Refused outright, so nothing was sent: back to due for the next attempt. A low
      // balance lands here too, which is why there is no attempt limit.
      await Enrollment.updateOne(
        { _id: id, "incentive.status": "funding", "incentive.funding.reference": reference },
        { $set: { "incentive.status": "due", "incentive.funding.reference": "" } },
      );
      console.error(`Incentive ${reference} refused: ${error.message}`);
    } else {
      // Unknown whether it went out. Left funding with no transfer id: a blind retry could
      // pay twice. Needs an admin to check Flutterwave.
      console.error(`Incentive ${reference} outcome unknown, check Flutterwave:`, error);
    }
  }

  return true;
};

/**
 * Applies Flutterwave's verdict on an incentive transfer, once. Takes a transfer read back
 * from Flutterwave, never a webhook body.
 */
export const settleIncentive = async (transfer: FlwTransfer): Promise<void> => {
  const funding: QueryFilter<IEnrollment> = {
    "incentive.status": "funding",
    "incentive.funding.reference": transfer.reference,
  };

  if (transfer.status === "FAILED") {
    const failed = await Enrollment.findOneAndUpdate(funding, {
      $set: { "incentive.status": "due", "incentive.funding.reference": "" },
      $unset: { "incentive.funding.transferId": 1 },
    });

    if (failed)
      console.error(`Incentive ${transfer.reference} failed: ${transfer.complete_message ?? ""}`);
    return;
  }

  if (transfer.status !== "SUCCESSFUL") return;

  // Landed in our Planbok account: forward it to LambaCard straight away.
  const landed = await Enrollment.findOneAndUpdate(funding, {
    $set: {
      "incentive.status": "forwarding",
      "incentive.funding.transferId": transfer.id,
      "incentive.funding.sentAt": new Date(),
      "incentive.forwarding": { reference: "", attempts: 0 },
    },
  });

  if (landed) await startForwarding(landed._id);
};

// LambaCard's account is at Loma but outside Planbok's own ledger: Planbok's internal Loma
// lookup cannot find it, its external lookup on sort code 090620 can.
const LAMBACARD_DESTINATION_TYPE = "other-banks";

/**
 * The second hop: Planbok sends the ₦10,000 from our account to LambaCard's. Planbok's
 * reference for it is what the LambaCard purchase is made with. A refusal is retried; an
 * unknown outcome (sent, no reference back) waits for an admin to check Planbok.
 */
export const startForwarding = async (id: Types.ObjectId): Promise<boolean> => {
  const {
    PLANBOK_ACCOUNT_ID: accountId,
    LAMBACARD_BANK_CODE: sortCode,
    LAMBACARD_ACCOUNT_NUMBER: accountNumber,
    LAMBACARD_ACCOUNT_NAME: accountName,
  } = envConfig;

  if (!accountId || !sortCode || !accountNumber || !accountName) {
    console.error(`Incentive for enrollment ${String(id)} waits: no LambaCard account is set.`);
    return false;
  }

  const waiting: QueryFilter<IEnrollment> = {
    _id: id,
    "incentive.status": "forwarding",
    "incentive.forwarding.reference": "",
  };
  const current = await Enrollment.findOne(waiting).select("incentive");
  const attempts = current?.incentive?.forwarding?.attempts;
  if (attempts === undefined) return false;

  const reference = `${INCENTIVE_REFERENCE_PREFIX}${String(id).slice(-8).toUpperCase()}-F${attempts + 1}`;

  const claimed = await Enrollment.findOneAndUpdate(
    { ...waiting, "incentive.forwarding.attempts": attempts },
    {
      $set: { "incentive.forwarding.reference": reference },
      $inc: { "incentive.forwarding.attempts": 1 },
    },
    { returnDocument: "after" },
  );

  if (!claimed?.incentive) return false;

  try {
    const sent = await transfer(
      accountId,
      reference,
      toKobo(claimed.incentive.amount),
      LAMBACARD_DESTINATION_TYPE,
      { accountNumber, sortCode, accountName },
      `INSPECTRA COURSE ${claimed.reference}`,
    );

    if (!sent.providerReference) {
      console.error(`Incentive ${reference} sent, but Planbok gave no reference: check Planbok.`);
      return true;
    }

    await Enrollment.updateOne(
      { _id: id, "incentive.forwarding.reference": reference },
      { $set: { "incentive.forwarding.providerReference": sent.providerReference } },
    );

    await settleForwarding(id, sent.providerReference);
  } catch (error) {
    if (error instanceof PlanbokRefused) {
      // Turned down, so nothing moved: back to waiting for the next attempt. A Planbok
      // balance not yet credited lands here too.
      await Enrollment.updateOne(
        { _id: id, "incentive.status": "forwarding", "incentive.forwarding.reference": reference },
        { $set: { "incentive.forwarding.reference": "" } },
      );
    } else {
      console.error(`Incentive ${reference} outcome unknown, check Planbok:`, error);
    }
  }

  return true;
};

/**
 * Reads the forwarding transfer back from Planbok and, once it has settled for the right
 * amount, hands the incentive on to the purchase. Anything else leaves it where it is.
 */
const settleForwarding = async (id: Types.ObjectId, providerReference: string): Promise<void> => {
  const row = await Enrollment.findOne({
    _id: id,
    "incentive.status": "forwarding",
    "incentive.forwarding.providerReference": providerReference,
  }).select("incentive");

  if (!row?.incentive) return;

  let settled;
  try {
    settled = await getTransaction(envConfig.PLANBOK_ACCOUNT_ID, providerReference);
  } catch {
    return; // Not readable yet; the next sweep asks again.
  }

  if (settled.status !== "SUCCESS") {
    console.error(`Incentive forward ${providerReference} is ${settled.status}.`);
    return;
  }

  if (settled.entry !== "DEBIT" || toKobo(settled.amount) !== toKobo(row.incentive.amount)) {
    console.error(`Incentive forward ${providerReference} does not match the payout: check Planbok.`);
    return;
  }

  await Enrollment.updateOne(
    { _id: id, "incentive.status": "forwarding", "incentive.forwarding.providerReference": providerReference },
    { $set: { "incentive.status": "purchasing", "incentive.forwarding.sentAt": new Date() } },
  );
};

/**
 * Catches up on what the moment of payment could not finish: asks Flutterwave and Planbok
 * about transfers still in flight, then sends every hop still waiting (refused, failed, or
 * waiting on a balance). A hop sent with no id or reference back is left alone: its outcome
 * is unknown and only an admin checking Flutterwave or Planbok can settle it.
 */
const sweep = async (): Promise<void> => {
  const inFlight = await Enrollment.find({
    "incentive.status": "funding",
    "incentive.funding.transferId": trusted({ $exists: true }),
  }).select("incentive.funding.transferId");

  for (const { incentive } of inFlight) {
    const transferId = incentive!.funding.transferId!;

    try {
      await settleIncentive(await getTransfer(transferId));
    } catch (error) {
      console.error(`Could not read incentive transfer ${transferId}:`, error);
    }
  }

  const forwarded = await Enrollment.find({
    "incentive.status": "forwarding",
    "incentive.forwarding.providerReference": trusted({ $exists: true }),
  }).select("incentive.forwarding.providerReference");

  for (const { _id, incentive } of forwarded)
    await settleForwarding(_id, incentive!.forwarding!.providerReference!);

  const due = await Enrollment.find({ "incentive.status": "due" }).select("_id");
  let started = 0;

  for (const { _id } of due) if (await startIncentive(_id)) started += 1;

  const toForward = await Enrollment.find({
    "incentive.status": "forwarding",
    "incentive.forwarding.reference": "",
  }).select("_id");

  for (const { _id } of toForward) if (await startForwarding(_id)) started += 1;

  if (started) console.log(`Incentive sweep: started ${started} transfer(s).`);
};

const SWEEP_EVERY = 15 * 60 * 1000;
let sweeping = false;

const guardedSweep = async (): Promise<void> => {
  if (sweeping) return;
  sweeping = true;

  try {
    await sweep();
  } catch (error) {
    console.error("Incentive sweep failed:", error);
  } finally {
    sweeping = false;
  }
};

/** Once at boot, then every 15 minutes, like the escrow sweep. */
export const startIncentiveSweep = (): void => {
  void guardedSweep();
  setInterval(() => void guardedSweep(), SWEEP_EVERY).unref();
};
