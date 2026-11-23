import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import validator from "validator";

/**
 * One person buying the realtor course. The account is opened at checkout and linked
 * through `registeredUser`; rows from before that were bought by guests, so the row still
 * carries its own payment instead of a `Payment`. The verify-then-claim discipline is the
 * same.
 *
 * Two secrets ride on it, stored only as hashes: `access` opens the video, and `invite`
 * opens realtor sign-up for a guest row with no account yet. course.service derives both
 * from the id.
 */

export type EnrollmentStatus = "pending" | "paid" | "completed";
export const ENROLLMENT_STATUSES: EnrollmentStatus[] = ["pending", "paid", "completed"];

/** Naira per paid course that buys the realtor's LambaCard tokens. */
export const INCENTIVE_PAYOUT = 10_000;
/** Every incentive transfer is filed under this prefix, which is how the webhook tells them apart. */
export const INCENTIVE_REFERENCE_PREFIX = "INS-LBT-";

/**
 * due → funding (Flutterwave to our Planbok account) → forwarding (Planbok to LambaCard)
 * → purchasing (LambaCard buys the tokens) → confirmed, or rejected by LambaCard.
 * `sent` is the payout before the Planbok hop existed: paid straight to LambaCard, no purchase.
 */
export type IncentiveStatus = "due" | "funding" | "forwarding" | "purchasing" | "confirmed" | "rejected" | "sent";
export const INCENTIVE_STATUSES: IncentiveStatus[] = [
  "due",
  "funding",
  "forwarding",
  "purchasing",
  "confirmed",
  "rejected",
  "sent",
];

/** One transfer hop. `reference` is ours and empty between attempts. */
export interface IIncentiveTransfer {
  reference: string;
  attempts: number;
  /** Flutterwave's transfer id. */
  transferId?: number;
  /** Planbok's transaction reference, which the LambaCard purchase is made with. */
  providerReference?: string;
  sentAt?: Date;
}

/** The LambaCard purchase, as last read back from LambaCard. */
export interface IIncentivePurchase {
  id: string;
  status: string;
  walletAddress: string;
  /** LBT in base units (18 decimals), a string because it outgrows a number. */
  customerTokenUnits: string;
  transactionHash?: string;
  explorerUrl?: string;
  confirmedAt?: Date;
}

/** The token incentive. Absent on enrollments paid before it existed or priced too low. */
export interface IIncentive {
  amount: number;
  status: IncentiveStatus;
  funding: IIncentiveTransfer;
  /** Started by an admin from money already in our Planbok account, so there is no funding hop. */
  fromBalance?: boolean;
  forwarding?: IIncentiveTransfer;
  purchase?: IIncentivePurchase;
  /** Only on `sent` rows. */
  sentAt?: Date;
}

export interface IEnrollment {
  fullname: string;
  email: string;
  phone: string;
  status: EnrollmentStatus;

  /** Our `tx_ref`, and the only id Flutterwave is told. */
  reference: string;
  /** Naira asked for, read off the course when the checkout opened. */
  amount: number;
  currency: string;

  // Filled from Flutterwave's verify response, never from a webhook body.
  flwId?: number;
  flwRef: string;
  channel: string;
  paidAt?: Date;
  failureReason: string;

  accessHash?: string;
  inviteHash?: string;
  /** Lessons watched, from when watching was tracked (until 2026-11-17). Kept, no longer written or read. */
  watchedLessons: Types.ObjectId[];
  completedAt?: Date;
  /** When the account was linked: at checkout, or when a guest's invite was used. */
  registeredAt?: Date;
  /** The account this enrollment belongs to. */
  registeredUser?: Types.ObjectId;

  incentive?: IIncentive;

  createdAt: Date;
  updatedAt: Date;
}

export type EnrollmentDoc = HydratedDocument<IEnrollment>;

const text = () => ({ type: String, trim: true, default: "" });

const transferSchema = new Schema<IIncentiveTransfer>(
  {
    reference: text(),
    attempts: { type: Number, default: 0 },
    transferId: { type: Number },
    providerReference: { type: String, trim: true },
    sentAt: { type: Date },
  },
  { _id: false },
);

const purchaseSchema = new Schema<IIncentivePurchase>(
  {
    id: { type: String, trim: true, required: true },
    status: { type: String, trim: true, required: true },
    walletAddress: { type: String, trim: true, lowercase: true, required: true },
    customerTokenUnits: { type: String, trim: true, default: "0" },
    transactionHash: { type: String, trim: true },
    explorerUrl: { type: String, trim: true },
    confirmedAt: { type: Date },
  },
  { _id: false },
);

const incentiveSchema = new Schema<IIncentive>(
  {
    amount: { type: Number, required: true, min: [1, "An amount must be greater than 0"] },
    status: {
      type: String,
      enum: { values: INCENTIVE_STATUSES, message: "{VALUE} is not a valid payout status" },
      default: "due",
    },
    funding: { type: transferSchema, default: () => ({}) },
    fromBalance: { type: Boolean },
    forwarding: { type: transferSchema },
    purchase: { type: purchaseSchema },
    sentAt: { type: Date },
  },
  { _id: false },
);

const enrollmentSchema = new Schema<IEnrollment>(
  {
    fullname: { type: String, trim: true, required: [true, "Enter your full name"] },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: [true, "Enter your email"],
      validate: [validator.isEmail, "Enter a valid email"],
    },
    phone: { type: String, trim: true, required: [true, "Enter your phone number"] },
    status: {
      type: String,
      enum: { values: ENROLLMENT_STATUSES, message: "{VALUE} is not a valid enrollment status" },
      default: "pending",
    },

    reference: { type: String, trim: true, unique: true },
    amount: {
      type: Number,
      required: [true, "An enrollment must carry an amount"],
      min: [1, "An amount must be greater than 0"],
    },
    currency: { type: String, trim: true, default: "NGN" },

    flwId: { type: Number },
    flwRef: text(),
    channel: text(),
    paidAt: { type: Date },
    failureReason: text(),

    accessHash: { type: String, select: false },
    inviteHash: { type: String, select: false },
    watchedLessons: { type: [Schema.Types.ObjectId], default: [] },
    completedAt: { type: Date },
    registeredAt: { type: Date },
    registeredUser: { type: Schema.Types.ObjectId, ref: "User" },

    incentive: { type: incentiveSchema },
  },
  { timestamps: true },
);

// The secrets are looked up by hash. Sparse: a pending row has neither yet.
enrollmentSchema.index({ accessHash: 1 }, { unique: true, sparse: true });
enrollmentSchema.index({ inviteHash: 1 }, { unique: true, sparse: true });
// The admin table, newest first, and the one-checkout-per-email sweep.
enrollmentSchema.index({ createdAt: -1, _id: -1 });
enrollmentSchema.index({ email: 1, status: 1 });
// A signed-in realtor's own enrollment.
enrollmentSchema.index({ registeredUser: 1, createdAt: -1 });
// The sweep's payouts still to send or still in flight.
enrollmentSchema.index({ "incentive.status": 1 }, { sparse: true });
// A LambaCard webhook names its purchase.
enrollmentSchema.index({ "incentive.purchase.id": 1 }, { unique: true, sparse: true });

/** Stamped once, from the id, like a payment's. Mongoose 9 passes no `next`. */
enrollmentSchema.pre("validate", function (this: EnrollmentDoc) {
  if (!this.reference) this.reference = `INS-CRS-${String(this._id).slice(-8).toUpperCase()}`;
});

/** Every course charge is filed under this prefix, which is how the webhook tells them apart. */
export const COURSE_REFERENCE_PREFIX = "INS-CRS-";

type EnrollmentRow = IEnrollment & { _id: Types.ObjectId };

const TOKEN_SCALE = 10n ** 18n;

/** LBT base units (18 decimals) as a decimal string, "25000000000000000000" -> "25.000000000000000000". */
export const toTokenAmount = (units: string) => {
  const value = BigInt(units);
  return `${value / TOKEN_SCALE}.${(value % TOKEN_SCALE).toString().padStart(18, "0")}`;
};

/**
 * Which provider holds the answer when a hop went out and nothing came back: a Flutterwave
 * transfer with no id, or a Planbok transfer with no reference. Never resent on its own.
 */
const incentiveCheck = (incentive: IIncentive) => {
  const { status, funding, forwarding } = incentive;

  if (status === "funding" && funding?.reference && funding.transferId === undefined)
    return { provider: "flutterwave" as const, reference: funding.reference };

  if (status === "forwarding" && forwarding?.reference && !forwarding.providerReference)
    return { provider: "planbok" as const, reference: forwarding.reference };

  return null;
};

/** The admin table. Secrets and Flutterwave internals stay out. */
export const adminEnrollment = (e: EnrollmentRow) => ({
  id: e._id,
  fullname: e.fullname,
  email: e.email,
  phone: e.phone,
  status: e.status,
  reference: e.reference,
  amount: e.amount,
  paidAt: e.paidAt,
  completedAt: e.completedAt,
  registered: !!e.registeredAt,
  createdAt: e.createdAt,
  incentive: e.incentive && {
    status: e.incentive.status,
    amount: e.incentive.amount,
    /** Only on `sent` rows, paid straight to LambaCard before the purchase existed. */
    sentAt: e.incentive.sentAt,
    check: incentiveCheck(e.incentive),
    fromBalance: !!e.incentive.fromBalance,
    // Each hop's references, which is what an admin searches Flutterwave, Planbok or
    // LambaCard by.
    funding: e.incentive.funding && {
      reference: e.incentive.funding.reference,
      transferId: e.incentive.funding.transferId,
      sentAt: e.incentive.funding.sentAt,
    },
    forwarding: e.incentive.forwarding && {
      reference: e.incentive.forwarding.reference,
      providerReference: e.incentive.forwarding.providerReference,
      sentAt: e.incentive.forwarding.sentAt,
    },
    purchase: e.incentive.purchase && {
      id: e.incentive.purchase.id,
      status: e.incentive.purchase.status,
      tokens: toTokenAmount(e.incentive.purchase.customerTokenUnits),
      walletAddress: e.incentive.purchase.walletAddress,
      transactionHash: e.incentive.purchase.transactionHash,
      explorerUrl: e.incentive.purchase.explorerUrl,
      confirmedAt: e.incentive.purchase.confirmedAt,
    },
  },
});

/** What the learner's own page needs about themselves. */
export const learnerEnrollment = (e: EnrollmentRow) => ({
  id: e._id,
  fullname: e.fullname,
  email: e.email,
  status: e.status,
  paidAt: e.paidAt,
  completedAt: e.completedAt,
  registered: !!e.registeredAt,
  createdAt: e.createdAt,
});

const Enrollment = model<IEnrollment>("Enrollment", enrollmentSchema);

export default Enrollment;
