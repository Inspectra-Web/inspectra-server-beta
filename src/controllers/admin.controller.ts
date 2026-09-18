import type { Request, Response } from "express";
import type { PipelineStage, Types } from "mongoose";

import AppError from "../error/app.error.js";
import Agency, { publicAgency, type AgencyDoc } from "../models/agency.model.js";
import type { ReviewAddressInput } from "../validators/agency.validator.js";
import Identity, { publicIdentity } from "../models/identity.model.js";
import Profile, { publicProfile } from "../models/profile.model.js";
import Property, {
  detailedProperty,
  type ListingStatus,
  type VerificationStatus,
} from "../models/property.model.js";
import Payment, {
  type PaymentDoc,
  type PaymentStatus,
} from "../models/payment.model.js";
import Subscription, {
  PLANS,
  isPaid,
  publicSubscription,
  type Cadence,
  type Tier,
} from "../models/subscription.model.js";
import User, { publicUser, type IUser } from "../models/user.model.js";
import { sendListingReviewed } from "../services/email.service.js";
import {
  entitlements,
  listingAllowance,
  periodFor,
  resolveSubscription,
  syncHiddenListings,
} from "../services/subscription.service.js";
import { sendAuthCookie } from "../services/token.service.js";
import {
  listListingsSchema,
  listRealtorsSchema,
  listingIdSchema,
  listUsersSchema,
  userIdSchema,
  type ReviewListingInput,
  type UserStatusInput,
} from "../validators/admin.validator.js";
import type { LoginInput } from "../validators/auth.validator.js";
import {
  listAdminPaymentsSchema,
  paymentReferenceSchema,
} from "../validators/payment.validator.js";
import type { SetSubscriptionInput } from "../validators/subscription.validator.js";

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
  roles: { _id: IUser["role"]; count: number }[];
  statuses: { _id: IUser["status"]; count: number }[];
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

  // Role and status are applied inside the facet rather than at the head, so the two
  // count branches below see every account. It is the only way to satisfy the standing
  // rule that choosing a segment cannot zero the others, and it is the same trade-off
  // listListings took: the profiles $lookup now runs over the wider set.
  const roleMatch: PipelineStage.FacetPipelineStage[] =
    role === "all" ? [] : [{ $match: { role } }];
  const statusMatch: PipelineStage.FacetPipelineStage[] =
    status === "all" ? [] : [{ $match: { status } }];

  const pipeline: PipelineStage[] = [];

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
        ...roleMatch,
        ...statusMatch,
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
      total: [...roleMatch, ...statusMatch, { $count: "count" }],
      roles: [{ $group: { _id: "$role", count: { $sum: 1 } } }],
      statuses: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
    },
  });

  const [result] = await User.aggregate<DirectoryPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  const counts = {
    all: 0,
    seeker: 0,
    realtor: 0,
    admin: 0,
    active: 0,
    suspended: 0,
    pending: 0,
  };

  // `all` is summed from the roles branch alone: every account carries exactly one
  // role, so counting both branches would double it.
  for (const row of result?.roles ?? []) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  for (const row of result?.statuses ?? []) counts[row._id] += row.count;

  res.status(200).json({
    status: "success",
    data: {
      users: rows.map(directoryUser),
      counts,
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

/**
 * publicAgency plus the bill itself. Private to this controller: a realtor never needs
 * the file back, but an admin settling a dispute has to see what was submitted.
 */
const adminAgency = (agency: AgencyDoc) => ({
  ...publicAgency(agency),
  bill: agency.address.document.url,
});

/**
 * The manual half of agency verification. A Nigerian utility bill names the supply, not
 * reliably the occupier (shared compounds, the landlord's name, a bank-app prepaid
 * receipt), so there is nothing an API could match on: a person reads it against the
 * meter number and answers yes or no. Nothing is copied off the bill.
 */
export const reviewRealtorAddress = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = userIdSchema.parse(req.params);
  const { status, reason }: ReviewAddressInput = req.body;

  const user = await User.findById(id);

  if (!user) throw new AppError("No user with that id.", 404);
  if (user.role !== "realtor")
    throw new AppError("That account is not a realtor.", 400);

  const agency = await Agency.findOne({ user: user._id });

  if (!agency?.address.document.url)
    throw new AppError("That realtor has not sent a bill.", 404);

  if (agency.address.status === status)
    throw new AppError(`That address is already ${status}.`, 409);

  agency.address.status = status;
  // The reviewer's reason only survives while the flag does.
  agency.address.reason = status === "flagged" ? (reason ?? "") : "";
  agency.address.verifiedAt = status === "verified" ? new Date() : undefined;
  agency.address.reviewedBy = req.user!._id;

  await agency.save();

  res.status(200).json({
    status: "success",
    message:
      status === "verified"
        ? "That address is verified."
        : "That bill was flagged and the realtor can send another.",
    data: { agency: adminAgency(agency) },
  });
};

export const getUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = userIdSchema.parse(req.params);

  const user = await User.findById(id);

  if (!user) throw new AppError("No user with that id.", 404);

  const profile = await Profile.findOne({ user: user._id });

  // Identity and agency are realtor-only, so a seeker or admin never needs the lookups.
  const realtor = user.role === "realtor";
  const identity = realtor ? await Identity.findOne({ user: user._id }) : null;
  const agency = realtor ? await Agency.findOne({ user: user._id }) : null;

  res.status(200).json({
    status: "success",
    data: {
      user: publicUser(user),
      profile: profile ? publicProfile(profile) : null,
      identity: identity ? publicIdentity(identity) : null,
      agency: agency ? adminAgency(agency) : null,
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
  statuses: { _id: IUser["status"]; count: number }[];
  certified: { count: number }[];
  identity: { count: number }[];
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

  // role stays in the head: it is what makes this the realtor directory rather than a
  // filter on it. The three real filters move into the facet so the count branches
  // below see every realtor, the way listUsers and listListings do.
  const statusMatch: PipelineStage.FacetPipelineStage[] =
    status === "all" ? [] : [{ $match: { status } }];

  const pipeline: PipelineStage[] = [{ $match: { role: "realtor" } }];

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

  const certifiedMatch: PipelineStage.FacetPipelineStage[] =
    certified === "all" ? [] : [{ $match: { certified: certified === "yes" } }];

  const identityMatch: PipelineStage.FacetPipelineStage[] =
    identity === "all"
      ? []
      : [{ $match: { identityVerified: identity === "verified" } }];

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
        ...statusMatch,
        ...certifiedMatch,
        ...identityMatch,
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
      total: [
        ...statusMatch,
        ...certifiedMatch,
        ...identityMatch,
        { $count: "count" },
      ],
      statuses: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
      certified: [{ $match: { certified: true } }, { $count: "count" }],
      identity: [{ $match: { identityVerified: true } }, { $count: "count" }],
    },
  });

  const [result] = await User.aggregate<RealtorPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  const counts = {
    all: 0,
    certified: result?.certified[0]?.count ?? 0,
    identityVerified: result?.identity[0]?.count ?? 0,
    active: 0,
    suspended: 0,
    pending: 0,
  };

  // Every realtor carries exactly one status, so this branch is also the head count.
  for (const row of result?.statuses ?? []) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  res.status(200).json({
    status: "success",
    data: {
      realtors: rows.map(realtorRow),
      counts,
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
  docs: number;
  docsVerified: number;
  realtorId?: Types.ObjectId;
  realtorName: string;
  createdAt: Date;
}

interface ListingPage {
  rows: ListingRow[];
  total: { count: number }[];
  counts: { _id: VerificationStatus; count: number }[];
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
  docs: row.docs,
  docsVerified: row.docsVerified,
  realtorId: row.realtorId,
  realtorName: row.realtorName,
  createdAt: row.createdAt,
});

export const listListings = async (req: Request, res: Response): Promise<void> => {
  const { q, status, city, sort, page, limit } = listListingsSchema.parse(req.query);

  const pipeline: PipelineStage[] = [];

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
        // The queue's core signal: how much of the dossier is already cleared.
        docs: { $size: { $ifNull: ["$documents", []] } },
        docsVerified: {
          $size: {
            $filter: {
              input: { $ifNull: ["$documents", []] },
              cond: { $eq: ["$$this.status", "verified"] },
            },
          },
        },
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

  // Repeated in the branches that need it so the city list is not narrowed by the city
  // already chosen, which would empty the dropdown after one pick.
  const cityMatch: PipelineStage.FacetPipelineStage[] =
    city === "all" ? [] : [{ $match: { city } }];

  // The status clause lives in the branches too, and deliberately not at the head of the
  // pipeline: the counts strip is computed without it, so choosing one segment cannot
  // zero the other three. The cost is running the lookup over the wider set.
  const statusMatch: PipelineStage.FacetPipelineStage[] =
    status === "all"
      ? []
      : status === "open"
        ? [{ $match: { status: { $in: ["pending", "disputed"] } } }]
        : [{ $match: { status } }];

  const order = sort === "oldest" ? 1 : -1;

  pipeline.push({
    $facet: {
      rows: [
        ...cityMatch,
        ...statusMatch,
        { $sort: { createdAt: order, _id: order } },
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
            docs: 1,
            docsVerified: 1,
            realtorId: 1,
            realtorName: 1,
            createdAt: 1,
          },
        },
      ],
      total: [...cityMatch, ...statusMatch, { $count: "count" }],
      counts: [...cityMatch, { $group: { _id: "$status", count: { $sum: 1 } } }],
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

  const counts = { all: 0, verified: 0, pending: 0, disputed: 0 };

  for (const row of result?.counts ?? []) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  res.status(200).json({
    status: "success",
    data: {
      listings: rows.map(listingRow),
      counts,
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

/**
 * One review, applied whole: the document decisions and the listing's verdict land in a
 * single write, because a document verdict only means anything alongside the listing's.
 * A listing can only carry the badge when every document behind it does, which is what
 * stops per-document review from being decoration.
 */
export const reviewListing = async (req: Request, res: Response): Promise<void> => {
  const { id } = listingIdSchema.parse(req.params);
  const { status, note, documents }: ReviewListingInput = req.body;

  const property = await Property.findById(id);

  if (!property) throw new AppError("No listing with that id.", 404);

  for (const decision of documents) {
    const doc = property.documents.find((d) => String(d._id) === decision.id);

    if (!doc) throw new AppError("That document is not on this listing.", 422);

    doc.status = decision.status;
    // The reason answers a flag, so it goes when the flag does.
    doc.reason = decision.status === "flagged" ? decision.reason : "";
  }

  if (status === "verified") {
    if (property.documents.length === 0)
      throw new AppError("A listing cannot be verified with no documents attached.", 422);

    if (property.documents.some((doc) => doc.status !== "verified"))
      throw new AppError("Every document has to be verified before the listing can be.", 422);
  }

  property.verification.status = status;
  property.verification.note = note;

  if (!property.isModified()) throw new AppError("Nothing changed in this review.", 409);

  property.verification.reviewedAt = new Date();
  property.verification.reviewedBy = req.user!._id;

  await property.save({ validateModifiedOnly: true });

  // The realtor learns the verdict here rather than by revisiting the console. The
  // flags travel with it: the outcome alone does not tell them what to fix.
  const owner = await User.findById(property.user).select("email fullname");

  if (owner)
    sendListingReviewed(
      owner.email,
      {
        id: String(property._id),
        ref: property.ref,
        title: property.title,
        city: property.address.city,
        state: property.address.state,
        realtor: owner.fullname,
      },
      status,
      note,
      property.documents
        .filter((doc) => doc.status === "flagged")
        .map((doc) => ({ name: doc.name, reason: doc.reason })),
    );

  const message =
    status === "verified"
      ? "Listing verified. The badge is live."
      : status === "disputed"
        ? "Listing disputed and pulled from search."
        : "Listing sent back for review.";

  res.status(200).json({
    status: "success",
    message,
    data: { property: detailedProperty(property) },
  });
};

/**
 * Put a realtor on a plan.
 *
 * This is how a paid tier is granted for now: a realtor pays by transfer, an admin
 * confirms it against the bank and records the reference in the note. It is the honest
 * shape of the thing until there is a gateway, and it is what makes the whole cap
 * testable without one.
 *
 * The period is derived from the cadence rather than taken from the request, and
 * Starter carries none at all: a free plan has nothing to renew and nothing to lapse
 * from, so leaving a stale end date on it would start a grace clock that means nothing.
 */
export const setRealtorSubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = userIdSchema.parse(req.params);
  const { tier, cadence, note }: SetSubscriptionInput = req.body;

  const user = await User.findById(id);

  if (!user) throw new AppError("No user with that id.", 404);
  if (user.role !== "realtor")
    throw new AppError("That account is not a realtor.", 400);

  const subscription = await resolveSubscription(user._id);
  const period = isPaid(tier) ? periodFor(cadence) : undefined;

  subscription.tier = tier;
  subscription.cadence = cadence;
  subscription.status = "active";
  subscription.note = note ?? "";
  subscription.startedAt = subscription.startedAt ?? new Date();
  subscription.currentPeriodStart = period?.currentPeriodStart;
  subscription.currentPeriodEnd = period?.currentPeriodEnd;
  // Clearing the grace clock is the whole of reinstatement: a renewed account is
  // active from now, not part way through the window its lapse opened.
  subscription.graceEndsAt = undefined;

  await subscription.save({ validateModifiedOnly: true });

  // Both directions: an upgrade brings back everything a lapse hid, and a manual move
  // down puts the overflow away rather than leaving it public for free.
  await syncHiddenListings(user._id, subscription);

  const allowance = await listingAllowance(user._id, subscription);

  res.status(200).json({
    status: "success",
    message: `${user.fullname} is on the ${PLANS[tier].name} plan.`,
    data: {
      subscription: publicSubscription(subscription),
      plan: entitlements(subscription),
      allowance,
    },
  });
};

/* ------------------------------------------------------------------ *
 * The platform payment ledger
 * ------------------------------------------------------------------ */

interface LedgerRow {
  _id: Types.ObjectId;
  reference: string;
  tier?: Tier;
  cadence?: Cadence;
  amount: number;
  status: PaymentStatus;
  channel: string;
  cardLast4: string;
  paidAt?: Date;
  periodEnd?: Date;
  createdAt: Date;
  realtorId: Types.ObjectId;
  realtorName: string;
  realtorEmail: string;
  realtorAvatar: string;
}

interface LedgerPage {
  rows: LedgerRow[];
  total: { count: number }[];
  statuses: { _id: PaymentStatus; count: number }[];
  collected: { _id: null; total: number }[];
  thisMonth: { _id: null; total: number }[];
}

const ledgerRow = (row: LedgerRow) => ({
  id: row._id,
  reference: row.reference,
  tier: row.tier,
  cadence: row.cadence,
  amount: row.amount,
  status: row.status,
  channel: row.channel,
  cardLast4: row.cardLast4,
  paidAt: row.paidAt,
  periodEnd: row.periodEnd,
  createdAt: row.createdAt,
  realtor: {
    id: row.realtorId,
    fullname: row.realtorName,
    email: row.realtorEmail,
    avatar: row.realtorAvatar,
  },
});

/**
 * Every payment on the platform, and what they add up to.
 *
 * There is deliberately no MRR here. Nothing auto-renews, so a monthly recurring figure
 * would be a projection dressed as a measurement. What is reported instead is money that
 * actually arrived, plus how many plans are live and what those are worth a month, which
 * are three things that are true.
 *
 * The status match narrows `rows` and `total` only. The `statuses` branch counts the
 * whole set, and the two money branches carry their own fixed `paid` match, which is a
 * definition of revenue rather than a filter anyone chose.
 */
export const listPayments = async (req: Request, res: Response): Promise<void> => {
  const { q, status, page, limit } = listAdminPaymentsSchema.parse(req.query);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const statusMatch: PipelineStage.FacetPipelineStage[] =
    status === "all" ? [] : [{ $match: { status } }];

  const pipeline: PipelineStage[] = [
    { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "realtor" } },
    { $unwind: "$realtor" },
    {
      $addFields: {
        realtorId: "$realtor._id",
        realtorName: "$realtor.fullname",
        realtorEmail: "$realtor.email",
        realtorAvatar: { $ifNull: ["$realtor.avatar", ""] },
      },
    },
  ];

  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    pipeline.push({
      $match: {
        $or: [{ realtorName: pattern }, { realtorEmail: pattern }, { reference: pattern }],
      },
    });
  }

  pipeline.push({
    $facet: {
      rows: [
        ...statusMatch,
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ],
      total: [...statusMatch, { $count: "count" }],
      statuses: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
      collected: [
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ],
      thisMonth: [
        { $match: { status: "paid", paidAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ],
    },
  });

  const [result] = await Payment.aggregate<LedgerPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  const counts: Record<PaymentStatus | "all", number> = {
    all: 0,
    pending: 0,
    paid: 0,
    failed: 0,
  };

  for (const row of result?.statuses ?? []) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  // Live plans come off the subscriptions themselves, not the ledger: a plan is live
  // because its period has not run out, which no payment row knows on its own.
  //
  // Keyed on currentPeriodEnd rather than on status, and that distinction matters
  // twice. A cancelled plan still runs to the end of the period it paid for, so its
  // holder does hold a paid tier. And because the lifecycle advances lazily, a
  // subscription nobody has read since it expired still says "professional" in the
  // database: only the date is true without a read.
  const live = await Subscription.aggregate<{
    _id: Tier;
    count: number;
    ending: number;
  }>([
    { $match: { tier: { $ne: "starter" }, currentPeriodEnd: { $gt: new Date() } } },
    {
      $group: {
        _id: "$tier",
        count: { $sum: 1 },
        // Cancelled, so live now and gone at the period end.
        ending: {
          $sum: { $cond: [{ $eq: ["$status", "canceled"] }, 1, 0] },
        },
      },
    },
  ]);

  const plans = live.map((row) => ({
    tier: row._id,
    name: PLANS[row._id].name,
    count: row.count,
    ending: row.ending,
    monthly: PLANS[row._id].monthly,
  }));

  res.status(200).json({
    status: "success",
    data: {
      payments: rows.map(ledgerRow),
      counts,
      revenue: {
        collected: result?.collected[0]?.total ?? 0,
        thisMonth: result?.thisMonth[0]?.total ?? 0,
        activePlans: plans.reduce((sum, plan) => sum + plan.count, 0),
        // Of those, the ones that have been cancelled and will not come back.
        endingPlans: plans.reduce((sum, plan) => sum + plan.ending, 0),
        // What the live plans are worth a month. Not a forecast: none of them renew
        // on their own, so this says what is currently held, not what will arrive.
        monthlyValue: plans.reduce((sum, plan) => sum + plan.count * plan.monthly, 0),
        plans,
      },
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

/**
 * The admin's view of one payment, which carries more than the realtor's own.
 *
 * `flwId` and `flwRef` are here and deliberately not in `publicPayment`: they mean
 * nothing to the person who paid, and they are the only way an admin finds the same
 * transaction in Flutterwave's dashboard when a figure has to be reconciled.
 */
const adminPayment = (payment: PaymentDoc) => ({
  id: payment._id,
  reference: payment.reference,
  kind: payment.kind,
  tier: payment.tier,
  cadence: payment.cadence,
  amount: payment.amount,
  currency: payment.currency,
  status: payment.status,
  channel: payment.channel,
  cardBrand: payment.cardBrand,
  cardLast4: payment.cardLast4,
  flwId: payment.flwId,
  flwRef: payment.flwRef,
  failureReason: payment.failureReason,
  paidAt: payment.paidAt,
  periodStart: payment.periodStart,
  periodEnd: payment.periodEnd,
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
});

/**
 * One payment in full, with the account behind it and the plan it bought.
 *
 * Keyed on the reference rather than the id, because that is the string an admin has in
 * front of them: it is on the realtor's receipt and it is the `tx_ref` in Flutterwave.
 */
export const getPayment = async (req: Request, res: Response): Promise<void> => {
  const { reference } = paymentReferenceSchema.parse(req.params);

  const payment = await Payment.findOne({ reference });

  if (!payment) throw new AppError("No payment with that reference.", 404);

  const realtor = await User.findById(payment.user);

  if (!realtor) throw new AppError("That payment has no account behind it.", 404);

  // Reading it advances the lifecycle, which is the point: the admin should see where
  // the clock actually stands, not the last state someone else's read happened to leave.
  const subscription = await resolveSubscription(realtor._id);
  const allowance = await listingAllowance(realtor._id, subscription);

  // What else this realtor has paid, so a disputed figure can be read in context.
  const history = await Payment.find({ user: realtor._id })
    .sort({ createdAt: -1, _id: -1 })
    .limit(10);

  res.status(200).json({
    status: "success",
    data: {
      payment: adminPayment(payment),
      realtor: {
        id: realtor._id,
        fullname: realtor.fullname,
        email: realtor.email,
        phone: realtor.phone,
        avatar: realtor.avatar,
        status: realtor.status,
        createdAt: realtor.createdAt,
      },
      subscription: publicSubscription(subscription),
      plan: entitlements(subscription),
      allowance,
      history: history.map(adminPayment),
    },
  });
};
