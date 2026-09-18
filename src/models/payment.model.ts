import { Schema, model, type HydratedDocument, type Types } from "mongoose";

import {
  CADENCES,
  TIERS,
  type Cadence,
  type Tier,
} from "./subscription.model.js";

/**
 * Certification is the other thing a realtor pays for, and it will run through this
 * same collection when its checkout lands. The union is here now because the admin
 * payments table already speaks it, not because anything writes it yet.
 */
export type PaymentKind = "subscription" | "certification";

/**
 * There is no "canceled". An attempt nobody completed is deleted, not tombstoned:
 * a row the console does not show is a row that should not be in the database, and a
 * status whose only job is to hide something fails that test. "failed" stays, because
 * that is money that was tried and refused, which is a real thing to have on record.
 */
export type PaymentStatus = "pending" | "paid" | "failed";

// Exported so the schema's enum and the request validator read the same list.
export const PAYMENT_KINDS: PaymentKind[] = ["subscription", "certification"];
export const PAYMENT_STATUSES: PaymentStatus[] = ["pending", "paid", "failed"];

export interface IPayment {
  user: Types.ObjectId;
  /** Our `tx_ref`, and the only id Flutterwave is told. Unique by construction. */
  reference: string;
  kind: PaymentKind;

  // Absent on a certification payment, which buys no tier.
  tier?: Tier;
  cadence?: Cadence;

  /** Naira we asked for, computed from the catalogue and never read off a request. */
  amount: number;
  currency: string;
  status: PaymentStatus;

  // Filled in from the verify response, never from the webhook body alone.
  flwId?: number;
  flwRef: string;
  channel: string;
  cardLast4: string;
  cardBrand: string;
  paidAt?: Date;
  failureReason: string;

  /** The span this payment actually bought, so a receipt can say what it covers. */
  periodStart?: Date;
  periodEnd?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const text = () => ({ type: String, trim: true, default: "" });

const paymentSchema = new Schema<IPayment>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "A payment must belong to a user"],
    },
    reference: {
      type: String,
      trim: true,
      unique: true,
    },
    kind: {
      type: String,
      enum: {
        values: PAYMENT_KINDS,
        message: "{VALUE} is not a valid payment kind",
      },
      default: "subscription",
    },

    tier: {
      type: String,
      enum: {
        values: TIERS,
        message: "{VALUE} is not a valid plan",
      },
    },
    cadence: {
      type: String,
      enum: {
        values: CADENCES,
        message: "{VALUE} is not a valid billing cadence",
      },
    },

    amount: {
      type: Number,
      required: [true, "A payment must carry an amount"],
      min: [1, "A payment must be greater than 0"],
    },
    currency: { type: String, trim: true, default: "NGN" },
    status: {
      type: String,
      enum: {
        values: PAYMENT_STATUSES,
        message: "{VALUE} is not a valid payment status",
      },
      default: "pending",
    },

    flwId: { type: Number },
    flwRef: text(),
    // "card", "banktransfer", "ussd", and whatever else Flutterwave adds. Free-form on
    // purpose: an enum here would reject a new payment method rather than record it.
    channel: text(),
    cardLast4: text(),
    cardBrand: text(),
    paidAt: { type: Date },
    failureReason: text(),

    periodStart: { type: Date },
    periodEnd: { type: Date },
  },
  { timestamps: true },
);

export type PaymentDoc = HydratedDocument<IPayment>;

// The realtor's billing history, newest first.
paymentSchema.index({ user: 1, createdAt: -1 });

/**
 * The reference, stamped once. Derived from the last 8 hex of the id for the same
 * reason a listing's `ref` is: unique by construction, with no retry loop and no race.
 * It is what Flutterwave knows this payment as, so it can never be re-derived.
 *
 * Mongoose 9 passes no `next`: return to continue, throw to abort. `this` is annotated
 * because the validate hook does not infer the document type.
 */
paymentSchema.pre("validate", function (this: PaymentDoc) {
  if (!this.reference) this.reference = `INS-PAY-${String(this._id).slice(-8).toUpperCase()}`;
});

/** Response allowlist: the schema has no toJSON transform, so shape it here.
 *  `user` and `flwId` stay out. One is the link back to the account, the other is
 *  Flutterwave's internal id and means nothing to the person reading a receipt.
 *
 *  Typed on the plain shape rather than the document, so the $facet rows and a
 *  hydrated doc both go through this one mapper. A second copy for the aggregation
 *  is a second thing to forget to update. */
export const publicPayment = (payment: IPayment & { _id: Types.ObjectId }) => ({
  id: payment._id,
  reference: payment.reference,
  kind: payment.kind,
  tier: payment.tier,
  cadence: payment.cadence,
  amount: payment.amount,
  currency: payment.currency,
  status: payment.status,
  channel: payment.channel,
  cardLast4: payment.cardLast4,
  cardBrand: payment.cardBrand,
  paidAt: payment.paidAt,
  periodStart: payment.periodStart,
  periodEnd: payment.periodEnd,
  createdAt: payment.createdAt,
});

const Payment = model<IPayment>("Payment", paymentSchema);

export default Payment;
