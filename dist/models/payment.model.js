import { Schema, model } from "mongoose";
import { CADENCES, TIERS, } from "./subscription.model.js";
// Exported so the schema's enum and the request validator read the same list.
export const PAYMENT_KINDS = ["subscription", "certification"];
export const PAYMENT_STATUSES = ["pending", "paid", "failed"];
const text = () => ({ type: String, trim: true, default: "" });
const paymentSchema = new Schema({
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
}, { timestamps: true });
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
paymentSchema.pre("validate", function () {
    if (!this.reference)
        this.reference = `INS-PAY-${String(this._id).slice(-8).toUpperCase()}`;
});
/** Response allowlist: the schema has no toJSON transform, so shape it here.
 *  `user` and `flwId` stay out. One is the link back to the account, the other is
 *  Flutterwave's internal id and means nothing to the person reading a receipt.
 *
 *  Typed on the plain shape rather than the document, so the $facet rows and a
 *  hydrated doc both go through this one mapper. A second copy for the aggregation
 *  is a second thing to forget to update. */
export const publicPayment = (payment) => ({
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
const Payment = model("Payment", paymentSchema);
export default Payment;
//# sourceMappingURL=payment.model.js.map