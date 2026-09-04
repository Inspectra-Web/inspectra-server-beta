import type { Request, Response } from "express";

import AppError from "../error/app.error.js";
import User, { publicUser } from "../models/user.model.js";
import { sendAuthCookie } from "../services/token.service.js";
import type { LoginInput } from "../validators/auth.validator.js";

export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  const { email, password }: LoginInput = req.body;

  const user = await User.findOne({ email }).select("+password");

  if (!user || !(await user.correctPassword(password)) || user.role !== "admin")
    throw new AppError("Incorrect email or password.", 401);

  if (user.status === "suspended")
    throw new AppError("This account has been suspended. Please contact support.", 403);

  if (!user.emailVerified)
    throw new AppError("Please verify your email address before logging in.", 403);

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  sendAuthCookie(user, 200, res);
};

export const getAdminSession = (req: Request, res: Response): void => {
  res.status(200).json({ status: "success", data: { user: publicUser(req.user!) } });
};
