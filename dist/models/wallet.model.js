import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";
export const WALLET_STATUSES = ["pending", "active"];
const walletSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        unique: true,
        immutable: true,
        required: [true, "A wallet must belong to a user"],
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
            values: WALLET_STATUSES,
            message: "{VALUE} is not a valid wallet status",
        },
        default: "pending",
    },
    planbokId: { type: String, trim: true, unique: true, sparse: true },
    address: { type: String, trim: true, default: "" },
    blockchain: { type: String, trim: true, default: "BSC" },
    activatedAt: { type: Date },
}, { timestamps: true });
// Mongoose 9 passes no `next`: return to continue, throw to abort.
walletSchema.pre("validate", function () {
    if (this.refId)
        return;
    this.refId = `wallet-${this.user}`;
});
/** Response allowlist. `planbokId` is what a transfer targets, so it never leaves the server. */
export const publicWallet = (wallet) => ({
    address: wallet.address,
    blockchain: wallet.blockchain,
    status: wallet.status,
    activatedAt: wallet.activatedAt,
});
const Wallet = model("Wallet", walletSchema);
export default Wallet;
//# sourceMappingURL=wallet.model.js.map