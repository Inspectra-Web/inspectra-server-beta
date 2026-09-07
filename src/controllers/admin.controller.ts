import type { Request, Response } from "express";
import type { PipelineStage, Types } from "mongoose";

import AppError from "../error/app.error.js";
import Profile, { publicProfile } from "../models/profile.model.js";
import User, { publicUser, type IUser } from "../models/user.model.js";
import { sendAuthCookie } from "../services/token.service.js";
import {
  listUsersSchema,
  userIdSchema,
  type UserStatusInput,
} from "../validators/admin.validator.js";
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

/** A directory row: the account, plus the city that lives on its profile. */
interface DirectoryRow {
  _id: Types.ObjectId;
  fullname: string;
  email: string;
  role: IUser["role"];
  status: IUser["status"];
  avatar: string;
  city: string;
  createdAt: Date;
}

interface DirectoryPage {
  rows: DirectoryRow[];
  total: { count: number }[];
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const directoryUser = (row: DirectoryRow) => ({
  id: row._id,
  fullname: row.fullname,
  email: row.email,
  role: row.role,
  status: row.status,
  avatar: row.avatar,
  city: row.city,
  createdAt: row.createdAt,
});

export const listUsers = async (req: Request, res: Response): Promise<void> => {
  const { q, role, status, page, limit } = listUsersSchema.parse(req.query);

  const accountMatch: Record<string, unknown> = {};
  if (role !== "all") accountMatch.role = role;
  if (status !== "all") accountMatch.status = status;

  const pipeline: PipelineStage[] = [];

  if (Object.keys(accountMatch).length) pipeline.push({ $match: accountMatch });

  pipeline.push(
    {
      $lookup: {
        from: "profiles",
        localField: "_id",
        foreignField: "user",
        as: "profile",
      },
    },
    { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
    { $addFields: { city: { $ifNull: ["$profile.city", ""] } } },
  );

  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    pipeline.push({
      $match: { $or: [{ fullname: pattern }, { email: pattern }, { city: pattern }] },
    });
  }

  pipeline.push({
    $facet: {
      // _id breaks ties so a row cannot slip between pages on equal timestamps.
      rows: [
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            fullname: 1,
            email: 1,
            role: 1,
            status: 1,
            avatar: 1,
            city: 1,
            createdAt: 1,
          },
        },
      ],
      total: [{ $count: "count" }],
    },
  });

  const [result] = await User.aggregate<DirectoryPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  res.status(200).json({
    status: "success",
    data: {
      users: rows.map(directoryUser),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

export const getUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = userIdSchema.parse(req.params);

  const user = await User.findById(id);

  if (!user) throw new AppError("No user with that id.", 404);

  const profile = await Profile.findOne({ user: user._id });

  res.status(200).json({
    status: "success",
    data: {
      user: publicUser(user),
      profile: profile ? publicProfile(profile) : null,
    },
  });
};

export const updateUserStatus = async (req: Request, res: Response): Promise<void> => {
  const { id } = userIdSchema.parse(req.params);
  const { status }: UserStatusInput = req.body;

  const user = await User.findById(id);

  if (!user) throw new AppError("No user with that id.", 404);

  if (user.role === "admin")
    throw new AppError("An admin account's status cannot be changed here.", 403);

  if (user.status === status)
    throw new AppError(`This account is already ${status}.`, 409);

  user.status = status;
  await user.save({ validateModifiedOnly: true });

  res.status(200).json({
    status: "success",
    message: status === "suspended" ? "Account suspended." : "Account reactivated.",
    data: { user: publicUser(user) },
  });
};
