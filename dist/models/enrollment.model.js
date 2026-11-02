import { Schema, model } from "mongoose";
import validator from "validator";
export const ENROLLMENT_STATUSES = ["pending", "paid", "completed"];
const text = () => ({ type: String, trim: true, default: "" });
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
    completedAt: { type: Date },
    registeredAt: { type: Date },
    registeredUser: { type: Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });
// The secrets are looked up by hash. Sparse: a pending row has neither yet.
enrollmentSchema.index({ accessHash: 1 }, { unique: true, sparse: true });
enrollmentSchema.index({ inviteHash: 1 }, { unique: true, sparse: true });
// The admin table, newest first, and the one-checkout-per-email sweep.
enrollmentSchema.index({ createdAt: -1, _id: -1 });
enrollmentSchema.index({ email: 1, status: 1 });
/** Stamped once, from the id, like a payment's. Mongoose 9 passes no `next`. */
enrollmentSchema.pre("validate", function () {
    if (!this.reference)
        this.reference = `INS-CRS-${String(this._id).slice(-8).toUpperCase()}`;
});
/** Every course charge is filed under this prefix, which is how the webhook tells them apart. */
export const COURSE_REFERENCE_PREFIX = "INS-CRS-";
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