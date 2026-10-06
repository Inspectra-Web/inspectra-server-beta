import { randomUUID } from "node:crypto";

import { Schema, model, type HydratedDocument, type Types } from "mongoose";

/**
 * Every account is a Planbok NGN virtual account under organization custody. The two
 * house accounts are kept apart so held money is never mixed with revenue.
 */
export type AccountKind = "realtor" | "escrow" | "revenue";

/** `pending` is asked of Planbok with no account number back yet. */
export type AccountStatus = "pending" | "active";

export const ACCOUNT_KINDS: AccountKind[] = ["realtor", "escrow", "revenue"];
export const ACCOUNT_STATUSES: AccountStatus[] = ["pending", "active"];

export interface IVirtualAccount {
  kind: AccountKind;
  user?: Types.ObjectId;
  /** What Planbok knows this account as. Stamped here, never read off a request. */
  refId: string;
  /** Stored before Planbok is called, so a retry cannot open a second account. */
  idempotencyKey: string;
  status: AccountStatus;

  planbokId?: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  // The sort code a `same-bank` transfer into this account needs.
  bankCode: string;
  currency: string;
  activatedAt?: Date;
  // When the realtor agreed to an account opened with their BVN and NIN (NDPA 2023).
  consentedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const text = () => ({ type: String, trim: true, default: "" });

const virtualAccountSchema = new Schema<IVirtualAccount>(
  {
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
        function (this: IVirtualAccount) {
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
  },
  { timestamps: true },
);

export type VirtualAccountDoc = HydratedDocument<IVirtualAccount>;

// Mongoose 9 passes no `next`: return to continue, throw to abort.
virtualAccountSchema.pre("validate", function (this: VirtualAccountDoc) {
  if (this.refId) return;

  this.refId = this.kind === "realtor" ? String(this.user ?? "") : `inspectra-${this.kind}`;
});

/** Response allowlist. `planbokId` is what a transfer targets, so it never leaves the
 *  server, and `refId` and `idempotencyKey` mean nothing to the realtor. */
export const publicVirtualAccount = (account: VirtualAccountDoc) => ({
  accountNumber: account.accountNumber,
  accountName: account.accountName,
  bankName: account.bankName,
  currency: account.currency,
  status: account.status,
  activatedAt: account.activatedAt,
});

const VirtualAccount = model<IVirtualAccount>("VirtualAccount", virtualAccountSchema);

export default VirtualAccount;
