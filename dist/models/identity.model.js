import { Schema, model } from "mongoose";
// The first try plus two retries.
export const MAX_ATTEMPTS = 3;
const text = () => ({ type: String, trim: true, default: "" });
const identitySchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: [true, "An identity check must belong to a user"],
        unique: true,
    },
    firstName: text(),
    middleName: text(),
    lastName: text(),
    legalName: text(),
    dateOfBirth: text(),
    // Encrypted with services/crypto.service.ts, never returned by a query by default.
    nin: { type: String, select: false },
    bvn: { type: String, select: false },
    ninHash: { type: String, select: false, unique: true, sparse: true },
    bvnHash: { type: String, select: false, unique: true, sparse: true },
    ninLast4: text(),
    bvnLast4: text(),
    document: { type: String, enum: ["nin", "bvn"] },
    last4: text(),
    face: {
        url: text(),
        publicId: text(),
    },
    attempts: { type: Number, default: 0, min: 0 },
    // Step one passed; the names and face are set, the BVN is still to come.
    ninVerified: { type: Boolean, default: false },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date },
}, { timestamps: true });
const legacyLast4 = (identity, doc) => identity.document === doc ? identity.last4 : "";
export const publicIdentity = (identity) => ({
    verified: identity.verified,
    ninVerified: identity.ninVerified || identity.verified,
    firstName: identity.firstName,
    middleName: identity.middleName,
    lastName: identity.lastName,
    legalName: identity.legalName,
    ninLast4: identity.ninLast4 || legacyLast4(identity, "nin"),
    bvnLast4: identity.bvnLast4 || legacyLast4(identity, "bvn"),
    verifiedPhoto: identity.face.url,
    verifiedOn: identity.verifiedAt,
    attemptsLeft: identity.verified ? 0 : Math.max(MAX_ATTEMPTS - identity.attempts, 0),
    maxAttempts: MAX_ATTEMPTS,
});
const Identity = model("Identity", identitySchema);
export default Identity;
//# sourceMappingURL=identity.model.js.map