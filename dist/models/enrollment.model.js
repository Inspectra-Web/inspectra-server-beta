import { Schema, model } from "mongoose";
import validator from "validator";
export const ENROLLMENT_STATUSES = ["pending", "paid", "completed"];
/** Naira per paid course that buys the realtor's LambaCard tokens. */
export const INCENTIVE_PAYOUT = 10_000;
/** Every incentive transfer is filed under this prefix, which is how the webhook tells them apart. */
export const INCENTIVE_REFERENCE_PREFIX = "INS-LBT-";
export const INCENTIVE_STATUSES = [
    "due",
    "funding",
    "forwarding",
    "purchasing",
    "confirmed",
    "rejected",
    "sent",
];
const text = () => ({ type: String, trim: true, default: "" });
const transferSchema = new Schema({
    reference: text(),
    attempts: { type: Number, default: 0 },
    transferId: { type: Number },
    providerReference: { type: String, trim: true },
    sentAt: { type: Date },
}, { _id: false });
const purchaseSchema = new Schema({
    id: { type: String, trim: true, required: true },
    status: { type: String, trim: true, required: true },
    walletAddress: { type: String, trim: true, lowercase: true, required: true },
    customerTokenUnits: { type: String, trim: true, default: "0" },
    transactionHash: { type: String, trim: true },
    explorerUrl: { type: String, trim: true },
    confirmedAt: { type: Date },
}, { _id: false });
const incentiveSchema = new Schema({
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
}, { _id: false });
const enrollmentSchema = new Schema({
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
}, { timestamps: true });
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
enrollmentSchema.pre("validate", function () {
    if (!this.reference)
        this.reference = `INS-CRS-${String(this._id).slice(-8).toUpperCase()}`;
});
/** Every course charge is filed under this prefix, which is how the webhook tells them apart. */
export const COURSE_REFERENCE_PREFIX = "INS-CRS-";
const TOKEN_SCALE = 10n ** 18n;
/** LBT base units (18 decimals) as a decimal string, "25000000000000000000" -> "25.000000000000000000". */
export const toTokenAmount = (units) => {
    const value = BigInt(units);
    return `${value / TOKEN_SCALE}.${(value % TOKEN_SCALE).toString().padStart(18, "0")}`;
};
/**
 * Which provider holds the answer when a hop went out and nothing came back: a Flutterwave
 * transfer with no id, or a Planbok transfer with no reference. Never resent on its own.
 */
const incentiveCheck = (incentive) => {
    const { status, funding, forwarding } = incentive;
    if (status === "funding" && funding?.reference && funding.transferId === undefined)
        return { provider: "flutterwave", reference: funding.reference };
    if (status === "forwarding" && forwarding?.reference && !forwarding.providerReference)
        return { provider: "planbok", reference: forwarding.reference };
    return null;
};
/** The admin table. Secrets and Flutterwave internals stay out. */
export const adminEnrollment = (e) => ({
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
export const learnerEnrollment = (e) => ({
    id: e._id,
    fullname: e.fullname,
    email: e.email,
    status: e.status,
    paidAt: e.paidAt,
    completedAt: e.completedAt,
    registered: !!e.registeredAt,
    createdAt: e.createdAt,
});
const Enrollment = model("Enrollment", enrollmentSchema);
export default Enrollment;
//# sourceMappingURL=enrollment.model.js.map