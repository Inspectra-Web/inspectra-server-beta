import type { Request, Response } from "express";
import type { PipelineStage, Types } from "mongoose";

import AppError from "../error/app.error.js";
import Identity, { publicIdentity } from "../models/identity.model.js";
import Profile, { publicProfile } from "../models/profile.model.js";
import Property, {
  detailedProperty,
  type ListingStatus,
  type VerificationStatus,
} from "../models/property.model.js";
import User, { publicUser, type IUser } from "../models/user.model.js";
import { sendAuthCookie } from "../services/token.service.js";
import {
  listListingsSchema,
  listRealtorsSchema,
  listingIdSchema,
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

  // Identity is realtor-only, so a seeker or admin never needs the lookup.
  const identity =
    user.role === "realtor" ? await Identity.findOne({ user: user._id }) : null;

  res.status(200).json({
    status: "success",
    data: {
      user: publicUser(user),
      profile: profile ? publicProfile(profile) : null,
      identity: identity ? publicIdentity(identity) : null,
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

interface RealtorRow {
  _id: Types.ObjectId;
  fullname: string;
  email: string;
  status: IUser["status"];
  avatar: string;
  city: string;
  agencyName: string;
  certified: boolean;
  identityVerified: boolean;
  createdAt: Date;
}

interface RealtorPage {
  rows: RealtorRow[];
  total: { count: number }[];
}

const realtorRow = (row: RealtorRow) => ({
  id: row._id,
  fullname: row.fullname,
  email: row.email,
  status: row.status,
  avatar: row.avatar,
  city: row.city,
  agencyName: row.agencyName,
  certified: row.certified,
  identityVerified: row.identityVerified,
  createdAt: row.createdAt,
});

export const listRealtors = async (req: Request, res: Response): Promise<void> => {
  const { q, certified, identity, status, page, limit } = listRealtorsSchema.parse(req.query);

  const accountMatch: Record<string, unknown> = { role: "realtor" };
  if (status !== "all") accountMatch.status = status;

  const pipeline: PipelineStage[] = [{ $match: accountMatch }];

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
    {
      $lookup: {
        from: "identities",
        localField: "_id",
        foreignField: "user",
        as: "identity",
      },
    },
    { $unwind: { path: "$identity", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        city: { $ifNull: ["$profile.city", ""] },
        agencyName: { $ifNull: ["$profile.agencyName", ""] },
        certified: { $ifNull: ["$profile.certified", false] },
        identityVerified: { $ifNull: ["$identity.verified", false] },
      },
    },
  );

  if (certified !== "all") pipeline.push({ $match: { certified: certified === "yes" } });

  if (identity !== "all")
    pipeline.push({ $match: { identityVerified: identity === "verified" } });

  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    pipeline.push({
      $match: {
        $or: [
          { fullname: pattern },
          { email: pattern },
          { agencyName: pattern },
          { city: pattern },
        ],
      },
    });
  }

  pipeline.push({
    $facet: {
      rows: [
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            fullname: 1,
            email: 1,
            status: 1,
            avatar: 1,
            city: 1,
            agencyName: 1,
            certified: 1,
            identityVerified: 1,
            createdAt: 1,
          },
        },
      ],
      total: [{ $count: "count" }],
    },
  });

  const [result] = await User.aggregate<RealtorPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  res.status(200).json({
    status: "success",
    data: {
      realtors: rows.map(realtorRow),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

/** A listings row: the property, plus the realtor who owns it. */
interface ListingRow {
  _id: Types.ObjectId;
  ref: string;
  title: string;
  price: number;
  listingStatus: ListingStatus;
  status: VerificationStatus;
  city: string;
  fullAddress: string;
  image: string;
  realtorId?: Types.ObjectId;
  realtorName: string;
  createdAt: Date;
}

interface ListingPage {
  rows: ListingRow[];
  total: { count: number }[];
  cities: { _id: string }[];
}

const listingRow = (row: ListingRow) => ({
  id: row._id,
  ref: row.ref,
  title: row.title,
  price: row.price,
  listingStatus: row.listingStatus,
  status: row.status,
  city: row.city,
  fullAddress: row.fullAddress,
  image: row.image,
  realtorId: row.realtorId,
  realtorName: row.realtorName,
  createdAt: row.createdAt,
});

export const listListings = async (req: Request, res: Response): Promise<void> => {
  const { q, status, city, page, limit } = listListingsSchema.parse(req.query);

  // Status filters before the lookup, so the join runs over the matched set.
  const pipeline: PipelineStage[] = [];

  if (status !== "all") pipeline.push({ $match: { "verification.status": status } });

  pipeline.push(
    {
      $lookup: { from: "users", localField: "user", foreignField: "_id", as: "realtor" },
    },
    { $unwind: { path: "$realtor", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        status: "$verification.status",
        city: { $ifNull: ["$address.city", ""] },
        fullAddress: { $ifNull: ["$address.fullAddress", ""] },
        image: { $ifNull: [{ $first: "$images.url" }, ""] },
        realtorId: "$realtor._id",
        realtorName: { $ifNull: ["$realtor.fullname", ""] },
      },
    },
  );

  // The realtor's name is searchable too: it is the column an admin scans by.
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    pipeline.push({
      $match: {
        $or: [
          { title: pattern },
          { ref: pattern },
          { fullAddress: pattern },
          { city: pattern },
          { realtorName: pattern },
        ],
      },
    });
  }

  // Repeated in both branches so the city list is not narrowed by the city already
  // chosen, which would empty the dropdown after one pick.
  const cityMatch: PipelineStage.FacetPipelineStage[] =
    city === "all" ? [] : [{ $match: { city } }];

  pipeline.push({
    $facet: {
      rows: [
        ...cityMatch,
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            ref: 1,
            title: 1,
            price: 1,
            listingStatus: 1,
            status: 1,
            city: 1,
            fullAddress: 1,
            image: 1,
            realtorId: 1,
            realtorName: 1,
            createdAt: 1,
          },
        },
      ],
      total: [...cityMatch, { $count: "count" }],
      cities: [
        { $match: { city: { $ne: "" } } },
        { $group: { _id: "$city" } },
        { $sort: { _id: 1 } },
      ],
    },
  });

  const [result] = await Property.aggregate<ListingPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  res.status(200).json({
    status: "success",
    data: {
      listings: rows.map(listingRow),
      cities: (result?.cities ?? []).map((c) => c._id),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

/**
 * One listing in full, plus who listed it. The realtor block is deliberately small:
 * the console links through to their account for the rest, and an admin reading a
 * property does not need their contact card inlined.
 */
export const getListing = async (req: Request, res: Response): Promise<void> => {
  const { id } = listingIdSchema.parse(req.params);

  const property = await Property.findById(id);

  if (!property) throw new AppError("No listing with that id.", 404);

  const [owner, profile, identity] = await Promise.all([
    User.findById(property.user),
    Profile.findOne({ user: property.user }),
    Identity.findOne({ user: property.user }),
  ]);

  res.status(200).json({
    status: "success",
    data: {
      listing: detailedProperty(property),
      // Null for a listing whose account has since been removed.
      realtor: owner && {
        id: owner._id,
        fullname: owner.fullname,
        email: owner.email,
        avatar: owner.avatar,
        status: owner.status,
        agencyName: profile?.agencyName ?? "",
        city: profile?.city ?? "",
        certified: profile?.certified ?? false,
        identityVerified: identity?.verified ?? false,
      },
    },
  });
};
