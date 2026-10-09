import { trusted, type QueryFilter } from "mongoose";

import Inspection, {
  type Attendance,
  type DisputeOutcome,
  type IInspection,
  type InspectionDoc,
  type Party,
} from "../models/inspection.model.js";
import LedgerEntry, { type ILedgerEntry } from "../models/ledgerEntry.model.js";
import Payment, { type PaymentDoc } from "../models/payment.model.js";
import Property from "../models/property.model.js";
import User from "../models/user.model.js";
import VirtualAccount, { type VirtualAccountDoc } from "../models/virtualAccount.model.js";
import {
  sendAttendanceCheck,
  sendDisputeDecided,
  sendDisputeNotice,
  sendDisputeOpened,
  sendFeeReleased,
  sendInspectionUnpaid,
  sendRefundIssued,
  sendViewingForfeited,
  type InspectionBrief,
} from "./email.service.js";
import {
  createRefund,
  createTransfer,
  getRefund,
  getTransfer,
  refundDone,
  TransferRejected,
  type FlwRefund,
  type FlwTransfer,
} from "./flutterwave.service.js";

/** INSPECTRA's commission, added on top of the realtor's fee. Mirrored on the client. */
export const COMMISSION_RATE = 0.2;

const HOUR = 60 * 60 * 1000;
const PAY_WINDOW = 24 * HOUR;
const PAY_BEFORE_SLOT = 2 * HOUR;

export const commissionOn = (fee: number): number => Math.round(fee * COMMISSION_RATE);

/** The seeker pays within 24h of confirmation and at least 2h before the slot. */
export const payByFor = (slot: Date, from = new Date()): Date =>
  new Date(Math.min(from.getTime() + PAY_WINDOW, slot.getTime() - PAY_BEFORE_SLOT));

/**
 * Locks the price onto a booking as the realtor confirms it. A booking that already
 * carries a price keeps it, so editing the listing cannot reprice a viewing in flight;
 * an unpaid one only gets a fresh deadline for its new time. Held money is left alone.
 * Returns false when a paid viewing is too close to its slot to collect in time.
 */
export const priceOnConfirm = (inspection: InspectionDoc, listingFee: number): boolean => {
  const { escrow } = inspection;

  if (escrow.status === "none") {
    if (listingFee <= 0) return true;

    escrow.fee = listingFee;
    escrow.commission = commissionOn(listingFee);
    escrow.status = "unpaid";
  }

  if (escrow.status !== "unpaid") return true;

  const payBy = payByFor(inspection.slot);

  if (payBy.getTime() <= Date.now()) return false;

  escrow.payBy = payBy;

  return true;
};

/**
 * A house ledger book: `escrow` holds seekers' money, `revenue` the commission. Both
 * live inside INSPECTRA's Flutterwave balance and are never opened on Planbok.
 */
const houseBook = async (kind: "escrow" | "revenue"): Promise<VirtualAccountDoc> =>
  (await VirtualAccount.findOneAndUpdate(
    { refId: `inspectra-${kind}` },
    { $setOnInsert: { kind, refId: `inspectra-${kind}`, status: "active" } },
    { upsert: true, returnDocument: "after" },
  ))!;

const DUPLICATE_KEY = 11000;

/**
 * Moves a paid booking's escrow to `held` and books the money in, exactly once.
 *
 * Both writes are safe to repeat, which is what lets the redirect and the webhook both
 * call this. The hold is conditional on `unpaid`; the deposit is keyed on the payment,
 * so a second post hits the unique index and is ignored.
 *
 * Money that lands on a booking no longer waiting for it (cancelled for not paying in
 * time, say) is still deposited, because it is in our balance either way, and the
 * booking is flagged for a refund rather than silently held.
 */
export const holdEscrow = async (payment: PaymentDoc): Promise<InspectionDoc | null> => {
  const held = await Inspection.findOneAndUpdate(
    { _id: payment.inspection, status: "confirmed", "escrow.status": "unpaid" },
    {
      $set: {
        "escrow.status": "held",
        "escrow.paidAt": payment.paidAt ?? new Date(),
        "escrow.payment": payment._id,
      },
    },
    { returnDocument: "after" },
  );

  const inspection = held ?? (await Inspection.findById(payment.inspection));

  if (!held && !inspection?.escrow.payment?.equals(payment._id))
    console.error(
      `Payment ${payment.reference} arrived for inspection ${String(payment.inspection)} ` +
        `in escrow state "${inspection?.escrow.status ?? "missing"}". Needs a refund.`,
    );

  const book = await houseBook("escrow");

  await post({
    account: book._id,
    direction: "credit",
    kind: "deposit",
    amount: payment.amount * 100,
    idempotencyKey: `deposit:${payment.reference}`,
    inspection: payment.inspection,
    payment: payment._id,
    narration: `Inspection payment ${payment.reference}`,
  });

  return inspection;
};

/** Posts one ledger entry; a repeat of the same key is the unique index saying "done". */
const post = async (entry: Partial<ILedgerEntry>): Promise<void> => {
  try {
    await LedgerEntry.create(entry);
  } catch (error) {
    if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
  }
};

/* ------------------------------------------------------------------ *
 * The sweep: the escrow's clock. Each job finds what is due and moves it with a
 * conditional update on the state it expects, so a second sweep, a second instance
 * or a seeker acting at the same moment cannot apply it twice.
 * ------------------------------------------------------------------ */

/**
 * Cancels confirmed viewings whose fee was not paid by the deadline. `cancelledBy` is
 * left unset: neither party called it off. The escrow stays `unpaid` with its price, so
 * a payment that lands later is not held but deposited and flagged for a refund.
 */
export const expireUnpaid = async (now = new Date()): Promise<number> => {
  const due: QueryFilter<IInspection> = {
    status: "confirmed",
    "escrow.status": "unpaid",
    "escrow.payBy": trusted({ $lte: now }),
  };

  const candidates = await Inspection.find(due).select("_id");
  let expired = 0;

  for (const { _id } of candidates) {
    const inspection = await Inspection.findOneAndUpdate(
      { ...due, _id },
      { $set: { status: "cancelled", decidedAt: now } },
      { returnDocument: "after" },
    );

    if (!inspection) continue;
    expired += 1;

    const people = await partiesOf(inspection);
    if (!people) continue;

    sendInspectionUnpaid(people.seeker.email, people.about("realtor"), "seeker");
    sendInspectionUnpaid(people.realtor.email, people.about("seeker"), "realtor");
  }

  return expired;
};

/**
 * Both people on a booking and the listing, for mail. `about(side)` is the brief a
 * mail names that side in, so the seeker's copy is about the realtor and vice versa.
 */
const partiesOf = async (inspection: InspectionDoc) => {
  const [property, seeker, realtor] = await Promise.all([
    Property.findById(inspection.property).select("ref title"),
    User.findById(inspection.seeker).select("email fullname"),
    User.findById(inspection.realtor).select("email fullname"),
  ]);

  if (!property || !seeker || !realtor) return null;

  const about = (side: Party): InspectionBrief => ({
    id: String(inspection._id),
    ref: property.ref,
    property: property.title,
    person: side === "seeker" ? seeker.fullname : realtor.fullname,
    slot: inspection.slot,
    message: "",
  });

  return { seeker, realtor, about };
};

/* ------------------------------------------------------------------ *
 * The day after: both sides say whether the viewing happened.
 * ------------------------------------------------------------------ */

const AUTO_RELEASE_AFTER = 48 * HOUR;
// Lagos is UTC+1 all year, so 9am there is 8am UTC.
const CHECK_HOUR_UTC = 8;

/** 9am Lagos time on the day after the slot, Lagos calendar. */
export const attendanceCheckAt = (slot: Date): Date => {
  const lagos = new Date(slot.getTime() + HOUR);

  return new Date(
    Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate() + 1, CHECK_HOUR_UTC),
  );
};

/**
 * Records one side's answer and opens a dispute when the two cannot both be true.
 * Mutates the document; the caller saves it. A realtor saying it happened also closes
 * the booking out, which is what "Mark as done" always meant.
 *
 * Only disagreement acts here. Agreement, silence and an unanswered no-show are left
 * `held` for the release and forfeit jobs, which read these same answers.
 */
export const recordAttendance = (
  inspection: InspectionDoc,
  side: Party,
  answer: Attendance,
): string | null => {
  const { escrow } = inspection;
  const now = new Date();

  escrow[side === "seeker" ? "seekerAnswer" : "realtorAnswer"] = { answer, at: now };

  if (side === "realtor" && answer === "happened" && inspection.status === "confirmed") {
    inspection.status = "completed";
    inspection.decidedAt = now;
  }

  const seeker = escrow.seekerAnswer.answer;
  const realtor = escrow.realtorAnswer.answer;

  const reason =
    seeker === "no_show"
      ? "The buyer says the realtor did not show up."
      : realtor === "no_show" && seeker === "happened"
        ? "The realtor says the buyer did not show up; the buyer says the viewing happened."
        : null;

  if (reason) {
    escrow.status = "disputed";
    escrow.dispute.reason = reason;
    escrow.dispute.openedAt = now;
  }

  return reason;
};

/** Tells the admins and the other side that a dispute has opened. */
export const announceDispute = async (
  inspection: InspectionDoc,
  raisedBy: Party,
  reason: string,
): Promise<void> => {
  const people = await partiesOf(inspection);
  if (!people) return;

  sendDisputeOpened(people.about("seeker"), reason);

  if (raisedBy === "seeker")
    sendDisputeNotice(people.realtor.email, people.about("seeker"), "realtor");
  else sendDisputeNotice(people.seeker.email, people.about("realtor"), "seeker");
};

/**
 * Emails both sides of each held viewing once its check time has come, and starts the
 * 48-hour auto-release clock. A side that has already answered is not asked again.
 */
export const sendAttendanceChecks = async (now = new Date()): Promise<number> => {
  const waiting: QueryFilter<IInspection> = {
    status: trusted({ $in: ["confirmed", "completed"] }),
    "escrow.status": "held",
    "escrow.confirmEmailAt": trusted({ $exists: false }),
    slot: trusted({ $lte: now }),
  };

  const candidates = await Inspection.find(waiting).select("_id slot");
  let sent = 0;

  for (const { _id, slot } of candidates) {
    if (attendanceCheckAt(slot) > now) continue;

    const inspection = await Inspection.findOneAndUpdate(
      { ...waiting, _id },
      {
        $set: {
          "escrow.confirmEmailAt": now,
          "escrow.releaseAt": new Date(now.getTime() + AUTO_RELEASE_AFTER),
        },
      },
      { returnDocument: "after" },
    );

    if (!inspection) continue;
    sent += 1;

    const people = await partiesOf(inspection);
    if (!people) continue;

    if (!inspection.escrow.seekerAnswer.answer)
      sendAttendanceCheck(people.seeker.email, people.about("realtor"), "seeker");
    if (!inspection.escrow.realtorAnswer.answer)
      sendAttendanceCheck(people.realtor.email, people.about("seeker"), "realtor");
  }

  return sent;
};

/* ------------------------------------------------------------------ *
 * Release: the realtor's fee leaves INSPECTRA's Flutterwave balance for their
 * virtual account. The commission never moves; the ledger just books it as revenue.
 * ------------------------------------------------------------------ */

const MAX_TRANSFER_ATTEMPTS = 3;

/** The answer-driven rules stand aside once an admin has decided a dispute. */
const undecided = { "escrow.dispute.outcome": trusted({ $exists: false }) };

/**
 * Held viewings whose fee is now the realtor's (decisions 5 and 6): both sides said it
 * happened; the realtor did and the seeker let the 48 hours run out; or the seeker
 * cancelled after paying. A realtor's silence never releases anything.
 */
const releasable = (now: Date): QueryFilter<IInspection> => ({
  "escrow.status": "held",
  "escrow.transferAttempts": trusted({ $lt: MAX_TRANSFER_ATTEMPTS }),
  $or: [
    { ...undecided, "escrow.realtorAnswer.answer": "happened", "escrow.seekerAnswer.answer": "happened" },
    {
      ...undecided,
      "escrow.realtorAnswer.answer": "happened",
      "escrow.seekerAnswer.answer": trusted({ $exists: false }),
      "escrow.releaseAt": trusted({ $lte: now }),
    },
    { ...undecided, status: "cancelled", cancelledBy: "seeker" },
    // An admin decided the dispute for the realtor, in full or in part.
    { "escrow.dispute.outcome": trusted({ $in: ["release", "split"] }) },
  ],
});

/**
 * Claims one viewing (`held` -> `releasing`) and asks Flutterwave to pay the realtor.
 * The transfer counts only once Flutterwave reports it successful (`settleTransfer`).
 */
const startRelease = async (id: InspectionDoc["_id"], now: Date): Promise<boolean> => {
  const current = await Inspection.findById(id).select("realtor escrow.transferAttempts");
  if (!current) return false;

  const account = await VirtualAccount.findOne({ user: current.realtor, status: "active" });

  if (!account?.accountNumber || !account.bankCode) {
    console.error(`Release of inspection ${String(id)} waits: the realtor has no active account.`);
    return false;
  }

  const attempt = current.escrow.transferAttempts + 1;
  const reference = `INS-REL-${String(id).slice(-8).toUpperCase()}-${attempt}`;

  const inspection = await Inspection.findOneAndUpdate(
    { ...releasable(now), _id: id },
    {
      $set: { "escrow.status": "releasing", "escrow.transferRef": reference },
      $inc: { "escrow.transferAttempts": 1 },
    },
    { returnDocument: "after" },
  );

  if (!inspection) return false;

  try {
    const transfer = await createTransfer({
      bankCode: account.bankCode,
      accountNumber: account.accountNumber,
      amount: inspection.escrow.releaseAmount ?? inspection.escrow.fee,
      reference,
      narration: `INSPECTRA inspection fee ${reference}`,
    });

    await Inspection.updateOne(
      { _id: id, "escrow.transferRef": reference },
      { $set: { "escrow.transferId": transfer.id } },
    );
  } catch (error) {
    if (error instanceof TransferRejected) {
      // Refused outright, so nothing was sent: back to held, and the next sweep tries
      // again under a new reference until the attempts run out.
      await Inspection.updateOne(
        { _id: id, "escrow.status": "releasing", "escrow.transferRef": reference },
        { $set: { "escrow.status": "held", "escrow.transferRef": "" } },
      );
      console.error(`Release ${reference} refused: ${error.message}`);
    } else {
      // Unknown whether it went out. Left `releasing` with no transfer id, because a
      // blind retry could pay twice. Needs an admin to check Flutterwave.
      console.error(`Release ${reference} outcome unknown, check Flutterwave:`, error);
    }
  }

  return true;
};

export const releaseDue = async (now = new Date()): Promise<number> => {
  const candidates = await Inspection.find(releasable(now)).select("_id");
  let started = 0;

  for (const { _id } of candidates) if (await startRelease(_id, now)) started += 1;

  return started;
};

/**
 * Applies Flutterwave's verdict on a release transfer, once. Called from the webhook
 * and from the sweep's poll, with a transfer read back from Flutterwave, never a
 * webhook body. Success books the ledger and tells the realtor; failure returns the
 * money to `held` for another attempt.
 */
export const settleTransfer = async (transfer: FlwTransfer): Promise<void> => {
  const releasing: QueryFilter<IInspection> = {
    "escrow.status": "releasing",
    "escrow.transferRef": transfer.reference,
  };

  if (transfer.status === "FAILED") {
    const failed = await Inspection.findOneAndUpdate(releasing, {
      $set: { "escrow.status": "held", "escrow.transferRef": "" },
      $unset: { "escrow.transferId": 1 },
    });

    if (failed)
      console.error(`Release ${transfer.reference} failed: ${transfer.complete_message ?? ""}`);
    return;
  }

  if (transfer.status !== "SUCCESSFUL") return;

  const now = new Date();
  const inspection = await Inspection.findOneAndUpdate(
    releasing,
    {
      $set: {
        "escrow.status": "released",
        "escrow.transferId": transfer.id,
        "escrow.settledAt": now,
      },
    },
    { returnDocument: "after" },
  );

  if (!inspection) return;

  const { commission } = inspection.escrow;
  // A split pays the realtor only their share; the rest goes back to the seeker next.
  const fee = inspection.escrow.releaseAmount ?? inspection.escrow.fee;
  const [escrow, revenue, realtor] = await Promise.all([
    houseBook("escrow"),
    houseBook("revenue"),
    VirtualAccount.findOne({ user: inspection.realtor }),
  ]);
  const ref = transfer.reference;

  // Two legs each: the fee out of escrow into the realtor's account, the commission
  // out of escrow into revenue. Keyed per leg, so a second settle posts nothing.
  const leg = (
    account: VirtualAccountDoc["_id"],
    direction: "credit" | "debit",
    kind: "release" | "commission",
    naira: number,
    key: string,
  ) =>
    post({
      account,
      direction,
      kind,
      amount: naira * 100,
      idempotencyKey: `${ref}:${key}`,
      inspection: inspection._id,
      flwReference: ref,
      narration: `${kind === "release" ? "Inspection fee" : "Commission"} ${ref}`,
    });

  await leg(escrow._id, "debit", "release", fee, "escrow-out");
  if (realtor) await leg(realtor._id, "credit", "release", fee, "realtor-in");
  await leg(escrow._id, "debit", "commission", commission, "commission-out");
  await leg(revenue._id, "credit", "commission", commission, "commission-in");

  const people = await partiesOf(inspection);
  if (people) sendFeeReleased(people.realtor.email, people.about("seeker"), fee);

  if (inspection.escrow.dispute.outcome === "split") await startRefund(inspection._id);
};

/** Catches transfers whose webhook never arrived by asking Flutterwave directly. */
export const pollReleases = async (): Promise<void> => {
  const inFlight = await Inspection.find({
    "escrow.status": "releasing",
    "escrow.transferId": trusted({ $exists: true }),
  }).select("escrow.transferId");

  for (const { escrow } of inFlight) {
    try {
      await settleTransfer(await getTransfer(escrow.transferId!));
    } catch (error) {
      console.error(`Could not read transfer ${escrow.transferId}:`, error);
    }
  }
};

/* ------------------------------------------------------------------ *
 * Refunds and forfeits: the seeker's money when the viewing failed on one side.
 * ------------------------------------------------------------------ */

const MAX_REFUND_ATTEMPTS = 3;
const CONTEST_WINDOW = 48 * HOUR;

/**
 * Viewings whose seeker is owed money back: the realtor cancelled, or declined a time
 * the seeker moved a paid viewing to (decision 8); an admin decided a dispute for the
 * seeker; or a split whose realtor share has already gone out.
 */
const refundable = (): QueryFilter<IInspection> => ({
  "escrow.refundAttempts": trusted({ $lt: MAX_REFUND_ATTEMPTS }),
  $or: [
    { ...undecided, "escrow.status": "held", status: "cancelled", cancelledBy: "realtor" },
    { ...undecided, "escrow.status": "held", status: "declined" },
    { "escrow.status": "held", "escrow.dispute.outcome": "refund" },
    { "escrow.status": "released", "escrow.dispute.outcome": "split" },
  ],
});

/**
 * Claims one viewing (-> `refunding`) and asks Flutterwave to return the payment, or a
 * split's share of it, to the seeker's original method. A refund that does not go out
 * puts the viewing back in the state it was claimed from, so the sweep can retry it.
 */
export const startRefund = async (id: InspectionDoc["_id"]): Promise<boolean> => {
  const claimed = await Inspection.findOneAndUpdate(
    { ...refundable(), _id: id },
    { $set: { "escrow.status": "refunding" }, $inc: { "escrow.refundAttempts": 1 } },
    { returnDocument: "before" },
  );

  if (!claimed) return false;

  const { escrow } = claimed;
  const from = escrow.status;
  const amount = escrow.refundAmount ?? escrow.fee + escrow.commission;

  const payment = await Payment.findById(escrow.payment).select("flwId");
  const back: QueryFilter<IInspection> = { _id: id, "escrow.status": "refunding" };

  if (!payment?.flwId) {
    await Inspection.updateOne(back, { $set: { "escrow.status": from } });
    console.error(`Refund of inspection ${String(id)} waits: no Flutterwave charge on record.`);
    return false;
  }

  try {
    const refund = await createRefund(payment.flwId, amount);

    await Inspection.updateOne(back, { $set: { "escrow.refundId": refund.id } });
    await settleRefund(refund);
  } catch (error) {
    if (error instanceof TransferRejected) {
      await Inspection.updateOne(back, { $set: { "escrow.status": from } });
      console.error(`Refund of inspection ${String(id)} refused: ${error.message}`);
    } else {
      console.error(`Refund of inspection ${String(id)} outcome unknown, check Flutterwave:`, error);
    }
  }

  return true;
};

export const refundDue = async (): Promise<number> => {
  const candidates = await Inspection.find(refundable()).select("_id");
  let started = 0;

  for (const { _id } of candidates) if (await startRefund(_id)) started += 1;

  return started;
};

/** Marks a refund done once Flutterwave says so; books it and tells the seeker, once. */
export const settleRefund = async (refund: FlwRefund): Promise<void> => {
  if (!refundDone(refund)) return;

  const inspection = await Inspection.findOneAndUpdate(
    { "escrow.status": "refunding", "escrow.refundId": refund.id },
    { $set: { "escrow.status": "refunded", "escrow.settledAt": new Date() } },
    { returnDocument: "after" },
  );

  if (!inspection) return;

  const total =
    inspection.escrow.refundAmount ?? inspection.escrow.fee + inspection.escrow.commission;
  const escrow = await houseBook("escrow");

  await post({
    account: escrow._id,
    direction: "debit",
    kind: "refund",
    amount: total * 100,
    idempotencyKey: `refund:${refund.id}`,
    inspection: inspection._id,
    flwReference: String(refund.id),
    narration: `Refund to the seeker, Flutterwave refund ${refund.id}`,
  });

  const people = await partiesOf(inspection);
  if (people) sendRefundIssued(people.seeker.email, people.about("realtor"), total);
};

export const pollRefunds = async (): Promise<void> => {
  const inFlight = await Inspection.find({
    "escrow.status": "refunding",
    "escrow.refundId": trusted({ $exists: true }),
  }).select("escrow.refundId");

  for (const { escrow } of inFlight) {
    try {
      await settleRefund(await getRefund(escrow.refundId!));
    } catch (error) {
      console.error(`Could not read refund ${escrow.refundId}:`, error);
    }
  }
};

/**
 * Decision 7: the realtor said the seeker didn't show, and the seeker let 48 hours pass
 * without contesting it. INSPECTRA keeps the whole payment; nothing leaves the balance,
 * the ledger just moves it from escrow to revenue.
 */
export const forfeitDue = async (now = new Date()): Promise<number> => {
  const due: QueryFilter<IInspection> = {
    "escrow.status": "held",
    "escrow.realtorAnswer.answer": "no_show",
    "escrow.seekerAnswer.answer": trusted({ $exists: false }),
    "escrow.realtorAnswer.at": trusted({ $lte: new Date(now.getTime() - CONTEST_WINDOW) }),
  };

  const candidates = await Inspection.find(due).select("_id");
  let forfeited = 0;

  for (const { _id } of candidates) {
    const inspection = await Inspection.findOneAndUpdate(
      { ...due, _id },
      { $set: { "escrow.status": "forfeited", "escrow.settledAt": now } },
      { returnDocument: "after" },
    );

    if (!inspection) continue;
    forfeited += 1;

    const total = (inspection.escrow.fee + inspection.escrow.commission) * 100;
    const [escrow, revenue] = await Promise.all([houseBook("escrow"), houseBook("revenue")]);
    const key = `forfeit:${String(inspection._id)}`;
    const shared = { kind: "forfeit" as const, amount: total, inspection: inspection._id };

    await post({
      ...shared,
      account: escrow._id,
      direction: "debit",
      idempotencyKey: `${key}:out`,
      narration: "Seeker no-show, kept",
    });
    await post({
      ...shared,
      account: revenue._id,
      direction: "credit",
      idempotencyKey: `${key}:in`,
      narration: "Seeker no-show, kept",
    });

    const people = await partiesOf(inspection);
    if (people) sendViewingForfeited(people.seeker.email, people.about("realtor"));
  }

  return forfeited;
};

/* ------------------------------------------------------------------ *
 * Disputes: an admin's decision, carried out by the same release and refund paths.
 * ------------------------------------------------------------------ */

/**
 * Records an admin's decision on a disputed viewing and starts the money moving.
 * The viewing goes back to `held` carrying the outcome, which is what the release and
 * refund rules key on, so a transfer or refund that fails is retried by the sweep
 * exactly like any other. A split pays the realtor `realtorShare` of the fee first,
 * then refunds the rest of the fee; INSPECTRA keeps the commission.
 */
export const decideDispute = async (
  id: InspectionDoc["_id"],
  outcome: DisputeOutcome,
  note: string,
  realtorShare?: number,
): Promise<InspectionDoc | null> => {
  const now = new Date();
  const set: Record<string, unknown> = {
    "escrow.status": "held",
    "escrow.dispute.outcome": outcome,
    "escrow.dispute.note": note,
    "escrow.dispute.decidedAt": now,
  };

  const current = await Inspection.findById(id).select("escrow.fee escrow.status");
  if (!current || current.escrow.status !== "disputed") return null;

  if (outcome === "split") {
    const share = realtorShare ?? 0;
    set["escrow.releaseAmount"] = share;
    set["escrow.refundAmount"] = current.escrow.fee - share;
  }

  const inspection = await Inspection.findOneAndUpdate(
    { _id: id, "escrow.status": "disputed" },
    { $set: set },
    { returnDocument: "after" },
  );

  if (!inspection) return null;

  const people = await partiesOf(inspection);
  if (people) {
    sendDisputeDecided(people.seeker.email, people.about("realtor"), "seeker", inspection.escrow);
    sendDisputeDecided(people.realtor.email, people.about("seeker"), "realtor", inspection.escrow);
  }

  // Act now rather than wait up to 15 minutes for the sweep.
  if (outcome === "refund") await startRefund(inspection._id);
  else await startRelease(inspection._id, now);

  return Inspection.findById(id);
};

const SWEEP_EVERY = 15 * 60 * 1000;
let sweeping = false;

const sweep = async (): Promise<void> => {
  // One at a time: a slow run must not overlap the next tick.
  if (sweeping) return;
  sweeping = true;

  try {
    const expired = await expireUnpaid();
    if (expired) console.log(`Escrow sweep: ${expired} unpaid viewing(s) cancelled.`);

    const checked = await sendAttendanceChecks();
    if (checked) console.log(`Escrow sweep: asked about ${checked} viewing(s).`);

    await pollReleases();
    const released = await releaseDue();
    if (released) console.log(`Escrow sweep: started ${released} release(s).`);

    await pollRefunds();
    const refunded = await refundDue();
    if (refunded) console.log(`Escrow sweep: started ${refunded} refund(s).`);

    const forfeited = await forfeitDue();
    if (forfeited) console.log(`Escrow sweep: ${forfeited} no-show(s) kept.`);
  } catch (error) {
    console.error("Escrow sweep failed:", error);
  } finally {
    sweeping = false;
  }
};

/**
 * Runs once at boot, then every 15 minutes. In-process rather than a cron service:
 * if the host sleeps, the first run on waking catches up on everything that fell due,
 * so a deadline is only ever late, never missed.
 */
export const startEscrowSweep = (): void => {
  void sweep();
  setInterval(() => void sweep(), SWEEP_EVERY).unref();
};
