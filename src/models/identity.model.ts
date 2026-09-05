import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export type IdDocument = "nin" | "bvn";

export const ID_DOCUMENTS: IdDocument[] = ["nin", "bvn"];

export interface IIdentity {
  user: Types.ObjectId;
  document?: IdDocument;
  last4: string;
  legalName: string;
  face: { url: string; publicId: string };
  verified: boolean;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const text = () => ({ type: String, trim: true, default: "" });

const identitySchema = new Schema<IIdentity>(
  {
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
  },
  { timestamps: true },
);

export type IdentityDoc = HydratedDocument<IIdentity>;

export const publicIdentity = (identity: IdentityDoc) => ({
  verified: identity.verified,
  document: identity.document,
  legalName: identity.legalName,
  last4: identity.last4,
  verifiedPhoto: identity.face.url,
  verifiedOn: identity.verifiedAt,
});

const Identity = model<IIdentity>("Identity", identitySchema);

export default Identity;
