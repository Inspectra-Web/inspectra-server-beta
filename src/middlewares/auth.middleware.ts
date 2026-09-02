import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import User, { type IUser } from "../models/user.model.js";

interface TokenPayload {
  id: string;
  iat: number;
  exp: number;
}

/** Identity only. Whether the account may act is each route's business. */
export const protect = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const { authorization } = req.headers;
  let token: string | undefined;

  // slice, not split: an index would be `string | undefined` under
  // noUncheckedIndexedAccess and would not narrow.
  if (authorization?.startsWith("Bearer ")) token = authorization.slice(7);
  else if (req.cookies?.jwt) token = req.cookies.jwt as string;

  if (!token)
    throw new AppError("You are not logged in. Please log in to get access.", 401);

  const decoded = jwt.verify(token, envConfig.JWT_SECRET) as TokenPayload;

  const currentUser = await User.findById(decoded.id).select("+passwordChangedAt");

  if (!currentUser)
    throw new AppError("The user belonging to this token no longer exists.", 401);

  if (currentUser.changedPasswordAfter(decoded.iat))
    throw new AppError("Your password was recently changed. Please log in again.", 401);

  if (currentUser.status === "suspended")
    throw new AppError("This account has been suspended. Please contact support.", 403);

  req.user = currentUser;
  next();
};

/** Synchronous, so it hands the error to next() rather than throwing. */
export const restrictTo =
  (...roles: IUser["role"][]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new AppError("You do not have permission to perform this action", 403));
      return;
    }

    next();
  };
