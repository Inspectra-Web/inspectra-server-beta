import { timingSafeEqual } from "node:crypto";

import type { Request, Response } from "express";
import { Types, type PipelineStage } from "mongoose";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Payment, {
  publicPayment,
  type IPayment,
  type PaymentDoc,
  type PaymentStatus,
} from "../models/payment.model.js";
import {
  CADENCES,
  PLANS,
  TIERS,
  planPrice,
  publicSubscription,
  type Cadence,
  type SubscriptionDoc,
  type Tier,
} from "../models/subscription.model.js";
import User, { type UserDoc } from "../models/user.model.js";
import { sendPaymentReceipt } from "../services/email.service.js";
import {
  entitlements,
  listingAllowance,
  periodFor,
  resolveSubscription,
  syncHiddenListings,
} from "../services/subscription.service.js";
import {
  listPaymentsSchema,
  paymentReferenceSchema,
  type CheckoutInput,
  type VerifyPaymentInput,
} from "../validators/payment.validator.js";

/* ------------------------------------------------------------------ *
 * Flutterwave v3, over plain fetch.
 *
 * No SDK: the server has no HTTP client at all, and Dojah and the CAC lookup are both
 * bare fetch with their helpers module-private in the controller that calls them. This
 * is the third of those, not a new pattern.
 * ------------------------------------------------------------------ */

interface FlwTransaction {
  id: number;
  tx_ref: string;
  flw_ref: string;
  amount: number;
  currency: string;
  status: string;
  payment_type?: string;
  card?: { last_4digits?: string; type?: string };
  meta?: { user?: string; tier?: string; cadence?: string };
}

const flwHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${envConfig.FLW_SECRET_KEY}`,
};

/** Opens a hosted checkout and hands back the link to send the realtor to. */
const createCharge = async (
  payment: PaymentDoc,
  user: UserDoc,
  description: string,
): Promise<string> => {
  const response = await fetch(`${envConfig.FLW_BASE_URL}/payments`, {
    method: "POST",
    headers: flwHeaders,
    body: JSON.stringify({
      tx_ref: payment.reference,
      amount: payment.amount,
      currency: payment.currency,
      // The client origin, not the API. The session cookie is only first-party there,
      // so a return to the API would land the realtor signed out.
      redirect_url: `${envConfig.CLIENT_URL}/realtor/subscription/callback`,
      customer: {
        email: user.email,
        name: user.fullname,
        phonenumber: user.phone ?? "",
      },
      customizations: { title: "INSPECTRA", description },
      // No payment_plan: that would pin the method to card, and bank transfer and USSD
      // carry real volume here. Renewal is a fresh charge, not an auto-debit.
      //
      // meta carries enough to rebuild this payment from nothing. An abandoned attempt
      // is deleted, so a realtor who leaves the tab open and pays an hour later would
      // otherwise arrive with money spent and no row to put it against.
      meta: {
        reference: payment.reference,
        user: payment.user.toString(),
        tier: payment.tier,
        cadence: payment.cadence,
      },
    }),
  });

  if (!response.ok)
    throw new AppError("We could not reach the payment service. Try again.", 502);

  const body = (await response.json()) as { status?: string; data?: { link?: string } };

  if (body.status !== "success" || !body.data?.link)
    throw new AppError("We could not start that payment. Try again.", 502);

  return body.data.link;
};

/**
 * Reads a transaction back from Flutterwave.
 *
 * Nothing is credited on anybody's say-so: not the browser's, which can put any
 * transaction id in the URL, and not the webhook's, whose header proves the sender but
 * says nothing about the amount. This call is the only trusted thing about a payment.
 */
const verifyTransaction = async (id: number): Promise<FlwTransaction> => {
  const response = await fetch(`${envConfig.FLW_BASE_URL}/transactions/${id}/verify`, {
    headers: flwHeaders,
  });

  // Flutterwave answers 400, not 404, for an id it has never seen. Both mean the id is
  // wrong rather than the service being down, and saying "we could not reach" to someone
  // holding a bad reference sends them chasing the wrong problem.
  if (response.status === 400 || response.status === 404)
    throw new AppError("We could not find that payment.", 404);

  if (!response.ok)
    throw new AppError("We could not reach the payment service. Try again.", 502);

  const body = (await response.json()) as { data?: FlwTransaction };

  if (!body.data) throw new AppError("We could not find that payment.", 404);

  return body.data;
};

/* ------------------------------------------------------------------ */

/** Narrow a string off Flutterwave's meta back into our own vocabulary. */
const tierOf = (value?: string): Tier | null => TIERS.find((t) => t === value) ?? null;

const cadenceOf = (value?: string): Cadence | null =>
  CADENCES.find((c) => c === value) ?? null;

/**
 * Rebuilds a payment whose row is gone, from the meta sent with the charge.
 *
 * An abandoned attempt is deleted rather than kept as a tombstone, which leaves one
 * opening: a realtor who leaves the Flutterwave tab open, starts another checkout, and
 * then goes back and pays the first one. The money is real and it is theirs, so the row
 * is rebuilt and credited normally. Losing a customer's payment because we tidied up
 * behind them is not a trade worth making.
 *
 * The amount is recomputed from the catalogue, never taken from the charge, so this
 * cannot become a way to mint a plan by paying a naira.
 */
const rebuildFromMeta = async (flw: FlwTransaction): Promise<PaymentDoc | null> => {
  const tier = tierOf(flw.meta?.tier);
  const cadence = cadenceOf(flw.meta?.cadence);
  const owner = flw.meta?.user;

  if (!tier || !cadence || !owner || !Types.ObjectId.isValid(owner)) return null;

  console.warn(`Rebuilding payment ${flw.tx_ref}: its attempt row was already gone.`);

  return Payment.create({
    user: new Types.ObjectId(owner),
    reference: flw.tx_ref,
    kind: "subscription",
    tier,
    cadence,
    amount: planPrice(tier, cadence),
  });
};

/** The row behind a transaction, rebuilt if a successful charge has outlived it. */
const paymentFor = async (flw: FlwTransaction): Promise<PaymentDoc | null> => {
  const existing = await Payment.findOne({ reference: flw.tx_ref });

  if (existing) return existing;
  if (flw.status !== "successful") return null;

  return rebuildFromMeta(flw);
};

/**
 * Puts a paid period onto the subscription.
 *
 * Idempotent by construction: the span is read off the payment rather than recomputed,
 * so running this twice sets the same two dates. That is what lets the redirect and the
 * webhook both call it, and what closes the window where a crash between claiming a
 * payment and applying it would leave money taken and no plan granted.
 */
const applyToSubscription = async (payment: PaymentDoc): Promise<SubscriptionDoc> => {
  const subscription = await resolveSubscription(payment.user);

  if (!payment.tier || !payment.cadence || !payment.periodEnd) return subscription;

  subscription.tier = payment.tier;
  subscription.cadence = payment.cadence;
  subscription.status = "active";
  subscription.startedAt = subscription.startedAt ?? payment.periodStart;
  subscription.currentPeriodStart = payment.periodStart;
  subscription.currentPeriodEnd = payment.periodEnd;
  // Paying clears the lapse clock outright. A renewal is active from now, not part way
  // through the grace window its own expiry opened.
  subscription.graceEndsAt = undefined;

  await subscription.save({ validateModifiedOnly: true });
  await syncHiddenListings(payment.user, subscription);

  return subscription;
};

/**
 * Turns a verified transaction into a live plan, exactly once.
 *
 * The claim is a conditional update rather than a read followed by a write: the
 * redirect and the webhook race on every single payment, and whichever loses gets null
 * back instead of granting a second period. The loser still applies the plan, because
 * that step is idempotent and re-running it is how a half-finished credit heals.
 */
const creditPayment = async (
  payment: PaymentDoc,
  flw: FlwTransaction,
): Promise<PaymentDoc> => {
  if (!payment.tier || !payment.cadence)
    throw new AppError("That payment is not for a plan.", 400);

  if (flw.tx_ref !== payment.reference)
    throw new AppError("That transaction belongs to a different payment.", 400);

  if (flw.status !== "successful") {
    await Payment.updateOne(
      { _id: payment._id, status: "pending" },
      {
        $set: {
          status: "failed",
          failureReason: flw.status,
          flwId: flw.id,
          flwRef: flw.flw_ref,
        },
      },
    );

    throw new AppError("That payment did not go through.", 402);
  }

  // What was actually paid, against what we asked for. This is the check that makes a
  // tampered checkout worthless, and the reason the amount is never read off a request.
  if (flw.currency !== payment.currency || flw.amount < payment.amount)
    throw new AppError("That payment does not match what was owed.", 400);

  const now = new Date();
  const subscription = await resolveSubscription(payment.user);

  // Renewing the same tier stacks onto the period already paid for rather than throwing
  // the remaining days away. Changing tier starts now, because the pricing page promises
  // an upgrade applies straight away.
  const renewing =
    subscription.tier === payment.tier &&
    !!subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd > now;

  const period = periodFor(
    payment.cadence,
    renewing && subscription.currentPeriodEnd ? subscription.currentPeriodEnd : now,
  );

  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: "pending" },
    {
      $set: {
        status: "paid",
        flwId: flw.id,
        flwRef: flw.flw_ref,
        channel: flw.payment_type ?? "",
        cardLast4: flw.card?.last_4digits ?? "",
        cardBrand: flw.card?.type ?? "",
        paidAt: now,
        periodStart: period.currentPeriodStart,
        periodEnd: period.currentPeriodEnd,
      },
    },
    { returnDocument: "after" },
  );

  // Lost the race. Apply anyway, then answer with what the winner wrote: the receipt is
  // the winner's to send, and nobody is thanked for the same payment twice.
  if (!claimed) {
    const settled = await Payment.findById(payment._id);

    if (settled) await applyToSubscription(settled);

    return settled ?? payment;
  }

  await applyToSubscription(claimed);

  const owner = await User.findById(claimed.user);

  if (owner && claimed.periodEnd)
    sendPaymentReceipt(owner.email, {
      reference: claimed.reference,
      plan: PLANS[payment.tier].name,
      amount: claimed.amount,
      channel: claimed.channel || "card",
      periodEnd: claimed.periodEnd,
    });

  return claimed;
};

/** The shape both a fresh verify and a replayed one answer with. */
const settledPayload = async (payment: PaymentDoc, userId: PaymentDoc["user"]) => {
  const subscription = await resolveSubscription(userId);

  return {
    payment: publicPayment(payment),
    subscription: publicSubscription(subscription),
    plan: entitlements(subscription),
    allowance: await listingAllowance(userId, subscription),
  };
};

/* ------------------------------------------------------------------ */

export const startSubscriptionCheckout = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { tier, cadence }: CheckoutInput = req.body;
  const user = req.user!;

  // Read off the catalogue, never off the request. The browser is told what it owes;
  // it does not get to say.
  const amount = planPrice(tier, cadence);

  // Starting a checkout drops any earlier one still hanging. A realtor is only ever
  // part way through one payment, and an attempt nobody completed is not a record of
  // anything: deleted, not marked, so nothing accumulates that the console never shows.
  await Payment.deleteMany({ user: user._id, status: "pending" });

  const payment = await Payment.create({
    user: user._id,
    kind: "subscription",
    tier,
    cadence,
    amount,
  });

  const link = await createCharge(
    payment,
    user,
    `${PLANS[tier].name} plan, billed ${cadence}`,
  );

  res.status(201).json({
    status: "success",
    data: { link, reference: payment.reference, amount },
  });
};

/**
 * Called by the page Flutterwave redirects back to.
 *
 * The webhook usually wins this race, so an already-paid payment is the normal case
 * here rather than an error: the realtor is simply told what is already true.
 */
export const verifyPayment = async (req: Request, res: Response): Promise<void> => {
  const { reference } = paymentReferenceSchema.parse(req.params);
  const { transactionId }: VerifyPaymentInput = req.body;
  const user = req.user!;

  const existing = await Payment.findOne({ reference });

  if (existing) {
    if (!existing.user.equals(user._id))
      throw new AppError("That payment is not yours.", 403);

    if (existing.status === "failed")
      throw new AppError("That payment did not go through.", 402);

    if (existing.status === "paid") {
      res.status(200).json({
        status: "success",
        message: "That payment is already confirmed.",
        data: await settledPayload(existing, user._id),
      });
      return;
    }
  }

  const flw = await verifyTransaction(transactionId);

  if (flw.tx_ref !== reference)
    throw new AppError("That transaction belongs to a different payment.", 400);

  // The row can legitimately be gone: starting another checkout deletes the attempt
  // this redirect is coming back from, and the realtor may have paid it anyway.
  const payment = existing ?? (await paymentFor(flw));

  if (!payment) throw new AppError("No payment with that reference.", 404);

  if (!payment.user.equals(user._id))
    throw new AppError("That payment is not yours.", 403);

  const settled = await creditPayment(payment, flw);

  res.status(200).json({
    status: "success",
    message: "Payment confirmed. Your plan is active.",
    data: await settledPayload(settled, user._id),
  });
};

/**
 * Flutterwave's own callback, and the authoritative one: it arrives whether or not the
 * realtor ever came back from their bank's page.
 */
export const flutterwaveWebhook = async (req: Request, res: Response): Promise<void> => {
  const header = req.headers["verif-hash"];
  const signature = Array.isArray(header) ? header[0] : header;
  const expected = envConfig.FLW_WEBHOOK_HASH;

  // An unset hash would wave every caller through, which is worse than having no
  // webhook at all. timingSafeEqual throws on a length mismatch, so length is checked
  // first and the comparison itself stays constant time.
  const signed =
    !!signature &&
    !!expected &&
    Buffer.byteLength(signature) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!signed) throw new AppError("That request is not from the payment service.", 401);

  const { event, data } = req.body as {
    event?: string;
    data?: { id?: number; tx_ref?: string };
  };

  if (event === "charge.completed" && data?.id && data.tx_ref) {
    // Swallowed on purpose. A signed event is always acknowledged: throwing here would
    // have Flutterwave redeliver a charge that genuinely failed, forever.
    try {
      const flw = await verifyTransaction(data.id);
      const payment = await paymentFor(flw);

      if (payment && payment.status === "pending") await creditPayment(payment, flw);
    } catch (error) {
      console.error(`Webhook credit failed for ${data.tx_ref}:`, error);
    }
  }

  // Every properly signed event gets a 200, including the ones we do nothing with, so
  // Flutterwave stops retrying messages we are never going to want.
  res.status(200).json({ status: "success" });
};

/** One payment, in full. What the receipt row opens into. */
export const getMyPayment = async (req: Request, res: Response): Promise<void> => {
  const { reference } = paymentReferenceSchema.parse(req.params);

  const payment = await Payment.findOne({ reference });

  if (!payment) throw new AppError("No payment with that reference.", 404);
  if (!payment.user.equals(req.user!._id))
    throw new AppError("That payment is not yours.", 403);

  res.status(200).json({ status: "success", data: { payment: publicPayment(payment) } });
};

/**
 * Drops an attempt the realtor decided against.
 *
 * Deleted, not marked: nothing was charged, so there is nothing to keep a record of,
 * and a row the console will never show again has no business staying in the database.
 *
 * Conditional on the row still being pending, for the same reason crediting is: a
 * webhook can land while someone is reaching for this button, and money that actually
 * arrived must win over an intention to abandon it.
 */
export const cancelMyPayment = async (req: Request, res: Response): Promise<void> => {
  const { reference } = paymentReferenceSchema.parse(req.params);

  const payment = await Payment.findOne({ reference });

  if (!payment) throw new AppError("No payment with that reference.", 404);
  if (!payment.user.equals(req.user!._id))
    throw new AppError("That payment is not yours.", 403);

  if (payment.status !== "pending")
    throw new AppError(`That payment is already ${payment.status}.`, 409);

  const dropped = await Payment.findOneAndDelete({
    _id: payment._id,
    status: "pending",
  });

  if (!dropped)
    throw new AppError("That payment completed while you were cancelling it.", 409);

  res.status(200).json({ status: "success", message: "Payment attempt dropped." });
};

interface PaymentPage {
  rows: (IPayment & { _id: Types.ObjectId })[];
  total: { count: number }[];
  statuses: { _id: PaymentStatus; count: number }[];
}

/**
 * The realtor's payments, paged and filterable.
 *
 * No status filter is applied at the head of the pipeline, deliberately. Every row this
 * collection holds for a realtor is one the console shows them, and the way an attempt
 * stops being shown is by ceasing to exist rather than by being filtered away.
 *
 * The chosen status narrows `rows` and `total` and nothing else: the `statuses` branch
 * counts the whole set, because a segmented control that empties the segment it was
 * chosen from is a control nobody can un-choose.
 */
export const listMyPayments = async (req: Request, res: Response): Promise<void> => {
  const { status, page, limit } = listPaymentsSchema.parse(req.query);

  const statusMatch: PipelineStage.FacetPipelineStage[] =
    status === "all" ? [] : [{ $match: { status } }];

  const pipeline: PipelineStage[] = [
    { $match: { user: req.user!._id } },
    {
      $facet: {
        rows: [
          ...statusMatch,
          // _id tiebreaks, so a row cannot slip between pages on equal timestamps.
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ],
        total: [...statusMatch, { $count: "count" }],
        statuses: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
      },
    },
  ];

  const [result] = await Payment.aggregate<PaymentPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  const counts: Record<PaymentStatus | "all", number> = {
    all: 0,
    pending: 0,
    paid: 0,
    failed: 0,
  };

  for (const row of result?.statuses ?? []) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  res.status(200).json({
    status: "success",
    data: {
      payments: rows.map(publicPayment),
      counts,
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};
