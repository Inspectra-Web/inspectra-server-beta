import type { Request, Response } from "express";
import { trusted } from "mongoose";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import User, { hashToken, publicUser } from "../models/user.model.js";
import { sendResetEmail, sendVerifyEmail } from "../services/email.service.js";
import { ensureProfile } from "../services/profile.service.js";
import { cookieOptions, sendAuthCookie } from "../services/token.service.js";
import type {
  EmailOnlyInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdatePasswordInput,
  VerifyTokenInput,
} from "../validators/auth.validator.js";

export const register = async (req: Request, res: Response): Promise<void> => {
  const { fullname, email, password, role }: RegisterInput = req.body;

  const user = new User({ fullname, email, password, role });
  const verifyToken = user.createEmailVerifyToken();

  await user.save();

  await ensureProfile(user);

  await sendVerifyEmail(
    user.email,
    `${envConfig.CLIENT_URL}/verify-email?token=${verifyToken}`,
  );

  res.status(201).json({
    status: "success",
    message: "Account created. Check your email to verify your address.",
    data: { user: publicUser(user) },
  });
};

export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  const { token }: VerifyTokenInput = req.body;

  const user = await User.findOne({
    emailVerifyToken: hashToken(token),
    // trusted(): db.config sets sanitizeFilter, which would wrap this $gt in $eq.
    emailVerifyExpires: trusted({ $gt: new Date() }),
  }).select("+emailVerifyToken +emailVerifyExpires");

  if (!user) throw new AppError("Verification link is invalid or has expired.", 400);

  user.emailVerified = true;
  user.emailVerifyToken = undefined;
  user.emailVerifyExpires = undefined;

  await user.save({ validateBeforeSave: false });

  res.status(200).json({
    status: "success",
    message: "Email verified. You can now log in.",
  });
};

export const resendVerification = async (req: Request, res: Response): Promise<void> => {
  const { email }: EmailOnlyInput = req.body;

  const user = await User.findOne({ email });

  if (user && !user.emailVerified) {
    const verifyToken = user.createEmailVerifyToken();
    await user.save({ validateBeforeSave: false });

    await sendVerifyEmail(
      user.email,
      `${envConfig.CLIENT_URL}/verify-email?token=${verifyToken}`,
    );
  }

  // Same answer either way: whether an address is registered is not public.
  res.status(200).json({
    status: "success",
    message: "If that email needs verification, a new link is on its way.",
  });
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password }: LoginInput = req.body;

  const user = await User.findOne({ email }).select("+password");

  // One message for both failures, so this cannot be used to probe for accounts.
  if (!user || !(await user.correctPassword(password)))
    throw new AppError("Incorrect email or password.", 401);

  if (user.status === "suspended")
    throw new AppError("This account has been suspended. Please contact support.", 403);

  // After the password check, so it tells an attacker nothing they lack.
  if (!user.emailVerified)
    throw new AppError("Please verify your email address before logging in.", 403);

  if (user.role === "admin")
    throw new AppError("Admins sign in at the admin console.", 403);

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  sendAuthCookie(user, 200, res);
};

export const logout = (_req: Request, res: Response): void => {
  res.clearCookie("jwt", cookieOptions);
  res.status(200).json({ status: "success", message: "Logged out successfully." });
};

export const getMe = (req: Request, res: Response): void => {
  res.status(200).json({ status: "success", data: { user: publicUser(req.user!) } });
};

export const updatePassword = async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, password }: UpdatePasswordInput = req.body;

  // protect deliberately leaves the hash unselected, so refetch it here.
  const user = await User.findById(req.user!._id).select("+password");

  if (!user || !(await user.correctPassword(currentPassword)))
    throw new AppError("Your current password is incorrect.", 401);

  user.password = password;
  await user.save();

  // The save invalidated every token issued before it, this caller's included.
  sendAuthCookie(user, 200, res);
};

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  const { email }: EmailOnlyInput = req.body;

  const user = await User.findOne({ email });

  if (user && user.status !== "suspended") {
    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    try {
      await sendResetEmail(
        user.email,
        `${envConfig.CLIENT_URL}/reset-password?token=${resetToken}`,
      );
    } catch {
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });

      throw new AppError("Could not send the reset email. Please try again later.", 500);
    }
  }

  res.status(200).json({
    status: "success",
    message: "If an account exists for that email, a reset link is on its way.",
  });
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  const { token, password }: ResetPasswordInput = req.body;

  const user = await User.findOne({
    passwordResetToken: hashToken(token),
    passwordResetExpires: trusted({ $gt: new Date() }),
  }).select("+passwordResetToken +passwordResetExpires");

  if (!user) throw new AppError("Reset link is invalid or has expired.", 400);

  if (user.status === "suspended")
    throw new AppError("This account has been suspended. Please contact support.", 403);

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;

  await user.save();

  // No auto-login: verification stays the gate, and the client sends them to sign in.
  res.status(200).json({
    status: "success",
    message: "Password updated. Please log in with your new password.",
  });
};
