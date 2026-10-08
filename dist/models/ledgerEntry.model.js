import { Schema, model } from "mongoose";
export const LEDGER_DIRECTIONS = ["credit", "debit"];
export const LEDGER_KINDS = [
    "deposit",
    "release",
    "commission",
    "withdrawal",
    "refund",
    "reversal",
];
const text = () => ({ type: String, trim: true, default: "" });
const ledgerEntrySchema = new Schema({
    account: {
        type: Schema.Types.ObjectId,
        ref: "VirtualAccount",
        required: [true, "A ledger entry must belong to an account"],
    },
    direction: {
        type: String,
        enum: {
            values: LEDGER_DIRECTIONS,
            message: "{VALUE} is not a valid direction",
        },
        required: [true, "A ledger entry must be a credit or a debit"],
    },
    kind: {
        type: String,
        enum: {
            values: LEDGER_KINDS,
            message: "{VALUE} is not a valid ledger entry kind",
        },
        required: [true, "A ledger entry must have a kind"],
    },
    amount: {
        type: Number,
        required: [true, "A ledger entry must carry an amount"],
        min: [1, "A ledger entry must be greater than 0"],
        validate: {
            validator: Number.isInteger,
            message: "A ledger amount must be whole kobo",
        },
    },
    reference: { type: String, trim: true, unique: true },
    idempotencyKey: {
        type: String,
        trim: true,
        unique: true,
        required: [true, "A ledger entry must carry an idempotency key"],
    },
    planbokReference: text(),
    flwReference: text(),
    inspection: { type: Schema.Types.ObjectId, ref: "Inspection" },
    payment: { type: Schema.Types.ObjectId, ref: "Payment" },
    narration: text(),
}, { timestamps: { createdAt: true, updatedAt: false } });
// An account's history, newest first, with the tiebreaker the facet rule asks for.
ledgerEntrySchema.index({ account: 1, createdAt: -1, _id: -1 });
ledgerEntrySchema.pre("validate", function () {
    if (!this.reference)
        this.reference = `INS-LED-${String(this._id).slice(-8).toUpperCase()}`;
});
const appendOnly = () => {
    throw new Error("Ledger entries are append-only: post a reversal instead");
};
ledgerEntrySchema.pre("save", function () {
    if (!this.isNew)
        appendOnly();
});
ledgerEntrySchema.pre([
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
], appendOnly);
ledgerEntrySchema.pre(["updateOne", "deleteOne"], { document: true, query: false }, appendOnly);
export const publicLedgerEntry = (entry) => ({
    id: entry._id,
    direction: entry.direction,
    kind: entry.kind,
    amount: entry.amount,
    reference: entry.reference,
    narration: entry.narration,
    createdAt: entry.createdAt,
});
const LedgerEntry = model("LedgerEntry", ledgerEntrySchema);
export default LedgerEntry;
//# sourceMappingURL=ledgerEntry.model.js.map