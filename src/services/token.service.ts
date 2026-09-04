import type { CookieOptions, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";

import envConfig from "../config/env.config.js";
import { publicUser, type UserDoc } from "../models/user.model.js";

const isProduction = envConfig.NODE_ENV === "production";

export const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
};

export const sendAuthCookie = (
  user: UserDoc,
  statusCode: number,
  res: Response,
): void => {
  const token = jwt.sign({ id: user._id.toString() }, envConfig.JWT_SECRET, {
    expiresIn: envConfig.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  });

  const maxAge = Number(envConfig.JWT_COOKIE_EXPIRES_DAYS) * 24 * 60 * 60 * 1000;

  res.cookie("jwt", token, { ...cookieOptions, maxAge });
  res.status(statusCode).json({ status: "success", data: { user: publicUser(user) } });
};
