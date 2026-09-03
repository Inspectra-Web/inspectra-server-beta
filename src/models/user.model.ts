import { Schema, model, type HydratedDocument, type Model, type Types } from "mongoose";
import { createHash, randomBytes } from "crypto";
import { compare, hash } from "bcryptjs";
import validator from "validator";

const SALT_ROUNDS = 12;
const RESET_EXPIRES_MINUTES = 30;
const VERIFY_EXPIRES_HOURS = 24;

/** Reset and verify tokens are mailed raw and stored hashed. Look them up with this. */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export interface IUser {
  fullname: string;
  email: string;
  password: string;
  role: "seeker" | "realtor" | "admin";
  status: "active" | "suspended" | "pending";
  phone?: string;
  avatar: string;
  avatarId?: string;
  profile?: Types.ObjectId;
  emailVerified: boolean;
  emailVerifyToken?: string;
  emailVerifyExpires?: Date;
  passwordChangedAt?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  correctPassword(candidatePassword: string): Promise<boolean>;
  changedPasswordAfter(jwtIssuedAt: number): boolean;
  createPasswordResetToken(): string;
  createEmailVerifyToken(): string;
}

type UserModel = Model<IUser, {}, IUserMethods>;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    fullname: {
      type: String,
      required: [true, "Please tell us your name"],
      trim: true,
      lowercase: true,
    },
    email: {
      type: String,
      required: [true, "Please provide your email"],
      unique: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (value: string) => validator.isEmail(value),
        message: "Please provide a valid email",
      },
    },
    password: {
      type: String,
      required: [true, "Please provide a password"],
      minLength: [8, "Use at least 8 characters"],
      select: false,
    },
    // Admin is assigned, never self-registered: signup is gated to seeker/realtor.
    role: {
      type: String,
      enum: ["seeker", "realtor", "admin"],
      default: "seeker",
    },
    status: {
      type: String,
      enum: ["active", "suspended", "pending"],
      default: "active",
    },
    phone: { type: String, trim: true },
    avatar: { type: String, default: "" },
    // The uploaded image's Cloudinary id, kept so a replacement can delete the
    // one it replaces. Lives beside the URL it belongs to, not on the profile.
    avatarId: { type: String, default: "" },
    // Everything auth does not need lives on the profile. Set once, at register.
    profile: { type: Schema.Types.ObjectId, ref: "Profile" },
    emailVerified: { type: Boolean, default: false },
    emailVerifyToken: { type: String, select: false },
    emailVerifyExpires: { type: Date, select: false },
    passwordChangedAt: { type: Date, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  this.password = await hash(this.password, SALT_ROUNDS);

  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);
});

userSchema.methods.correctPassword = function (candidatePassword: string) {
  return compare(candidatePassword, this.password);
};

userSchema.methods.changedPasswordAfter = function (jwtIssuedAt: number) {
  if (!this.passwordChangedAt) return false;

  return Math.floor(this.passwordChangedAt.getTime() / 1000) > jwtIssuedAt;
};

userSchema.methods.createPasswordResetToken = function () {
  const resetToken = randomBytes(32).toString("hex");

  this.passwordResetToken = hashToken(resetToken);
  this.passwordResetExpires = new Date(Date.now() + RESET_EXPIRES_MINUTES * 60 * 1000);

  return resetToken;
};

userSchema.methods.createEmailVerifyToken = function () {
  const verifyToken = randomBytes(32).toString("hex");

  this.emailVerifyToken = hashToken(verifyToken);
  this.emailVerifyExpires = new Date(Date.now() + VERIFY_EXPIRES_HOURS * 60 * 60 * 1000);

  return verifyToken;
};

export type UserDoc = HydratedDocument<IUser, IUserMethods>;

/** Response allowlist: the schema has no toJSON transform, so shape it here.
 *  `avatarId` and `profile` stay out; they are plumbing, not the account. */
export const publicUser = (user: UserDoc) => ({
  id: user._id,
  fullname: user.fullname,
  email: user.email,
  role: user.role,
  status: user.status,
  avatar: user.avatar,
  phone: user.phone,
  emailVerified: user.emailVerified,
  createdAt: user.createdAt,
});

const User = model<IUser, UserModel>("User", userSchema);

export default User;
