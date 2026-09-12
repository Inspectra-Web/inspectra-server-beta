import { Schema, model } from "mongoose";
export const ID_DOCUMENTS = ["nin", "bvn"];
const text = () => ({ type: String, trim: true, default: "" });
const identitySchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: [true, "An identity check must belong to a user"],
        unique: true,
    },
    document: {
        type: String,
        enum: {
            values: ID_DOCUMENTS,
            message: "{VALUE} is not a valid identity document",
        },
    },
    last4: text(),
    legalName: text(),
    face: {
        url: text(),
        publicId: text(),
    },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date },
}, { timestamps: true });
export const publicIdentity = (identity) => ({
    verified: identity.verified,
    document: identity.document,
    legalName: identity.legalName,
    last4: identity.last4,
    verifiedPhoto: identity.face.url,
    verifiedOn: identity.verifiedAt,
});
const Identity = model("Identity", identitySchema);
export default Identity;
//# sourceMappingURL=identity.model.js.map