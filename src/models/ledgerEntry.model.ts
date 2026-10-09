import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export type LedgerDirection = "credit" | "debit";

export type LedgerKind =
  | "deposit"
  | "release"
  | "commission"
  | "withdrawal"
  | "refund"
  | "forfeit"
  | "reversal";

export const LEDGER_DIRECTIONS: LedgerDirection[] = ["credit", "debit"];
export const LEDGER_KINDS: LedgerKind[] = [
  "deposit",
  "release",
  "commission",
  "withdrawal",
  "refund",
  "forfeit",
  "reversal",
];

/**
 * One confirmed naira movement on one account. Append-only: a mistake is corrected
 * with a `reversal` entry, never an edit, so the balance is always the sum of the rows.
 * A transfer still in flight is not an entry yet.
 */
export interface ILedgerEntry {
  account: Types.ObjectId;
  direction: LedgerDirection;
  kind: LedgerKind;
  /** Integer kobo. Planbok's "5000.00" is formatted from this at the boundary. */
  amount: number;
  reference: string;
  /** One entry per operation, so a retried release cannot post twice. */
  idempotencyKey: string;
  planbokReference: string;
  /** The Flutterwave transfer or refund that moved escrow money, when one did. */
  flwReference: string;
  inspection?: Types.ObjectId;
  payment?: Types.ObjectId;
  narration: string;
  createdAt: Date;
}

const text = () => ({ type: String, trim: true, default: "" });

const ledgerEntrySchema = new Schema<ILedgerEntry>(
  {
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
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type LedgerEntryDoc = HydratedDocument<ILedgerEntry>;

// An account's history, newest first, with the tiebreaker the facet rule asks for.
ledgerEntrySchema.index({ account: 1, createdAt: -1, _id: -1 });

ledgerEntrySchema.pre("validate", function (this: LedgerEntryDoc) {
  if (!this.reference) this.reference = `INS-LED-${String(this._id).slice(-8).toUpperCase()}`;
});

const appendOnly = () => {
  throw new Error("Ledger entries are append-only: post a reversal instead");
};

ledgerEntrySchema.pre("save", function (this: LedgerEntryDoc) {
  if (!this.isNew) appendOnly();
});

ledgerEntrySchema.pre(
  [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
  ],
  appendOnly,
);

ledgerEntrySchema.pre(["updateOne", "deleteOne"], { document: true, query: false }, appendOnly);

export const publicLedgerEntry = (entry: ILedgerEntry & { _id: Types.ObjectId }) => ({
  id: entry._id,
  direction: entry.direction,
  kind: entry.kind,
  amount: entry.amount,
  reference: entry.reference,
  narration: entry.narration,
  createdAt: entry.createdAt,
});

const LedgerEntry = model<ILedgerEntry>("LedgerEntry", ledgerEntrySchema);

export default LedgerEntry;
