import { Schema, model } from "mongoose";
const NOTE_MAX = 500;
const RESPONSE_MAX = 500;
// Exported so the schema's enum and the request validator read the same list.
export const INSPECTION_STATUSES = [
    "requested",
    "confirmed",
    "completed",
    "declined",
    "cancelled",
];
/**
 * Still live, so still blocking a second booking on the same listing and still
 * eligible for the Upcoming tab. The one definition both the partial index and the
 * controller's window read.
 */
export const ACTIVE_STATUSES = ["requested", "confirmed"];
export const PARTIES = ["seeker", "realtor"];
export const ESCROW_STATUSES = [
    "none",
    "unpaid",
    "held",
    "releasing",
    "released",
    "refunding",
    "refunded",
    "forfeited",
    "disputed",
];
export const ATTENDANCES = ["happened", "no_show"];
export const DISPUTE_OUTCOMES = ["release", "refund", "split"];
// `satisfies` keeps each message pair a tuple: Mongoose types these options as
// [value, message], and a plain array literal widens and stops type-checking.
const belongsTo = (label) => ({
    type: Schema.Types.ObjectId,
    ref: "User",
    required: [true, `An inspection must carry ${label}`],
});
const naira = () => ({
    type: Number,
    default: 0,
    min: [0, "Cannot be negative"],
    validate: { validator: Number.isInteger, message: "Must be whole naira" },
});
const confirmation = () => ({
    answer: {
        type: String,
        enum: { values: ATTENDANCES, message: "{VALUE} is not a valid answer" },
    },
    at: { type: Date },
});
const inspectionSchema = new Schema({
    property: {
        type: Schema.Types.ObjectId,
        ref: "Property",
        required: [true, "An inspection must be about a property"],
    },
    realtor: belongsTo("the realtor showing it"),
    seeker: belongsTo("the buyer who booked it"),
    slot: {
        type: Date,
        required: [true, "Pick a date and time"],
    },
    note: {
        type: String,
        trim: true,
        default: "",
        maxLength: [NOTE_MAX, `Keep your note under ${NOTE_MAX} characters`],
    },
    status: {
        type: String,
        enum: {
            values: INSPECTION_STATUSES,
            message: "{VALUE} is not a valid inspection status",
        },
        default: "requested",
    },
    response: {
        type: String,
        trim: true,
        default: "",
        maxLength: [RESPONSE_MAX, `Keep it under ${RESPONSE_MAX} characters`],
    },
    cancelledBy: {
        type: String,
        enum: { values: PARTIES, message: "{VALUE} is not a party to this booking" },
    },
    decidedAt: { type: Date },
    escrow: {
        status: {
            type: String,
            enum: { values: ESCROW_STATUSES, message: "{VALUE} is not a valid escrow status" },
            default: "none",
        },
        fee: naira(),
        commission: naira(),
        payBy: { type: Date },
        paidAt: { type: Date },
        payment: { type: Schema.Types.ObjectId, ref: "Payment" },
        confirmEmailAt: { type: Date },
        releaseAt: { type: Date },
        realtorAnswer: confirmation(),
        seekerAnswer: confirmation(),
        transferRef: { type: String, trim: true, default: "" },
        transferId: { type: Number },
        transferAttempts: { type: Number, default: 0, min: 0 },
        dispute: {
            reason: {
                type: String,
                trim: true,
                default: "",
                maxLength: [RESPONSE_MAX, `Keep it under ${RESPONSE_MAX} characters`],
            },
            openedAt: { type: Date },
            outcome: {
                type: String,
                enum: { values: DISPUTE_OUTCOMES, message: "{VALUE} is not a dispute outcome" },
            },
            note: { type: String, trim: true, default: "" },
            decidedAt: { type: Date },
        },
        settledAt: { type: Date },
    },
}, { timestamps: true });
/**
 * One live booking per listing and seeker, so a second "Book a viewing" click is
 * refused rather than filling the realtor's queue with the same buyer. Partial,
 * because a viewing that is over must not block booking the same place again.
 */
inspectionSchema.index({ property: 1, seeker: 1 }, { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } } });
// The two queues: the realtor's diary, and the buyer's own bookings.
inspectionSchema.index({ realtor: 1, status: 1, slot: 1 });
inspectionSchema.index({ seeker: 1, slot: -1 });
// The escrow sweep's lookup: what has fallen due, by state and deadline.
inspectionSchema.index({ "escrow.status": 1, "escrow.payBy": 1 });
// Spelled out so an unanswered side still reaches the client as an object.
const answerOf = (c) => ({ answer: c.answer, at: c.at });
/**
 * Response allowlist: the schema has no toJSON transform, so shape it here. Both
 * sides read this same record, which is why `cancelledBy` is a party label rather
 * than a user id: it is all the page needs to say who called it off, and neither
 * party learns the other's id, exactly as an inquiry message carries `author`.
 */
export const inspectionRecord = (inspection) => ({
    id: inspection._id,
    slot: inspection.slot,
    note: inspection.note,
    status: inspection.status,
    response: inspection.response,
    cancelledBy: inspection.cancelledBy,
    decidedAt: inspection.decidedAt,
    // The Payment id and the email bookkeeping stay out: neither side acts on them.
    escrow: {
        status: inspection.escrow.status,
        fee: inspection.escrow.fee,
        commission: inspection.escrow.commission,
        total: inspection.escrow.fee + inspection.escrow.commission,
        payBy: inspection.escrow.payBy,
        paidAt: inspection.escrow.paidAt,
        releaseAt: inspection.escrow.releaseAt,
        realtorAnswer: answerOf(inspection.escrow.realtorAnswer),
        seekerAnswer: answerOf(inspection.escrow.seekerAnswer),
        dispute: {
            reason: inspection.escrow.dispute.reason,
            openedAt: inspection.escrow.dispute.openedAt,
            outcome: inspection.escrow.dispute.outcome,
            note: inspection.escrow.dispute.note,
            decidedAt: inspection.escrow.dispute.decidedAt,
        },
        settledAt: inspection.escrow.settledAt,
    },
    createdAt: inspection.createdAt,
});
const Inspection = model("Inspection", inspectionSchema);
export default Inspection;
//# sourceMappingURL=inspection.model.js.map