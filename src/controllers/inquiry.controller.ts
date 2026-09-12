import type { Request, Response } from "express";
import { Types, type PipelineStage } from "mongoose";

import AppError from "../error/app.error.js";
import Inquiry, {
  inquiryThread,
  type InquiryDoc,
  type InquiryStatus,
} from "../models/inquiry.model.js";
import Profile from "../models/profile.model.js";
import Property, {
  listingCard,
  type ListingStatus,
  type PropertyDoc,
  type VerificationStatus,
} from "../models/property.model.js";
import User, { personCard } from "../models/user.model.js";
import {
  sendInquiryReceived,
  sendInquiryReplied,
  type InquiryBrief,
} from "../services/email.service.js";
import {
  inquiryIdSchema,
  listInquiriesSchema,
  type AddMessageInput,
  type CreateInquiryInput,
  type InquirySort,
  type InquiryStatusInput,
  type ListInquiriesQuery,
} from "../validators/inquiry.validator.js";

/** Which end of a thread someone is. Doubles as the field to match them on. */
type Side = "seeker" | "realtor";

const other = (side: Side): Side => (side === "seeker" ? "realtor" : "seeker");

const SORTS: Record<InquirySort, Record<string, 1 | -1>> = {
  // The _id tiebreaker keeps a row from slipping between pages on equal timestamps.
  newest: { lastMessageAt: -1, _id: -1 },
  oldest: { lastMessageAt: 1, _id: 1 },
};

/**
 * A thread is not a hidden account, so refusing someone else's is a 403 rather than
 * the 404 the realtor directory uses. The same distinction findOwned draws on a
 * listing, and for the same reason: nothing about it is secret, it is just not yours.
 */
const findOwn = async (
  id: string,
  side: Side,
  userId: Types.ObjectId,
): Promise<InquiryDoc> => {
  const inquiry = await Inquiry.findById(id);

  if (!inquiry) throw new AppError("No conversation with that id.", 404);
  if (!inquiry[side].equals(userId))
    throw new AppError("This conversation is not yours.", 403);

  return inquiry;
};

/**
 * The listing and the counterpart, for one thread. A thread whose listing or whose
 * counterpart account is gone answers 404, which is what the lists do too: they drop
 * it on an $unwind with no preserveNullAndEmptyArrays.
 */
const threadContext = async (inquiry: InquiryDoc, side: Side) => {
  const [property, person] = await Promise.all([
    Property.findById(inquiry.property),
    User.findById(inquiry[other(side)]),
  ]);

  if (!property || !person)
    throw new AppError("This conversation is no longer available.", 404);

  return { property, person };
};

/* ------------------------------------------------------------------ *
 * The two lists. One record with two views, so one pipeline with two ends:
 * `side` is both who is asking and the field to match them on.
 * ------------------------------------------------------------------ */

interface InquiryRow {
  _id: Types.ObjectId;
  status: InquiryStatus;
  lastMessage: string;
  lastMessageAt: Date;
  createdAt: Date;
  propertyId: Types.ObjectId;
  slug: string;
  title: string;
  image: string;
  city: string;
  fullAddress: string;
  price: number;
  listingStatus: ListingStatus;
  // Named apart from the thread's own status, which the filter matches on.
  verificationStatus: VerificationStatus;
  personId: Types.ObjectId;
  personName: string;
  personAvatar: string;
  certified: boolean;
}

interface InquiryPage {
  rows: InquiryRow[];
  total: { count: number }[];
  counts: { _id: InquiryStatus; count: number }[];
}

const rowBase = (row: InquiryRow) => ({
  id: row._id,
  status: row.status,
  lastMessage: row.lastMessage,
  lastMessageAt: row.lastMessageAt,
  createdAt: row.createdAt,
  property: {
    id: row.propertyId,
    slug: row.slug,
    title: row.title,
    image: row.image,
    city: row.city,
    fullAddress: row.fullAddress,
    price: row.price,
    listingStatus: row.listingStatus,
    status: row.verificationStatus,
  },
});

/** The seeker's view: the realtor they wrote to, carrying the seal the card renders. */
const inquiryRow = (row: InquiryRow) => ({
  ...rowBase(row),
  realtor: {
    id: row.personId,
    fullname: row.personName,
    avatar: row.personAvatar,
    certified: row.certified,
  },
});

/** The realtor's view: the buyer. No email and no phone; the thread is the channel. */
const leadRow = (row: InquiryRow) => ({
  ...rowBase(row),
  seeker: {
    id: row.personId,
    fullname: row.personName,
    avatar: row.personAvatar,
  },
});

const loadInquiries = async (
  side: Side,
  userId: Types.ObjectId,
  query: ListInquiriesQuery,
) => {
  const { status, sort, page, limit } = query;

  const pipeline: PipelineStage[] = [
    { $match: { [side]: userId } },
    {
      $lookup: {
        from: "properties",
        localField: "property",
        foreignField: "_id",
        as: "listing",
      },
    },
    // No preserve on either: a thread about a listing that was deleted, or with an
    // account that is gone, drops out rather than rendering half a row.
    { $unwind: "$listing" },
    {
      $lookup: {
        from: "users",
        localField: other(side),
        foreignField: "_id",
        as: "person",
      },
    },
    { $unwind: "$person" },
  ];

  // The seal is the seeker's view only: a buyer has no certification to show.
  if (side === "seeker")
    pipeline.push(
      {
        $lookup: {
          from: "profiles",
          localField: "realtor",
          foreignField: "user",
          as: "profile",
        },
      },
      // Profiles are created lazily, so an older realtor may not own one yet.
      { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
    );

  pipeline.push({
    $addFields: {
      lastMessage: { $ifNull: [{ $last: "$messages.body" }, ""] },
      propertyId: "$listing._id",
      slug: "$listing.slug",
      title: "$listing.title",
      image: { $ifNull: [{ $first: "$listing.images.url" }, ""] },
      city: { $ifNull: ["$listing.address.city", ""] },
      fullAddress: { $ifNull: ["$listing.address.fullAddress", ""] },
      price: { $ifNull: ["$listing.price", 0] },
      listingStatus: "$listing.listingStatus",
      verificationStatus: "$listing.verification.status",
      personId: "$person._id",
      personName: { $ifNull: ["$person.fullname", ""] },
      personAvatar: { $ifNull: ["$person.avatar", ""] },
      certified: { $ifNull: ["$profile.certified", false] },
    },
  });

  // In the branches that page, and deliberately not in counts: choosing one segment
  // cannot be allowed to zero the other three.
  const statusMatch: PipelineStage.FacetPipelineStage[] =
    status === "all" ? [] : [{ $match: { status } }];

  pipeline.push({
    $facet: {
      rows: [
        ...statusMatch,
        { $sort: SORTS[sort] },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            status: 1,
            lastMessage: 1,
            lastMessageAt: 1,
            createdAt: 1,
            propertyId: 1,
            slug: 1,
            title: 1,
            image: 1,
            city: 1,
            fullAddress: 1,
            price: 1,
            listingStatus: 1,
            verificationStatus: 1,
            personId: 1,
            personName: 1,
            personAvatar: 1,
            certified: 1,
          },
        },
      ],
      total: [...statusMatch, { $count: "count" }],
      counts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
    },
  });

  const [result] = await Inquiry.aggregate<InquiryPage>(pipeline);

  const total = result?.total[0]?.count ?? 0;
  const counts = { all: 0, new: 0, responded: 0, closed: 0 };

  for (const row of result?.counts ?? []) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  return {
    rows: result?.rows ?? [],
    counts,
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
};

/** What the notification says. The listing is read for it either way. */
const brief = (
  inquiry: InquiryDoc,
  property: Pick<PropertyDoc, "ref" | "title">,
  person: string,
  message: string,
): InquiryBrief => ({
  id: String(inquiry._id),
  ref: property.ref,
  property: property.title,
  person,
  message,
});

/* ------------------------------------------------------------------ *
 * The seeker's side.
 * ------------------------------------------------------------------ */

export const createInquiry = async (req: Request, res: Response): Promise<void> => {
  const { property: propertyId, message }: CreateInquiryInput = req.body;
  const seeker = req.user!;

  const property = await Property.findById(propertyId);

  if (!property) throw new AppError("No listing with that id.", 404);

  const owner = await User.findById(property.user);

  // The gate the marketplace applies, and the same 404: a suspended realtor's listings
  // are off the public site, so they cannot be written to either. Verification status
  // is deliberately not a gate; a pending listing is public and can be asked about.
  if (!owner || owner.status !== "active")
    throw new AppError("No listing with that id.", 404);

  // One thread per listing and seeker, so asking twice continues the conversation
  // instead of forking a duplicate the two sides then read separately.
  const existing = await Inquiry.findOne({
    property: property._id,
    seeker: seeker._id,
  });

  const inquiry =
    existing ??
    new Inquiry({
      property: property._id,
      realtor: property.user,
      seeker: seeker._id,
    });

  // One timestamp for both, so lastMessageAt is exactly the last message's time.
  const now = new Date();

  inquiry.messages.push({ sender: seeker._id, body: message, createdAt: now });
  inquiry.lastMessageAt = now;
  // Back on the realtor, whatever it was before: a follow-up needs an answer, and a
  // closed thread reopens when the buyer writes again.
  inquiry.status = "new";

  await inquiry.save();

  // The realtor is not sitting in their console, and a lead nobody reads is a lead lost.
  sendInquiryReceived(
    owner.email,
    brief(inquiry, property, seeker.fullname, message),
    !existing,
  );

  res.status(existing ? 200 : 201).json({
    status: "success",
    message: existing ? "Message sent." : "Your inquiry is with the realtor.",
    data: { inquiry: inquiryThread(inquiry) },
  });
};

export const listMyInquiries = async (req: Request, res: Response): Promise<void> => {
  const query = listInquiriesSchema.parse(req.query);

  const { rows, ...page } = await loadInquiries("seeker", req.user!._id, query);

  res.status(200).json({
    status: "success",
    data: { inquiries: rows.map(inquiryRow), ...page },
  });
};

export const getMyInquiry = async (req: Request, res: Response): Promise<void> => {
  const { id } = inquiryIdSchema.parse(req.params);

  const inquiry = await findOwn(id, "seeker", req.user!._id);
  const { property, person } = await threadContext(inquiry, "seeker");
  const profile = await Profile.findOne({ user: person._id });

  res.status(200).json({
    status: "success",
    data: {
      inquiry: inquiryThread(inquiry),
      property: listingCard(property),
      // The business fields the aside renders, mirroring the marketplace's realtor
      // block. Still no email, phone or personal address.
      realtor: {
        ...personCard(person),
        agencyName: profile?.agencyName ?? "",
        city: profile?.city ?? "",
        certified: profile?.certified ?? false,
      },
    },
  });
};

/* ------------------------------------------------------------------ *
 * The realtor's side. The same records, labelled leads in their console.
 * ------------------------------------------------------------------ */

export const listLeads = async (req: Request, res: Response): Promise<void> => {
  const query = listInquiriesSchema.parse(req.query);

  const { rows, ...page } = await loadInquiries("realtor", req.user!._id, query);

  res.status(200).json({
    status: "success",
    data: { leads: rows.map(leadRow), ...page },
  });
};

export const getLead = async (req: Request, res: Response): Promise<void> => {
  const { id } = inquiryIdSchema.parse(req.params);

  const inquiry = await findOwn(id, "realtor", req.user!._id);
  const { property, person } = await threadContext(inquiry, "realtor");

  res.status(200).json({
    status: "success",
    data: {
      inquiry: inquiryThread(inquiry),
      property: listingCard(property),
      seeker: personCard(person),
    },
  });
};

export const updateLeadStatus = async (req: Request, res: Response): Promise<void> => {
  const { id } = inquiryIdSchema.parse(req.params);
  const { status }: InquiryStatusInput = req.body;

  const inquiry = await findOwn(id, "realtor", req.user!._id);

  // "open" is a sentinel, not a stored value: reopening restores whose turn it was,
  // which the last message's author already says, so nothing has to remember it.
  const last = inquiry.messages[inquiry.messages.length - 1];
  const reopened: InquiryStatus =
    last && inquiry.seeker.equals(last.sender) ? "new" : "responded";

  const next: InquiryStatus = status === "closed" ? "closed" : reopened;

  if (inquiry.status === next)
    throw new AppError(
      status === "closed"
        ? "This conversation is already closed."
        : "This conversation is already open.",
      409,
    );

  inquiry.status = next;
  await inquiry.save({ validateModifiedOnly: true });

  res.status(200).json({
    status: "success",
    message: next === "closed" ? "Conversation closed." : "Conversation reopened.",
    data: { inquiry: inquiryThread(inquiry) },
  });
};

/* ------------------------------------------------------------------ *
 * Both sides. A reply is the same write whoever sends it, which is the point of
 * one record: the only difference is whose turn it leaves the thread on.
 * ------------------------------------------------------------------ */

export const addInquiryMessage = async (req: Request, res: Response): Promise<void> => {
  const { id } = inquiryIdSchema.parse(req.params);
  const { message }: AddMessageInput = req.body;
  const user = req.user!;

  const inquiry = await Inquiry.findById(id);

  if (!inquiry) throw new AppError("No conversation with that id.", 404);

  const fromSeeker = inquiry.seeker.equals(user._id);

  if (!fromSeeker && !inquiry.realtor.equals(user._id))
    throw new AppError("This conversation is not yours.", 403);

  const now = new Date();

  inquiry.messages.push({ sender: user._id, body: message, createdAt: now });
  inquiry.lastMessageAt = now;
  // Read off the thread rather than the role: the record says which end they are.
  // The cap on the array is the model's job, and its message is already a sentence.
  inquiry.status = fromSeeker ? "new" : "responded";

  await inquiry.save();

  // Read for the notification alone, which is why both are narrowed to the fields it
  // uses. Whoever did not write the message is the one who needs telling.
  const [counterpart, property] = await Promise.all([
    User.findById(fromSeeker ? inquiry.realtor : inquiry.seeker).select("email"),
    Property.findById(inquiry.property).select("ref title"),
  ]);

  if (counterpart && property) {
    const note = brief(inquiry, property, user.fullname, message);

    if (fromSeeker) sendInquiryReceived(counterpart.email, note, false);
    else sendInquiryReplied(counterpart.email, note);
  }

  res.status(201).json({
    status: "success",
    message: "Message sent.",
    data: { inquiry: inquiryThread(inquiry) },
  });
};
