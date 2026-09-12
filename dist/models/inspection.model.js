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
// `satisfies` keeps each message pair a tuple: Mongoose types these options as
// [value, message], and a plain array literal widens and stops type-checking.
const belongsTo = (label) => ({
    type: Schema.Types.ObjectId,
    ref: "User",
    required: [true, `An inspection must carry ${label}`],
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
    createdAt: inspection.createdAt,
});
const Inspection = model("Inspection", inspectionSchema);
export default Inspection;
//# sourceMappingURL=inspection.model.js.map