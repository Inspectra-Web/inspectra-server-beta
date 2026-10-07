import { randomUUID } from "node:crypto";

import { Schema, model, type HydratedDocument, type Types } from "mongoose";

/** A realtor's Planbok wallet (BSC, EOA) under organization custody. */
export type WalletStatus = "pending" | "active";

export const WALLET_STATUSES: WalletStatus[] = ["pending", "active"];

export interface IWallet {
  user: Types.ObjectId;
  /** `wallet-<userId>`, so it never collides with the same realtor's virtual account. */
  refId: string;
  /** Stored before Planbok is called, so a retry cannot open a second wallet. */
  idempotencyKey: string;
  status: WalletStatus;

  planbokId?: string;
  address: string;
  blockchain: string;
  activatedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const walletSchema = new Schema<IWallet>(
  {
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
  },
  { timestamps: true },
);

export type WalletDoc = HydratedDocument<IWallet>;

// Mongoose 9 passes no `next`: return to continue, throw to abort.
walletSchema.pre("validate", function (this: WalletDoc) {
  if (this.refId) return;

  this.refId = `wallet-${this.user}`;
});

/** Response allowlist. `planbokId` is what a transfer targets, so it never leaves the server. */
export const publicWallet = (wallet: WalletDoc) => ({
  address: wallet.address,
  blockchain: wallet.blockchain,
  status: wallet.status,
  activatedAt: wallet.activatedAt,
});

const Wallet = model<IWallet>("Wallet", walletSchema);

export default Wallet;
