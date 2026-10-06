import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";
export const ACCOUNT_KINDS = ["realtor", "escrow", "revenue"];
export const ACCOUNT_STATUSES = ["pending", "active"];
const text = () => ({ type: String, trim: true, default: "" });
const virtualAccountSchema = new Schema({
    kind: {
        type: String,
        enum: {
            values: ACCOUNT_KINDS,
            message: "{VALUE} is not a valid account kind",
        },
        required: [true, "An account must have a kind"],
        immutable: true,
    },
    // One virtual account per realtor. Sparse, because the house accounts belong to nobody.
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        unique: true,
        sparse: true,
        immutable: true,
        required: [
            function () {
                return this.kind === "realtor";
            },
            "A realtor account must belong to a user",
        ],
    },
    refId: { type: String, trim: true, unique: true, immutable: true },
    idempotencyKey: {
        type: String,
        unique: true,
        immutable: true,
        default: () => randomUUID(),
    },
    status: {
        type: String,
        enum: {
            values: ACCOUNT_STATUSES,
            message: "{VALUE} is not a valid account status",
        },
        default: "pending",
    },
    planbokId: { type: String, trim: true, unique: true, sparse: true },
    accountNumber: text(),
    accountName: text(),
    bankName: text(),
    bankCode: text(),
    currency: { type: String, trim: true, default: "NGN" },
    activatedAt: { type: Date },
    consentedAt: { type: Date },
}, { timestamps: true });
// Mongoose 9 passes no `next`: return to continue, throw to abort.
virtualAccountSchema.pre("validate", function () {
    if (this.refId)
        return;
    this.refId = this.kind === "realtor" ? String(this.user ?? "") : `inspectra-${this.kind}`;
});
/** Response allowlist. `planbokId` is what a transfer targets, so it never leaves the
 *  server, and `refId` and `idempotencyKey` mean nothing to the realtor. */
export const publicVirtualAccount = (account) => ({
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    bankName: account.bankName,
    currency: account.currency,
    status: account.status,
    activatedAt: account.activatedAt,
});
const VirtualAccount = model("VirtualAccount", virtualAccountSchema);
export default VirtualAccount;
//# sourceMappingURL=virtualAccount.model.js.map